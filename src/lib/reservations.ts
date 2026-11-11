import { and, desc, eq, gt, lt, lte, ne } from "drizzle-orm";
import objectHash from "object-hash";
import type { Db } from "@/db/client";
import {
  events,
  idempotencyKeys,
  payments,
  type ReservationRow,
  type ReservationStatus,
  reservations,
} from "@/db/schema";
import { expireHold, reconcileOrphanSpends } from "./holds";
import {
  applyLoyaltyOperation,
  enqueueRestorePoints,
  getLoyaltyBalance,
  type LoyaltyGateway,
  maxPointsForAmount,
  releasePaymentPoints,
  spendSourceId,
} from "./loyalty";
import { generateReservationCode } from "./reservation-code";
import {
  type CheckoutGateway,
  type CheckoutSessionInput,
  STRIPE_CURRENCY,
} from "./stripe";
import { isSeatInLayout, parseSeatId } from "./validation";

export type CreateReservationInput = {
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  idempotencyKey: string;
};

export type CreateReservationResult =
  | {
      ok: true;
      reservationId: string;
      amount: number;
      expiresAt: string;
      replayed: boolean;
    }
  | {
      ok: false;
      reason:
        | "event_not_found"
        | "invalid_seat"
        | "seat_taken"
        | "idempotency_key_reused";
    };

export type PurchaseReservationResult =
  | { ok: true; code: string }
  | { ok: false; reason: "reservation_not_found" | "reservation_expired" };

export type ReservationState = {
  status: ReservationStatus;
  amount: number;
  expiresAt: string;
  code: string | null;
  pointsUsed: number;
  pointsEarned: number | null;
};

export type StartCheckoutResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason:
        | "reservation_not_found"
        | "reservation_expired"
        | "reservation_already_paid"
        | "payment_unavailable"
        | "points_limit_exceeded"
        | "insufficient_points"
        | "checkout_in_progress"
        | "loyalty_unavailable";
    };

export type StartCheckoutOptions = {
  // undefined when the request body did not supply points.
  points?: number;
  loyalty?: LoyaltyGateway | null;
};

// session.amount is the card amount (reservation amount minus points).
export type CheckoutContext = {
  session: CheckoutSessionInput;
  paymentId: string;
};

type CheckoutPreparation =
  | { ok: true; context: CheckoutContext; existingUrl: string | null }
  | Exclude<StartCheckoutResult, { ok: true }>;

const PRODUCTION_HOLD_TTL_MS = 15 * 60 * 1000;
const DEVELOPMENT_HOLD_TTL_MS = 2 * 60 * 1000;

export function getReservationHoldTtlMs(
  environment: string | undefined = process.env.NODE_ENV,
): number {
  return environment === "production"
    ? PRODUCTION_HOLD_TTL_MS
    : DEVELOPMENT_HOLD_TTL_MS;
}

// Convenience value for callers that need the TTL at import time (tests, UI
// copy). Request handling reads the environment again inside the transaction.
export const RESERVATION_HOLD_TTL_MS = getReservationHoldTtlMs();

const MAX_CODE_ATTEMPTS = 5;
const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

type NormalizedInput = Omit<CreateReservationInput, "idempotencyKey">;

type SqliteConstraintError = {
  code: string;
  message: string;
};

function normalizeInput(input: CreateReservationInput): NormalizedInput {
  return {
    eventId: input.eventId.trim(),
    seatId: input.seatId.trim().toUpperCase(),
    customerName: input.customerName.trim(),
    email: input.email.trim().toLowerCase(),
  };
}

function hashReservationRequest(input: NormalizedInput): string {
  return objectHash(
    {
      eventId: input.eventId,
      seatId: input.seatId,
      customerName: input.customerName,
      email: input.email,
    },
    { algorithm: "sha256", encoding: "hex" },
  );
}

function findConstraintError(error: unknown): SqliteConstraintError | null {
  let current: unknown = error;

  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;

    if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
      return { code, message: current.message };
    }

    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

function replayExistingKey(
  db: Db,
  key: string,
  requestHash: string,
): CreateReservationResult {
  const existingKey = db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .get();

  if (!existingKey) {
    throw new Error("Idempotency key conflict could not be resolved.");
  }

  if (existingKey.requestHash !== requestHash) {
    return { ok: false, reason: "idempotency_key_reused" };
  }

  const reservation = db
    .select()
    .from(reservations)
    .where(eq(reservations.id, existingKey.reservationId))
    .get();

  if (!reservation) {
    throw new Error("Idempotency key points at a missing reservation.");
  }

  return {
    ok: true,
    reservationId: reservation.id,
    amount: reservation.amount,
    expiresAt: reservation.expiresAt.toISOString(),
    replayed: true,
  };
}

export function createReservation(
  db: Db,
  input: CreateReservationInput,
): CreateReservationResult {
  const normalized = normalizeInput(input);
  const requestHash = hashReservationRequest(normalized);

  try {
    // BEGIN IMMEDIATE takes the write lock before the reads, so competing
    // writers (even across processes) queue on busy_timeout instead of
    // failing to upgrade a stale read snapshot with SQLITE_BUSY_SNAPSHOT.
    return db.transaction(
      (tx) => {
        // Read the clock only after the lock is held: a request may have
        // waited on a competing writer, and holds must be judged against
        // the time the transaction actually starts.
        const now = new Date();
        const expiresAt = new Date(now.getTime() + getReservationHoldTtlMs());
        const expiresBefore = new Date(now.getTime() - IDEMPOTENCY_KEY_TTL_MS);

        tx.delete(idempotencyKeys)
          .where(lt(idempotencyKeys.createdAt, expiresBefore))
          .run();

        const existingKey = tx
          .select()
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, input.idempotencyKey))
          .get();

        if (existingKey) {
          if (existingKey.requestHash !== requestHash) {
            return { ok: false, reason: "idempotency_key_reused" };
          }

          const reservation = tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, existingKey.reservationId))
            .get();

          if (reservation) {
            return {
              ok: true,
              reservationId: reservation.id,
              amount: reservation.amount,
              expiresAt: reservation.expiresAt.toISOString(),
              replayed: true,
            };
          }

          tx.delete(idempotencyKeys)
            .where(eq(idempotencyKeys.key, existingKey.key))
            .run();
        }

        const event = tx
          .select()
          .from(events)
          .where(eq(events.id, normalized.eventId))
          .get();

        if (!event) {
          return { ok: false, reason: "event_not_found" };
        }

        const seat = parseSeatId(normalized.seatId);

        if (!seat || !isSeatInLayout(seat, event.rows, event.seatsPerRow)) {
          return { ok: false, reason: "invalid_seat" };
        }

        // Expired holds no longer block the seat. Mark them explicitly so the
        // partial unique index accepts a new hold for the same seat.
        const staleHolds = tx
          .select({ id: reservations.id })
          .from(reservations)
          .where(
            and(
              eq(reservations.eventId, normalized.eventId),
              eq(reservations.seatId, normalized.seatId),
              eq(reservations.status, "held"),
              lte(reservations.expiresAt, now),
            ),
          )
          .all();

        for (const stale of staleHolds) {
          expireHold(tx, stale.id, now);
        }

        const taken = tx
          .select({ id: reservations.id })
          .from(reservations)
          .where(
            and(
              eq(reservations.eventId, normalized.eventId),
              eq(reservations.seatId, normalized.seatId),
              ne(reservations.status, "expired"),
            ),
          )
          .get();

        if (taken) {
          return { ok: false, reason: "seat_taken" };
        }

        const inserted = tx
          .insert(reservations)
          .values({
            id: crypto.randomUUID(),
            eventId: normalized.eventId,
            seatId: normalized.seatId,
            customerName: normalized.customerName,
            email: normalized.email,
            code: null,
            amount: event.price,
            status: "held",
            expiresAt,
            purchasedAt: null,
          })
          .returning({ id: reservations.id })
          .get();

        tx.insert(idempotencyKeys)
          .values({
            key: input.idempotencyKey,
            requestHash,
            reservationId: inserted.id,
          })
          .run();

        return {
          ok: true,
          reservationId: inserted.id,
          amount: event.price,
          expiresAt: expiresAt.toISOString(),
          replayed: false,
        };
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    const constraint = findConstraintError(error);

    if (constraint?.message.includes("idempotency_keys.key")) {
      return replayExistingKey(db, input.idempotencyKey, requestHash);
    }

    if (
      constraint &&
      (constraint.message.includes("reservations.event_id") ||
        constraint.message.includes("reservations.seat_id"))
    ) {
      return { ok: false, reason: "seat_taken" };
    }

    throw error;
  }
}

function toReservationState(reservation: ReservationRow): ReservationState {
  return {
    status: reservation.status,
    amount: reservation.amount,
    expiresAt: reservation.expiresAt.toISOString(),
    code: reservation.code,
    pointsUsed: reservation.pointsUsed,
    pointsEarned: reservation.pointsEarned,
  };
}

function findReservation(tx: Db, reservationId: string) {
  return tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .get();
}

export function getReservationState(
  db: Db,
  reservationId: string,
): ReservationState | null {
  return db.transaction(
    (tx) => {
      // The write lock is taken up front so a stale hold cannot be reported as
      // active while another request expires it.
      const now = new Date();
      const reservation = tx
        .select()
        .from(reservations)
        .where(eq(reservations.id, reservationId))
        .get();

      if (!reservation) {
        return null;
      }

      if (
        reservation.status === "held" &&
        reservation.expiresAt.getTime() <= now.getTime()
      ) {
        expireHold(tx, reservationId, now);

        const expired = findReservation(tx, reservationId);

        return toReservationState(expired ?? reservation);
      }

      return toReservationState(reservation);
    },
    { behavior: "immediate" },
  );
}

export type PaidTicket = {
  code: string;
  eventId: string;
  seatId: string;
  amount: number;
  pointsUsed: number;
  pointsEarned: number;
};

// Ticket pages render a code only after the database confirms it belongs to a
// paid reservation; a code in the URL alone is never trusted.
export function getPaidTicketByCode(db: Db, code: string): PaidTicket | null {
  const reservation = db
    .select({
      code: reservations.code,
      eventId: reservations.eventId,
      seatId: reservations.seatId,
      amount: reservations.amount,
      pointsUsed: reservations.pointsUsed,
      pointsEarned: reservations.pointsEarned,
    })
    .from(reservations)
    .where(and(eq(reservations.code, code), eq(reservations.status, "paid")))
    .get();

  return reservation?.code
    ? {
        code: reservation.code,
        eventId: reservation.eventId,
        seatId: reservation.seatId,
        amount: reservation.amount,
        pointsUsed: reservation.pointsUsed,
        pointsEarned: reservation.pointsEarned ?? 0,
      }
    : null;
}

function prepareCheckout(
  db: Db,
  reservationId: string,
  requestedPoints: number | undefined,
): CheckoutPreparation {
  return db.transaction(
    (tx) => {
      // Judge expiry only after BEGIN IMMEDIATE has acquired the write lock;
      // otherwise a queued request could start a payment for an expired hold.
      const now = new Date();
      const reservation = tx
        .select()
        .from(reservations)
        .where(eq(reservations.id, reservationId))
        .get();

      if (!reservation) {
        return { ok: false, reason: "reservation_not_found" };
      }

      if (reservation.status === "paid") {
        return { ok: false, reason: "reservation_already_paid" };
      }

      if (
        reservation.status === "expired" ||
        reservation.expiresAt.getTime() <= now.getTime()
      ) {
        if (reservation.status !== "expired") {
          expireHold(tx, reservationId, now);
        }

        return { ok: false, reason: "reservation_expired" };
      }

      if (reservation.amount <= 0) {
        return { ok: false, reason: "payment_unavailable" };
      }

      const points = requestedPoints ?? 0;

      if (points > maxPointsForAmount(reservation.amount)) {
        return { ok: false, reason: "points_limit_exceeded" };
      }

      reconcileOrphanSpends(tx, { reservationId, now });

      const event = tx
        .select({ title: events.title })
        .from(events)
        .where(eq(events.id, reservation.eventId))
        .get();

      if (!event) {
        return { ok: false, reason: "payment_unavailable" };
      }

      // A pending Checkout Session stays valid much longer than the hold, so
      // retries can reuse it instead of opening another payment attempt.
      const pendingPayment = tx
        .select({
          checkoutUrl: payments.checkoutUrl,
          pointsUsed: payments.pointsUsed,
        })
        .from(payments)
        .where(
          and(
            eq(payments.reservationId, reservationId),
            eq(payments.status, "pending"),
          ),
        )
        .orderBy(desc(payments.createdAt))
        .get();

      // The open attempt locks its points split until the session ends.
      if (
        pendingPayment &&
        requestedPoints !== undefined &&
        requestedPoints !== pendingPayment.pointsUsed
      ) {
        return { ok: false, reason: "checkout_in_progress" };
      }

      // Retries and concurrent requests for the same attempt share one key,
      // so Stripe returns the session it already created. Once an attempt is
      // recorded and later expires or fails, the next attempt gets a new key.
      const previousAttempts = tx
        .select({ id: payments.id })
        .from(payments)
        .where(eq(payments.reservationId, reservationId))
        .all().length;

      return {
        ok: true,
        context: {
          session: {
            reservationId: reservation.id,
            amount: reservation.amount - points,
            pointsUsed: points,
            customerEmail: reservation.email,
            seatId: reservation.seatId,
            eventTitle: event.title,
            idempotencyKey: `checkout:${reservation.id}:${
              previousAttempts + 1
            }`,
          },
          paymentId: crypto.randomUUID(),
        },
        existingUrl: pendingPayment?.checkoutUrl ?? null,
      };
    },
    { behavior: "immediate" },
  );
}

function recordCheckoutSession(
  db: Db,
  context: CheckoutContext,
  session: { id: string; url: string | null },
): StartCheckoutResult {
  return db.transaction(
    (tx) => {
      const now = new Date();
      const reservationId = context.session.reservationId;
      const reservation = findReservation(tx, reservationId);

      if (!reservation) {
        return { ok: false, reason: "reservation_not_found" };
      }

      if (reservation.status === "paid") {
        return { ok: false, reason: "reservation_already_paid" };
      }

      if (
        reservation.status === "expired" ||
        reservation.expiresAt.getTime() <= now.getTime()
      ) {
        if (reservation.status !== "expired") {
          expireHold(tx, reservationId, now);
        }

        return { ok: false, reason: "reservation_expired" };
      }

      if (!session.url) {
        return { ok: false, reason: "payment_unavailable" };
      }

      const existing = tx
        .select({ checkoutUrl: payments.checkoutUrl })
        .from(payments)
        .where(eq(payments.stripeCheckoutSessionId, session.id))
        .get();

      if (existing?.checkoutUrl) {
        return { ok: true, url: existing.checkoutUrl };
      }

      const inserted = tx
        .insert(payments)
        .values({
          id: context.paymentId,
          reservationId,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: null,
          checkoutUrl: session.url,
          amount: context.session.amount,
          pointsUsed: context.session.pointsUsed,
          currency: STRIPE_CURRENCY,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ checkoutUrl: payments.checkoutUrl })
        .get();

      if (inserted?.checkoutUrl) {
        tx.update(reservations)
          .set({ pointsUsed: context.session.pointsUsed })
          .where(
            and(
              eq(reservations.id, reservationId),
              eq(reservations.status, "held"),
            ),
          )
          .run();

        return { ok: true, url: inserted.checkoutUrl };
      }

      const conflict = tx
        .select({ checkoutUrl: payments.checkoutUrl })
        .from(payments)
        .where(eq(payments.stripeCheckoutSessionId, session.id))
        .get();

      if (conflict?.checkoutUrl) {
        return { ok: true, url: conflict.checkoutUrl };
      }

      return { ok: false, reason: "payment_unavailable" };
    },
    { behavior: "immediate" },
  );
}

// Records an attempt that will never be payable, so the attempt counter (and
// with it the Stripe idempotency key) advances. restorePoints is set when the
// debit happened or its outcome is still unknown.
function recordFailedAttempt(
  db: Db,
  context: CheckoutContext,
  session: { id: string; url: string | null },
  restorePoints: boolean,
): void {
  db.transaction(
    (tx) => {
      const now = new Date();

      tx.insert(payments)
        .values({
          id: context.paymentId,
          reservationId: context.session.reservationId,
          stripeCheckoutSessionId: session.id,
          stripePaymentIntentId: null,
          checkoutUrl: session.url,
          amount: context.session.amount,
          pointsUsed: context.session.pointsUsed,
          currency: STRIPE_CURRENCY,
          status: "failed",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      if (restorePoints) {
        enqueueRestorePoints(tx, context.paymentId, now);
      }
    },
    { behavior: "immediate" },
  );
}

async function expireSession(
  gateway: CheckoutGateway,
  sessionId: string,
  why: string,
): Promise<void> {
  try {
    await gateway.expireCheckoutSession(sessionId);
  } catch (error) {
    console.error(`Failed to expire ${why} Stripe session:`, error);
  }
}

async function debitPointsAndRecord(
  db: Db,
  gateway: CheckoutGateway,
  loyalty: LoyaltyGateway,
  context: CheckoutContext,
  session: { id: string; url: string | null },
): Promise<StartCheckoutResult> {
  const spend = await applyLoyaltyOperation(
    db,
    loyalty,
    {
      id: spendSourceId(session.id),
      type: "spend",
      reservationId: context.session.reservationId,
      paymentId: context.paymentId,
      points: context.session.pointsUsed,
      email: context.session.customerEmail,
    },
    { reconcileNow: true },
  );
  // A concurrent request for the same session may have recorded the spend
  // first; its payment id is the one the restore job keys on.
  const attempt: CheckoutContext = {
    ...context,
    paymentId: spend.operation.paymentId ?? context.paymentId,
  };

  if (spend.status !== "done") {
    try {
      recordFailedAttempt(db, attempt, session, spend.status === "uncertain");
    } catch (error) {
      console.error("Failed to record a failed points checkout:", error);
    }

    await expireSession(gateway, session.id, "unpaid points");

    return {
      ok: false,
      reason:
        spend.status === "failed" && spend.kind === "insufficient_points"
          ? "insufficient_points"
          : "loyalty_unavailable",
    };
  }

  let recorded: StartCheckoutResult;

  try {
    recorded = recordCheckoutSession(db, attempt, session);
  } catch (error) {
    console.error("Failed to record a points checkout:", error);
    recorded = { ok: false, reason: "payment_unavailable" };
  }

  if (!recorded.ok) {
    // Never hand out a session whose debit is not backed by a payment row.
    try {
      recordFailedAttempt(db, attempt, session, true);
    } catch (error) {
      // The "done" spend without a payment row is reconciled later.
      console.error("Failed to record a rejected points checkout:", error);
    }

    await expireSession(gateway, session.id, "rejected");
  }

  return recorded;
}

export async function startCheckout(
  db: Db,
  reservationId: string,
  gateway: CheckoutGateway | null,
  options: StartCheckoutOptions = {},
): Promise<StartCheckoutResult> {
  if (!gateway) {
    return { ok: false, reason: "payment_unavailable" };
  }

  const prepared = prepareCheckout(db, reservationId, options.points);

  if (!prepared.ok) {
    return prepared;
  }

  if (prepared.existingUrl) {
    return { ok: true, url: prepared.existingUrl };
  }

  const { context } = prepared;
  const points = context.session.pointsUsed;
  const loyalty = options.loyalty ?? null;

  if (points > 0) {
    if (!loyalty) {
      return { ok: false, reason: "loyalty_unavailable" };
    }

    let balance: number;

    try {
      balance = await getLoyaltyBalance(loyalty, context.session.customerEmail);
    } catch (error) {
      console.error(
        "Failed to read the loyalty balance:",
        error instanceof Error ? error.message : "unknown error",
      );
      return { ok: false, reason: "loyalty_unavailable" };
    }

    if (points > balance) {
      return { ok: false, reason: "insufficient_points" };
    }
  }

  let session: { id: string; url: string | null };

  try {
    session = await gateway.createCheckoutSession(context.session);
  } catch (error) {
    console.error("Failed to create Stripe Checkout Session:", error);
    return { ok: false, reason: "payment_unavailable" };
  }

  if (!session.url) {
    await expireSession(gateway, session.id, "unusable");

    return { ok: false, reason: "payment_unavailable" };
  }

  if (points > 0 && loyalty) {
    return debitPointsAndRecord(db, gateway, loyalty, context, session);
  }

  const recorded = recordCheckoutSession(db, context, session);

  if (!recorded.ok) {
    await expireSession(gateway, session.id, "rejected");
  }

  return recorded;
}

export function purchaseReservation(
  db: Db,
  reservationId: string,
): PurchaseReservationResult {
  return db.transaction(
    (tx) => {
      // Judge expiry only after BEGIN IMMEDIATE has acquired the write lock;
      // otherwise a request that waited for the lock could purchase a hold
      // that expired while it was queued.
      const now = new Date();
      const reservation = tx
        .select()
        .from(reservations)
        .where(eq(reservations.id, reservationId))
        .get();

      if (!reservation) {
        return { ok: false, reason: "reservation_not_found" };
      }

      if (reservation.status === "paid") {
        if (!reservation.code) {
          throw new Error("Purchased reservation is missing its code.");
        }

        return { ok: true, code: reservation.code };
      }

      if (
        reservation.status === "expired" ||
        reservation.expiresAt.getTime() <= now.getTime()
      ) {
        if (reservation.status !== "expired") {
          expireHold(tx, reservationId, now);
        }

        return { ok: false, reason: "reservation_expired" };
      }

      // The legacy flow neither uses nor awards points: give back any points
      // locked by an open checkout attempt.
      const openAttempt = tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.reservationId, reservationId),
            eq(payments.status, "pending"),
          ),
        )
        .get();

      if (openAttempt) {
        releasePaymentPoints(tx, openAttempt, now);
      }

      for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
        const code = generateReservationCode();

        try {
          const updated = tx
            .update(reservations)
            .set({
              status: "paid",
              code,
              purchasedAt: now,
              pointsUsed: 0,
              pointsEarned: 0,
            })
            .where(
              and(
                eq(reservations.id, reservationId),
                eq(reservations.status, "held"),
                gt(reservations.expiresAt, now),
              ),
            )
            .returning({ code: reservations.code })
            .get();

          if (updated) {
            if (!updated.code) {
              throw new Error("Purchased reservation is missing its code.");
            }

            return { ok: true, code: updated.code };
          }

          const current = tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, reservationId))
            .get();

          if (current?.status === "paid" && current.code) {
            return { ok: true, code: current.code };
          }

          if (current?.status === "held") {
            expireHold(tx, reservationId, now);

            return { ok: false, reason: "reservation_expired" };
          }

          throw new Error("Reservation could not be purchased.");
        } catch (error) {
          const constraint = findConstraintError(error);

          if (constraint?.message.includes("reservations.code")) {
            continue;
          }

          throw error;
        }
      }

      throw new Error("Could not generate a unique reservation code.");
    },
    { behavior: "immediate" },
  );
}
