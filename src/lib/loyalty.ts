import { createHash } from "node:crypto";
import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  jobs,
  type LoyaltyOperationRow,
  type LoyaltyOperationType,
  loyaltyOperations,
  payments,
  reservations,
} from "@/db/schema";
import { enqueueJob, type JobHandler, PermanentJobError } from "./jobs";

// 1 point = 1 grosz; at most half of the ticket may be paid with points.
export function maxPointsForAmount(amount: number): number {
  return Math.floor(amount / 2);
}

// 10 points per full złoty paid by card.
export function pointsEarnedFor(cardAmount: number): number {
  return Math.floor(cardAmount / 100) * 10;
}

// Loyalty v2 cards have no starting balance, so the app credits it once.
export const WELCOME_POINTS = 1000;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const SPEND_PREFIX = "loyalty:spend:";

export function spendSourceId(stripeCheckoutSessionId: string): string {
  return `${SPEND_PREFIX}${stripeCheckoutSessionId}`;
}

export function sessionIdFromSpendSourceId(sourceId: string): string {
  return sourceId.slice(SPEND_PREFIX.length);
}

export function earnSourceId(reservationId: string): string {
  return `loyalty:earn:${reservationId}`;
}

export function restoreSourceId(stripeCheckoutSessionId: string): string {
  return `loyalty:restore:${stripeCheckoutSessionId}`;
}

// The sourceId travels as the transaction reason (max 255 chars), so the
// email is hashed to keep it short and out of Voucherify's free-text field.
function emailKey(email: string): string {
  return createHash("sha256")
    .update(normalizeEmail(email))
    .digest("hex")
    .slice(0, 32);
}

export function welcomeSourceId(email: string): string {
  return `loyalty:welcome:${emailKey(email)}`;
}

export function welcomePointsJobId(email: string): string {
  return `welcome-points:${emailKey(email)}`;
}

/**
 * insufficient_points / not_applied / rejected: Voucherify definitely did not
 * apply the change. not_applied is transient (429, member lookup failure) and
 * may be retried; rejected (other 4xx, or a REJECTED transaction) is
 * permanent. uncertain: the request may have been applied (timeout, network,
 * 5xx) and must be reconciled before it is retried.
 */
export type LoyaltyErrorKind =
  | "insufficient_points"
  | "not_applied"
  | "rejected"
  | "uncertain";

export class LoyaltyError extends Error {
  constructor(
    readonly kind: LoyaltyErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LoyaltyError";
  }
}

// Loyalty v2 accepts every balance change as PENDING and settles it later as
// APPROVED or REJECTED; only APPROVED means the points moved.
export type LoyaltyTransactionStatus = "pending" | "approved" | "rejected";

export type LoyaltyTransaction = {
  id: string;
  status: LoyaltyTransactionStatus;
  // Set on a REJECTED debit that failed for lack of points.
  insufficientPoints: boolean;
};

export type LoyaltyGateway = {
  // Finds the member for the email or enrolls it.
  getBalance(email: string): Promise<number>;
  // points is signed: positive adds, negative subtracts. sourceId is sent as
  // the transaction reason; Voucherify does not deduplicate it.
  adjustBalance(input: {
    email: string;
    points: number;
    sourceId: string;
  }): Promise<LoyaltyTransaction>;
  // By transaction id when known, else the newest non-rejected transaction
  // whose reason is the sourceId. null: not among the card's recent
  // transactions.
  findTransaction(input: {
    email: string;
    sourceId: string;
    transactionId: string | null;
  }): Promise<LoyaltyTransaction | null>;
};

// A lost response leaves no transaction id. A transaction missing from the
// card right after an uncertain call is not proof that the change was
// dropped, so only an operation untouched for this long may be declared not
// applied (and then re-sent or abandoned).
export const LOYALTY_SETTLE_MS = 60_000;

// How long a synchronous caller waits for PENDING to become APPROVED or
// REJECTED: one lookup after each delay (about 3 s and 3 API calls).
export const APPROVAL_POLL_DELAYS_MS: readonly number[] = [500, 1000, 1500];

function isSettled(operation: LoyaltyOperationRow, now = Date.now()): boolean {
  return now - operation.updatedAt.getTime() >= LOYALTY_SETTLE_MS;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The Voucherify Sandbox allows 100 calls/hour, so balances are cached and
// concurrent reads for one member share a single request.
export const BALANCE_CACHE_TTL_MS = 30_000;

type LoyaltyState = {
  balances: Map<string, { points: number; expiresAt: number }>;
  reads: Map<string, Promise<number>>;
  locks: Map<string, Promise<void>>;
};

const globalForLoyalty = globalThis as typeof globalThis & {
  cinemaLoyalty?: LoyaltyState;
};

function loyaltyState(): LoyaltyState {
  globalForLoyalty.cinemaLoyalty ??= {
    balances: new Map(),
    reads: new Map(),
    locks: new Map(),
  };
  return globalForLoyalty.cinemaLoyalty;
}

export function resetLoyaltyState(): void {
  delete globalForLoyalty.cinemaLoyalty;
}

export function invalidateLoyaltyBalance(email: string): void {
  loyaltyState().balances.delete(normalizeEmail(email));
}

function findOperation(db: Db, id: string): LoyaltyOperationRow | undefined {
  return db
    .select()
    .from(loyaltyOperations)
    .where(eq(loyaltyOperations.id, id))
    .get();
}

function welcomeOperation(email: string): LoyaltyOperationInput {
  return {
    id: welcomeSourceId(email),
    type: "welcome",
    reservationId: null,
    paymentId: null,
    points: WELCOME_POINTS,
    email,
  };
}

/**
 * Called by the gateway right before it enrolls a new member, so the welcome
 * credit is queued (outbox) even if the enrollment response is lost. The
 * operation row itself is written by applyLoyaltyOperation right before the
 * credit is sent, like every other mutation.
 */
export function recordWelcomePoints(
  db: Db,
  rawEmail: string,
  now = new Date(),
): void {
  const email = normalizeEmail(rawEmail);

  enqueueJob(
    db,
    {
      id: welcomePointsJobId(email),
      task: "credit-welcome-points",
      input: { email },
    },
    now,
  );
}

// The welcome credit is owed but not in flight: its job was queued (even if
// it was dead-lettered because enrollment failed back then) and the credit
// was never sent or definitely failed. A "pending" operation is left to the
// job, which settles it without sending it twice.
function welcomeCreditOwed(db: Db, email: string): boolean {
  const job = db
    .select({ completedAt: jobs.completedAt })
    .from(jobs)
    .where(eq(jobs.id, welcomePointsJobId(email)))
    .get();
  const operation = findOperation(db, welcomeSourceId(email));

  return (
    Boolean(job) &&
    !job?.completedAt &&
    (!operation || operation.status === "failed")
  );
}

function ackWelcomeJob(db: Db, email: string): void {
  db.update(jobs)
    .set({ completedAt: new Date(), hasError: false })
    .where(eq(jobs.id, welcomePointsJobId(email)))
    .run();
}

export async function getLoyaltyBalance(
  db: Db,
  gateway: LoyaltyGateway,
  rawEmail: string,
  options: {
    now?: () => number;
    approvalDelaysMs?: readonly number[];
  } = {},
): Promise<number> {
  const email = normalizeEmail(rawEmail);
  const now = options.now ?? Date.now;
  const state = loyaltyState();
  const cached = state.balances.get(email);

  if (cached && cached.expiresAt > now()) {
    return cached.points;
  }

  const inflight = state.reads.get(email);

  if (inflight) {
    return inflight;
  }

  const read = (async () => {
    let points = await gateway.getBalance(email);

    // Fast path once the member exists: credit owed welcome points now so the
    // customer sees them. If that is not confirmed in time, the
    // "credit-welcome-points" job finishes it.
    if (welcomeCreditOwed(db, email)) {
      const result = await applyLoyaltyOperation(
        db,
        gateway,
        welcomeOperation(email),
        {
          retryFailed: true,
          approvalDelaysMs: options.approvalDelaysMs ?? APPROVAL_POLL_DELAYS_MS,
        },
      );

      if (result.status === "done") {
        ackWelcomeJob(db, email);
        points = await gateway.getBalance(email);
      }
    }

    state.balances.set(email, {
      points,
      expiresAt: now() + BALANCE_CACHE_TTL_MS,
    });

    return points;
  })().finally(() => {
    state.reads.delete(email);
  });

  state.reads.set(email, read);

  return read;
}

/**
 * Voucherify processes balance changes asynchronously, so mutations for one
 * member run one at a time. The lock is per process; the app runs the API and
 * the job worker in the same Next.js server process.
 */
export async function withMemberLock<T>(
  rawEmail: string,
  fn: () => Promise<T>,
): Promise<T> {
  const email = normalizeEmail(rawEmail);
  const { locks } = loyaltyState();
  const previous = locks.get(email) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);

  locks.set(email, tail);
  await previous;

  try {
    return await fn();
  } finally {
    release();

    if (locks.get(email) === tail) {
      locks.delete(email);
    }
  }
}

export type LoyaltyOperationInput = {
  id: string;
  type: LoyaltyOperationType;
  reservationId: string | null;
  paymentId: string | null;
  // Always positive; the sign is derived from the type.
  points: number;
  email: string;
};

export type ApplyLoyaltyOperationResult =
  | { status: "done"; operation: LoyaltyOperationRow }
  | {
      status: "failed";
      kind: "insufficient_points" | "not_applied" | "rejected";
      operation: LoyaltyOperationRow;
    }
  | { status: "uncertain"; operation: LoyaltyOperationRow };

function setOperationStatus(
  db: Db,
  id: string,
  status: LoyaltyOperationRow["status"],
  voucherifyTransactionId?: string | null,
): LoyaltyOperationRow {
  const updated = db
    .update(loyaltyOperations)
    .set({
      status,
      updatedAt: new Date(),
      ...(voucherifyTransactionId === undefined
        ? {}
        : { voucherifyTransactionId }),
    })
    .where(eq(loyaltyOperations.id, id))
    .returning()
    .get();

  if (!updated) {
    throw new Error(`Loyalty operation ${id} disappeared.`);
  }

  return updated;
}

function recordTransactionId(
  db: Db,
  id: string,
  voucherifyTransactionId: string,
): LoyaltyOperationRow {
  const updated = db
    .update(loyaltyOperations)
    .set({ voucherifyTransactionId })
    .where(eq(loyaltyOperations.id, id))
    .returning()
    .get();

  if (!updated) {
    throw new Error(`Loyalty operation ${id} disappeared.`);
  }

  return updated;
}

function errorKind(error: unknown): LoyaltyErrorKind {
  return error instanceof LoyaltyError ? error.kind : "uncertain";
}

function settleOperation(
  db: Db,
  email: string,
  operation: LoyaltyOperationRow,
  transaction: LoyaltyTransaction,
): ApplyLoyaltyOperationResult {
  if (transaction.status === "pending") {
    return { status: "uncertain", operation };
  }

  invalidateLoyaltyBalance(email);

  if (transaction.status === "approved") {
    return {
      status: "done",
      operation: setOperationStatus(db, operation.id, "done"),
    };
  }

  return {
    status: "failed",
    kind: transaction.insufficientPoints ? "insufficient_points" : "rejected",
    operation: setOperationStatus(db, operation.id, "failed"),
  };
}

/**
 * Applies one Voucherify mutation at most once. Voucherify has no idempotency
 * key, so the operation row is written before the call and the accepted
 * transaction id is stored on it; a retry looks that transaction up instead
 * of sending the change again. The row is "done" only once Voucherify
 * APPROVED the transaction and "failed" once it REJECTED it.
 *
 * reconcileNow: a synchronous caller (checkout) must decide immediately, so a
 * lost response is looked up right away. approvalDelaysMs: a synchronous
 * caller waits this long for PENDING to settle; background jobs pass none and
 * settle it on their next attempt. retryFailed: jobs may re-send an operation
 * that definitely was not applied; a failed spend ends its checkout attempt
 * for good.
 */
export async function applyLoyaltyOperation(
  db: Db,
  gateway: LoyaltyGateway,
  input: LoyaltyOperationInput,
  options: {
    reconcileNow?: boolean;
    retryFailed?: boolean;
    approvalDelaysMs?: readonly number[];
  } = {},
): Promise<ApplyLoyaltyOperationResult> {
  return withMemberLock(input.email, async () => {
    const now = new Date();
    const inserted = db
      .insert(loyaltyOperations)
      .values({
        id: input.id,
        type: input.type,
        reservationId: input.reservationId,
        paymentId: input.paymentId,
        points: input.points,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning()
      .get();
    let operation = inserted ?? findOperation(db, input.id);

    if (!operation) {
      throw new Error(`Loyalty operation ${input.id} could not be recorded.`);
    }

    if (operation.status === "done") {
      return { status: "done", operation };
    }

    let transaction: LoyaltyTransaction | null = null;

    if (operation.status === "failed") {
      if (!options.retryFailed) {
        return { status: "failed", kind: "not_applied", operation };
      }

      operation = setOperationStatus(db, operation.id, "pending", null);
    } else if (!inserted) {
      // A previous attempt may have reached Voucherify: look it up first.
      try {
        transaction = await gateway.findTransaction({
          email: input.email,
          sourceId: operation.id,
          transactionId: operation.voucherifyTransactionId,
        });
      } catch {
        return { status: "uncertain", operation };
      }

      if (transaction) {
        operation = recordTransactionId(db, operation.id, transaction.id);
      } else if (operation.voucherifyTransactionId || !isSettled(operation)) {
        // Re-sending before the earlier call could have shown up risks
        // applying it twice.
        return { status: "uncertain", operation };
      }
    }

    if (!transaction) {
      const signedPoints =
        operation.type === "spend" ? -operation.points : operation.points;

      try {
        transaction = await gateway.adjustBalance({
          email: input.email,
          points: signedPoints,
          sourceId: operation.id,
        });
        operation = recordTransactionId(db, operation.id, transaction.id);
      } catch (error) {
        const kind = errorKind(error);

        if (kind !== "uncertain") {
          return {
            status: "failed",
            kind,
            operation: setOperationStatus(db, operation.id, "failed"),
          };
        }

        invalidateLoyaltyBalance(input.email);

        if (!options.reconcileNow) {
          return { status: "uncertain", operation };
        }

        // A timeout is not proof of failure.
        try {
          transaction = await gateway.findTransaction({
            email: input.email,
            sourceId: operation.id,
            transactionId: null,
          });
        } catch {
          return { status: "uncertain", operation };
        }

        if (!transaction) {
          // Not visible yet is not proof of failure either: leave it pending
          // so the restore job settles it.
          return { status: "uncertain", operation };
        }

        operation = recordTransactionId(db, operation.id, transaction.id);
      }
    }

    for (const delay of options.approvalDelaysMs ?? []) {
      if (transaction.status !== "pending") {
        break;
      }

      await sleep(delay);

      try {
        transaction =
          (await gateway.findTransaction({
            email: input.email,
            sourceId: operation.id,
            transactionId: transaction.id,
          })) ?? transaction;
      } catch {
        break;
      }
    }

    return settleOperation(db, input.email, operation, transaction);
  });
}

export function restorePointsJobId(paymentId: string): string {
  return `restore-points:${paymentId}`;
}

export function creditPointsJobId(reservationId: string): string {
  return `credit-points:${reservationId}`;
}

export function enqueueRestorePoints(
  tx: Db,
  paymentId: string,
  now = new Date(),
): void {
  enqueueJob(
    tx,
    {
      id: restorePointsJobId(paymentId),
      task: "restore-points",
      input: { paymentId },
    },
    now,
  );
}

export function enqueueCreditPoints(
  tx: Db,
  reservationId: string,
  now = new Date(),
): void {
  enqueueJob(
    tx,
    {
      id: creditPointsJobId(reservationId),
      task: "credit-points",
      input: { reservationId },
    },
    now,
  );
}

/**
 * A payment attempt with debited points ended without a ticket (session
 * expired/failed, hold expired, late or double payment): restore its points
 * and unlock the split on a reservation that is not paid, unless a newer open
 * attempt holds the lock.
 */
export function releasePaymentPoints(
  tx: Db,
  payment: { id: string; reservationId: string; pointsUsed: number },
  now = new Date(),
): void {
  if (payment.pointsUsed <= 0) {
    return;
  }

  enqueueRestorePoints(tx, payment.id, now);

  const otherPending = tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.reservationId, payment.reservationId),
        eq(payments.status, "pending"),
        ne(payments.id, payment.id),
      ),
    )
    .get();

  if (otherPending) {
    return;
  }

  tx.update(reservations)
    .set({ pointsUsed: 0 })
    .where(
      and(
        eq(reservations.id, payment.reservationId),
        ne(reservations.status, "paid"),
      ),
    )
    .run();
}

function reservationEmail(db: Db, reservationId: string | null): string {
  const reservation = reservationId
    ? db
        .select({ email: reservations.email })
        .from(reservations)
        .where(eq(reservations.id, reservationId))
        .get()
    : undefined;

  if (!reservation) {
    throw new Error(`Reservation ${reservationId} not found.`);
  }

  return reservation.email;
}

// A refusal that no retry can fix is dead-lettered at once for human review;
// transient failures and unconfirmed operations are retried with backoff.
function failureError(result: ApplyLoyaltyOperationResult): Error {
  if (result.status !== "failed") {
    return new Error(
      `Loyalty operation ${result.operation.id} is not confirmed yet.`,
    );
  }

  const message = `Voucherify rejected loyalty operation ${result.operation.id} (${result.kind}).`;

  return result.kind === "not_applied"
    ? new Error(message)
    : new PermanentJobError(message);
}

function requireGateway(
  getGateway: () => LoyaltyGateway | null,
): LoyaltyGateway {
  const gateway = getGateway();

  if (!gateway) {
    throw new Error("Voucherify is not configured.");
  }

  return gateway;
}

export function createRestorePointsHandler(
  db: Db,
  getGateway: () => LoyaltyGateway | null,
): JobHandler {
  return async (job) => {
    const paymentId = job.input.paymentId;
    const spend = db
      .select()
      .from(loyaltyOperations)
      .where(
        and(
          eq(loyaltyOperations.paymentId, paymentId),
          eq(loyaltyOperations.type, "spend"),
        ),
      )
      .get();

    // The debit never happened, so there is nothing to give back.
    if (!spend || spend.status === "failed") {
      return;
    }

    const gateway = requireGateway(getGateway);
    const email = reservationEmail(db, spend.reservationId);

    if (spend.status === "pending") {
      // The debit outcome is unknown: settle it without sending it again.
      const transaction = await withMemberLock(email, () =>
        gateway.findTransaction({
          email,
          sourceId: spend.id,
          transactionId: spend.voucherifyTransactionId,
        }),
      );

      if (transaction?.status === "pending") {
        throw new Error(`Loyalty operation ${spend.id} is still pending.`);
      }

      if (!transaction && !isSettled(spend)) {
        throw new Error(
          `Loyalty operation ${spend.id} has not settled in Voucherify yet.`,
        );
      }

      const applied = transaction?.status === "approved";

      setOperationStatus(
        db,
        spend.id,
        applied ? "done" : "failed",
        transaction?.id,
      );

      if (!applied) {
        return;
      }
    }

    const result = await applyLoyaltyOperation(
      db,
      gateway,
      {
        id: restoreSourceId(sessionIdFromSpendSourceId(spend.id)),
        type: "restore",
        reservationId: spend.reservationId,
        paymentId,
        points: spend.points,
        email,
      },
      { retryFailed: true },
    );

    if (result.status !== "done") {
      throw failureError(result);
    }
  };
}

export function createCreditPointsHandler(
  db: Db,
  getGateway: () => LoyaltyGateway | null,
): JobHandler {
  return async (job) => {
    const reservationId = job.input.reservationId;
    const reservation = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, reservationId))
      .get();

    if (!reservation) {
      throw new Error(`Reservation ${reservationId} not found.`);
    }

    if (reservation.status !== "paid" || !reservation.pointsEarned) {
      return;
    }

    const gateway = requireGateway(getGateway);
    const paidPayment = db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.reservationId, reservationId),
          eq(payments.status, "paid"),
        ),
      )
      .orderBy(asc(payments.createdAt))
      .get();

    const result = await applyLoyaltyOperation(
      db,
      gateway,
      {
        id: earnSourceId(reservationId),
        type: "earn",
        reservationId,
        paymentId: paidPayment?.id ?? null,
        points: reservation.pointsEarned,
        email: reservation.email,
      },
      { retryFailed: true },
    );

    if (result.status !== "done") {
      throw failureError(result);
    }
  };
}

export function createWelcomePointsHandler(
  db: Db,
  getGateway: () => LoyaltyGateway | null,
): JobHandler {
  return async (job) => {
    const gateway = requireGateway(getGateway);
    const result = await applyLoyaltyOperation(
      db,
      gateway,
      welcomeOperation(job.input.email),
      { retryFailed: true },
    );

    if (result.status !== "done") {
      throw failureError(result);
    }
  };
}
