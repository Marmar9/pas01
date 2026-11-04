import { and, eq, gt } from "drizzle-orm";
import type Stripe from "stripe";
import type { Db } from "@/db/client";
import {
  type PaymentStatus,
  payments,
  type ReservationRow,
  reservations,
  stripeEvents,
} from "@/db/schema";
import { generateReservationCode } from "./reservation-code";
import { STRIPE_CURRENCY } from "./stripe";

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

function updatePaymentStatus(
  tx: Db,
  sessionId: string,
  status: PaymentStatus,
): void {
  // Never regress a paid attempt if Stripe delivers an old terminal event
  // out of order.
  tx.update(payments)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(payments.stripeCheckoutSessionId, sessionId),
        eq(payments.status, "pending"),
      ),
    )
    .run();
}

function upsertPaidPayment(
  tx: Db,
  session: Stripe.Checkout.Session,
  reservation: ReservationRow,
): void {
  const now = new Date();
  const existing = tx
    .select({ id: payments.id })
    .from(payments)
    .where(eq(payments.stripeCheckoutSessionId, session.id))
    .get();

  if (existing) {
    tx.update(payments)
      .set({
        status: "paid",
        amount: session.amount_total ?? reservation.amount,
        currency: session.currency ?? STRIPE_CURRENCY,
        stripePaymentIntentId: getPaymentIntentId(session),
        updatedAt: now,
      })
      .where(eq(payments.id, existing.id))
      .run();

    return;
  }

  tx.insert(payments)
    .values({
      id: crypto.randomUUID(),
      reservationId: reservation.id,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: getPaymentIntentId(session),
      checkoutUrl: session.url,
      amount: session.amount_total ?? reservation.amount,
      currency: session.currency ?? STRIPE_CURRENCY,
      status: "paid",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
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

  if (session.amount_total !== reservation.amount) {
    return { ok: false, reason: "amount_mismatch", permanent: true };
  }

  if (reservation.status === "paid") {
    upsertPaidPayment(tx, session, reservation);
    return { ok: true };
  }

  const now = new Date();

  if (
    reservation.status === "expired" ||
    reservation.expiresAt.getTime() <= now.getTime()
  ) {
    if (reservation.status !== "expired") {
      tx.update(reservations)
        .set({ status: "expired" })
        .where(
          and(
            eq(reservations.id, reservationId),
            eq(reservations.status, "held"),
          ),
        )
        .run();
    }

    // Keep the successful payment for audit/reconciliation, but do not turn an
    // expired hold into a ticket because its seat may already be re-held.
    upsertPaidPayment(tx, session, reservation);

    return { ok: false, reason: "reservation_expired", permanent: true };
  }

  const code = issueCodeForPaidReservation(tx, reservationId, now);

  if (!code) {
    return { ok: false, reason: "code_generation_failed", permanent: true };
  }

  upsertPaidPayment(tx, session, reservation);

  return { ok: true };
}

export function processStripeEvent(
  db: Db,
  event: StripeEventLike,
): ProcessStripeEventResult {
  return db.transaction(
    (tx) => {
      const inserted = tx
        .insert(stripeEvents)
        .values({ id: event.id, type: event.type })
        .onConflictDoNothing()
        .returning({ id: stripeEvents.id })
        .get();

      if (!inserted) {
        return { ok: true, duplicate: true };
      }

      if (
        event.type === "checkout.session.expired" ||
        event.type === "checkout.session.async_payment_failed"
      ) {
        const session = asCheckoutSession(event.data.object);

        if (!session) {
          return { ok: false, reason: "invalid_session", permanent: true };
        }

        updatePaymentStatus(
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
    },
    { behavior: "immediate" },
  );
}
