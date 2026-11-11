import { and, eq, gt, isNull, lt, ne } from "drizzle-orm";
import type Stripe from "stripe";
import type { Db } from "@/db/client";
import {
  loyaltyOperations,
  type PaymentStatus,
  payments,
  type ReservationRow,
  reservations,
  type StripeEventOutcome,
  stripeEvents,
} from "@/db/schema";
import { expireHold } from "./holds";
import {
  enqueueCreditPoints,
  pointsEarnedFor,
  releasePaymentPoints,
  spendSourceId,
} from "./loyalty";
import { enqueueRefund } from "./refunds";
import { generateReservationCode } from "./reservation-code";
import { STRIPE_CURRENCY } from "./stripe";
import { enqueueTicketEmail } from "./ticket-email";

export type StripeEventLike = {
  id: string;
  type: string;
  data: { object: unknown };
};

export type ProcessStripeEventResult =
  | { ok: true; duplicate?: boolean; ignored?: boolean }
  | {
      ok: false;
      reason:
        | "invalid_session"
        | "reservation_not_found"
        | "reservation_expired"
        | "amount_mismatch"
        | "currency_mismatch"
        | "code_generation_failed";
      permanent: boolean;
    };

const MAX_CODE_ATTEMPTS = 5;
// Stripe retries a webhook for up to 3 days; keep inbox ids well beyond that.
const INBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type SqliteConstraintError = {
  code: string;
  message: string;
};

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

function asCheckoutSession(value: unknown): Stripe.Checkout.Session | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  return (value as { object?: unknown }).object === "checkout.session"
    ? (value as Stripe.Checkout.Session)
    : null;
}

function getPaymentIntentId(session: Stripe.Checkout.Session): string | null {
  if (typeof session.payment_intent === "string") {
    return session.payment_intent;
  }

  return session.payment_intent?.id ?? null;
}

function endPendingPayment(
  tx: Db,
  sessionId: string,
  status: PaymentStatus,
): void {
  // Never regress a paid attempt if Stripe delivers an old terminal event
  // out of order.
  const ended = tx
    .update(payments)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(payments.stripeCheckoutSessionId, sessionId),
        eq(payments.status, "pending"),
      ),
    )
    .returning()
    .get();

  if (ended) {
    releasePaymentPoints(tx, ended);
  }
}

// The points split the session was created with. If a crash during checkout
// left no payment row, the spend operation keyed by the session id has it.
function sessionPointsUsed(tx: Db, sessionId: string): number {
  const payment = tx
    .select({ pointsUsed: payments.pointsUsed })
    .from(payments)
    .where(eq(payments.stripeCheckoutSessionId, sessionId))
    .get();

  if (payment) {
    return payment.pointsUsed;
  }

  const spend = tx
    .select({ points: loyaltyOperations.points })
    .from(loyaltyOperations)
    .where(eq(loyaltyOperations.id, spendSourceId(sessionId)))
    .get();

  return spend?.points ?? 0;
}

function upsertPaidPayment(
  tx: Db,
  session: Stripe.Checkout.Session,
  reservation: ReservationRow,
  pointsUsed: number,
): { id: string; reservationId: string; pointsUsed: number } {
  const now = new Date();
  const existing = tx
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.stripeCheckoutSessionId, session.id))
    .get();

  if (existing) {
    // A refunded payment must not flip back to paid on a late or repeated
    // event for the same session.
    tx.update(payments)
      .set({
        status: "paid",
        amount: session.amount_total ?? reservation.amount,
        currency: session.currency ?? STRIPE_CURRENCY,
        stripePaymentIntentId: getPaymentIntentId(session),
        updatedAt: now,
      })
      .where(and(eq(payments.id, existing.id), ne(payments.status, "refunded")))
      .run();

    return { id: existing.id, reservationId: reservation.id, pointsUsed };
  }

  const id = crypto.randomUUID();

  tx.insert(payments)
    .values({
      id,
      reservationId: reservation.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: getPaymentIntentId(session),
      checkoutUrl: session.url,
      amount: session.amount_total ?? reservation.amount - pointsUsed,
      pointsUsed,
      currency: session.currency ?? STRIPE_CURRENCY,
      status: "paid",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { id, reservationId: reservation.id, pointsUsed };
}

function hasOtherPaidPayment(
  tx: Db,
  reservationId: string,
  paymentId: string,
): boolean {
  return Boolean(
    tx
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.reservationId, reservationId),
          eq(payments.status, "paid"),
          ne(payments.id, paymentId),
        ),
      )
      .get(),
  );
}

function issueCodeForPaidReservation(
  tx: Db,
  reservationId: string,
  now: Date,
): string | null {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateReservationCode();

    try {
      const updated = tx
        .update(reservations)
        .set({ status: "paid", code, purchasedAt: now })
        .where(
          and(
            eq(reservations.id, reservationId),
            eq(reservations.status, "held"),
            gt(reservations.expiresAt, now),
          ),
        )
        .returning({ code: reservations.code })
        .get();

      if (updated?.code) {
        return updated.code;
      }

      const current = tx
        .select()
        .from(reservations)
        .where(eq(reservations.id, reservationId))
        .get();

      if (current?.status === "paid" && current.code) {
        return current.code;
      }

      return null;
    } catch (error) {
      const constraint = findConstraintError(error);

      if (constraint?.message.includes("reservations.code")) {
        continue;
      }

      throw error;
    }
  }

  return null;
}

function applyPaidSession(
  tx: Db,
  session: Stripe.Checkout.Session,
): ProcessStripeEventResult {
  const reservationId =
    session.client_reference_id ?? session.metadata?.reservationId ?? null;

  if (!reservationId) {
    return { ok: false, reason: "invalid_session", permanent: true };
  }

  const reservation = tx
    .select()
    .from(reservations)
    .where(eq(reservations.id, reservationId))
    .get();

  if (!reservation) {
    return { ok: false, reason: "reservation_not_found", permanent: true };
  }

  if (session.currency !== STRIPE_CURRENCY) {
    return { ok: false, reason: "currency_mismatch", permanent: true };
  }

  const pointsUsed = sessionPointsUsed(tx, session.id);
  const cardAmount = reservation.amount - pointsUsed;

  if (session.amount_total !== cardAmount) {
    return { ok: false, reason: "amount_mismatch", permanent: true };
  }

  if (reservation.status === "paid") {
    const payment = upsertPaidPayment(tx, session, reservation, pointsUsed);

    // A second paid session for an already paid reservation is a double
    // charge: keep the first ticket, refund this payment and restore its
    // points. It earns no points.
    if (hasOtherPaidPayment(tx, reservationId, payment.id)) {
      enqueueRefund(tx, payment.id);
      releasePaymentPoints(tx, payment);
    }

    return { ok: true };
  }

  const now = new Date();

  if (
    reservation.status === "expired" ||
    reservation.expiresAt.getTime() <= now.getTime()
  ) {
    if (reservation.status !== "expired") {
      expireHold(tx, reservationId, now);
    }

    // Keep the successful payment for audit/reconciliation, but do not turn an
    // expired hold into a ticket because its seat may already be re-held.
    // The customer was charged without a ticket, so refund via the outbox
    // and restore the points of this payment. It earns no points.
    const payment = upsertPaidPayment(tx, session, reservation, pointsUsed);
    enqueueRefund(tx, payment.id);
    releasePaymentPoints(tx, payment, now);

    return { ok: false, reason: "reservation_expired", permanent: true };
  }

  const code = issueCodeForPaidReservation(tx, reservationId, now);

  if (!code) {
    return { ok: false, reason: "code_generation_failed", permanent: true };
  }

  upsertPaidPayment(tx, session, reservation, pointsUsed);

  // Only the part paid by card earns points.
  const pointsEarned = pointsEarnedFor(cardAmount);
  const firstPaid = tx
    .update(reservations)
    .set({ pointsUsed, pointsEarned })
    .where(
      and(
        eq(reservations.id, reservationId),
        isNull(reservations.pointsEarned),
      ),
    )
    .returning({ id: reservations.id })
    .get();

  if (firstPaid) {
    if (pointsEarned > 0) {
      enqueueCreditPoints(tx, reservationId, now);
    }

    enqueueTicketEmail(tx, reservationId, now);
  }

  return { ok: true };
}

function handleStripeEvent(
  tx: Db,
  event: StripeEventLike,
): ProcessStripeEventResult {
  if (
    event.type === "checkout.session.expired" ||
    event.type === "checkout.session.async_payment_failed"
  ) {
    const session = asCheckoutSession(event.data.object);

    if (!session) {
      return { ok: false, reason: "invalid_session", permanent: true };
    }

    endPendingPayment(
      tx,
      session.id,
      event.type === "checkout.session.expired" ? "expired" : "failed",
    );

    return { ok: true };
  }

  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.async_payment_succeeded"
  ) {
    return { ok: true, ignored: true };
  }

  const session = asCheckoutSession(event.data.object);

  if (!session) {
    return { ok: false, reason: "invalid_session", permanent: true };
  }

  // `completed` can be emitted before an asynchronous payment settles.
  // The async_payment_succeeded event will finish the reservation later.
  if (session.payment_status !== "paid") {
    return { ok: true, ignored: true };
  }

  return applyPaidSession(tx, session);
}

function toOutcome(result: ProcessStripeEventResult): StripeEventOutcome {
  if (!result.ok) {
    return "failed";
  }

  return result.ignored ? "ignored" : "processed";
}

export function processStripeEvent(
  db: Db,
  event: StripeEventLike,
  now = new Date(),
): ProcessStripeEventResult {
  return db.transaction(
    (tx) => {
      // Failed events are the dead-letter record for human review, so only
      // handled ones are pruned.
      tx.delete(stripeEvents)
        .where(
          and(
            lt(
              stripeEvents.processedAt,
              new Date(now.getTime() - INBOX_RETENTION_MS),
            ),
            ne(stripeEvents.outcome, "failed"),
          ),
        )
        .run();

      const inserted = tx
        .insert(stripeEvents)
        .values({ id: event.id, type: event.type, processedAt: now })
        .onConflictDoNothing()
        .returning({ id: stripeEvents.id })
        .get();

      if (!inserted) {
        return { ok: true, duplicate: true };
      }

      const result = handleStripeEvent(tx, event);

      tx.update(stripeEvents)
        .set({
          outcome: toOutcome(result),
          failureReason: result.ok ? null : result.reason,
        })
        .where(eq(stripeEvents.id, event.id))
        .run();

      return result;
    },
    { behavior: "immediate" },
  );
}
