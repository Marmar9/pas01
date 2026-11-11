import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  type LoyaltyOperationRow,
  type LoyaltyOperationType,
  loyaltyOperations,
  payments,
  reservations,
} from "@/db/schema";
import { enqueueJob, type JobHandler } from "./jobs";

// 1 point = 1 grosz; at most half of the ticket may be paid with points.
export function maxPointsForAmount(amount: number): number {
  return Math.floor(amount / 2);
}

// 10 points per full złoty paid by card.
export function pointsEarnedFor(cardAmount: number): number {
  return Math.floor(cardAmount / 100) * 10;
}

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

/**
 * insufficient_points / not_applied: Voucherify definitely did not apply the
 * change. uncertain: the request may have been applied (timeout, network,
 * 5xx) and must be reconciled by its sourceId before it is retried.
 */
export type LoyaltyErrorKind =
  | "insufficient_points"
  | "not_applied"
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

export type LoyaltyGateway = {
  getBalance(email: string): Promise<number>;
  // points is signed: positive adds, negative subtracts.
  adjustBalance(input: {
    email: string;
    points: number;
    sourceId: string;
  }): Promise<void>;
  hasTransaction(input: { email: string; sourceId: string }): Promise<boolean>;
};

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

export async function getLoyaltyBalance(
  gateway: LoyaltyGateway,
  rawEmail: string,
  now: () => number = Date.now,
): Promise<number> {
  const email = normalizeEmail(rawEmail);
  const state = loyaltyState();
  const cached = state.balances.get(email);

  if (cached && cached.expiresAt > now()) {
    return cached.points;
  }

  const inflight = state.reads.get(email);

  if (inflight) {
    return inflight;
  }

  const read = gateway
    .getBalance(email)
    .then((points) => {
      state.balances.set(email, {
        points,
        expiresAt: now() + BALANCE_CACHE_TTL_MS,
      });
      return points;
    })
    .finally(() => {
      state.reads.delete(email);
    });

  state.reads.set(email, read);

  return read;
}

/**
 * Voucherify applies balance changes asynchronously, so mutations for one
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
  reservationId: string;
  paymentId: string | null;
  // Always positive; the sign is derived from the type.
  points: number;
  email: string;
};

export type ApplyLoyaltyOperationResult =
  | { status: "done"; operation: LoyaltyOperationRow }
  | {
      status: "failed";
      kind: "insufficient_points" | "not_applied";
      operation: LoyaltyOperationRow;
    }
  | { status: "uncertain"; operation: LoyaltyOperationRow };

function setOperationStatus(
  db: Db,
  id: string,
  status: LoyaltyOperationRow["status"],
): LoyaltyOperationRow {
  const updated = db
    .update(loyaltyOperations)
    .set({ status, updatedAt: new Date() })
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

/**
 * Applies one Voucherify mutation at most once. The operation row is written
 * before the call, so a crash leaves a "pending" row that the next attempt
 * reconciles by sourceId instead of applying the change a second time.
 *
 * reconcileNow: a synchronous caller (checkout) must decide immediately, so an
 * uncertain response is reconciled right away. Background jobs leave it
 * pending and reconcile on their next attempt, giving Voucherify time to apply
 * the change. retryFailed: jobs may retry an operation that definitely was not
 * applied; a failed spend ends its checkout attempt for good.
 */
export async function applyLoyaltyOperation(
  db: Db,
  gateway: LoyaltyGateway,
  input: LoyaltyOperationInput,
  options: { reconcileNow?: boolean; retryFailed?: boolean } = {},
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
    let operation =
      inserted ??
      db
        .select()
        .from(loyaltyOperations)
        .where(eq(loyaltyOperations.id, input.id))
        .get();

    if (!operation) {
      throw new Error(`Loyalty operation ${input.id} could not be recorded.`);
    }

    if (operation.status === "done") {
      return { status: "done", operation };
    }

    if (operation.status === "failed") {
      if (!options.retryFailed) {
        return { status: "failed", kind: "not_applied", operation };
      }

      operation = setOperationStatus(db, operation.id, "pending");
    } else if (!inserted) {
      // A previous attempt may have reached Voucherify: reconcile first.
      try {
        if (
          await gateway.hasTransaction({
            email: input.email,
            sourceId: operation.id,
          })
        ) {
          invalidateLoyaltyBalance(input.email);
          return {
            status: "done",
            operation: setOperationStatus(db, operation.id, "done"),
          };
        }
      } catch {
        return { status: "uncertain", operation };
      }
    }

    const signedPoints =
      operation.type === "spend" ? -operation.points : operation.points;

    try {
      await gateway.adjustBalance({
        email: input.email,
        points: signedPoints,
        sourceId: operation.id,
      });
      invalidateLoyaltyBalance(input.email);

      return {
        status: "done",
        operation: setOperationStatus(db, operation.id, "done"),
      };
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
        const applied = await gateway.hasTransaction({
          email: input.email,
          sourceId: operation.id,
        });

        return applied
          ? {
              status: "done",
              operation: setOperationStatus(db, operation.id, "done"),
            }
          : {
              status: "failed",
              kind: "not_applied",
              operation: setOperationStatus(db, operation.id, "failed"),
            };
      } catch {
        return { status: "uncertain", operation };
      }
    }
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

function reservationEmail(db: Db, reservationId: string): string {
  const reservation = db
    .select({ email: reservations.email })
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .get();

  if (!reservation) {
    throw new Error(`Reservation ${reservationId} not found.`);
  }

  return reservation.email;
}

function describeFailure(result: ApplyLoyaltyOperationResult): string {
  return result.status === "failed"
    ? `Voucherify rejected loyalty operation ${result.operation.id} (${result.kind}).`
    : `Loyalty operation ${result.operation.id} is not confirmed yet.`;
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

    const gateway = getGateway();

    if (!gateway) {
      throw new Error("Voucherify is not configured.");
    }

    const email = reservationEmail(db, spend.reservationId);

    if (spend.status === "pending") {
      // The debit outcome is unknown: settle it by its sourceId first.
      const applied = await withMemberLock(email, () =>
        gateway.hasTransaction({ email, sourceId: spend.id }),
      );

      setOperationStatus(db, spend.id, applied ? "done" : "failed");

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
      throw new Error(describeFailure(result));
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

    const gateway = getGateway();

    if (!gateway) {
      throw new Error("Voucherify is not configured.");
    }

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
      throw new Error(describeFailure(result));
    }
  };
}
