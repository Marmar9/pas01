import { and, eq, isNull, lte, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { loyaltyOperations, payments, reservations } from "@/db/schema";
import {
  enqueueRestorePoints,
  releasePaymentPoints,
  sessionIdFromSpendSourceId,
} from "./loyalty";
import { STRIPE_CURRENCY } from "./stripe";

// A checkout records its payment row a moment after the debit succeeds; give
// it time before treating the debit as orphaned.
export const ORPHAN_SPEND_GRACE_MS = 60_000;
const MAX_SWEEP_BATCH = 100;

export function expireHold(tx: Db, reservationId: string, now = new Date()) {
  const expired = tx
    .update(reservations)
    .set({ status: "expired" })
    .where(
      and(eq(reservations.id, reservationId), eq(reservations.status, "held")),
    )
    .returning({ id: reservations.id })
    .get();

  if (!expired) {
    return false;
  }

  // The open Stripe session may still be paid later; that late payment is
  // refunded, so its points are given back now.
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

  return true;
}

/**
 * A crash between the Voucherify debit and the payment insert leaves a spend
 * with no payment row. Record the attempt as failed (so the next checkout gets
 * a new idempotency key) and restore its points; its URL was never handed out.
 */
export function reconcileOrphanSpends(
  tx: Db,
  options: { reservationId?: string; now?: Date } = {},
): number {
  const now = options.now ?? new Date();
  const orphans = tx
    .select({ operation: loyaltyOperations, reservation: reservations })
    .from(loyaltyOperations)
    .innerJoin(
      reservations,
      eq(reservations.id, loyaltyOperations.reservationId),
    )
    .leftJoin(payments, eq(payments.id, loyaltyOperations.paymentId))
    .where(
      and(
        eq(loyaltyOperations.type, "spend"),
        ne(loyaltyOperations.status, "failed"),
        isNull(payments.id),
        lte(
          loyaltyOperations.updatedAt,
          new Date(now.getTime() - ORPHAN_SPEND_GRACE_MS),
        ),
        options.reservationId
          ? eq(loyaltyOperations.reservationId, options.reservationId)
          : undefined,
      ),
    )
    .limit(MAX_SWEEP_BATCH)
    .all();

  for (const { operation, reservation } of orphans) {
    if (!operation.paymentId) {
      continue;
    }

    tx.insert(payments)
      .values({
        id: operation.paymentId,
        reservationId: reservation.id,
        stripeCheckoutSessionId: sessionIdFromSpendSourceId(operation.id),
        stripePaymentIntentId: null,
        checkoutUrl: null,
        amount: reservation.amount - operation.points,
        pointsUsed: operation.points,
        currency: STRIPE_CURRENCY,
        status: "failed",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    enqueueRestorePoints(tx, operation.paymentId, now);
  }

  return orphans.length;
}

// Lazy expiry on read/create is only the fast path; the worker also expires
// holds nobody reads so their points are restored.
export function sweepExpiredHolds(db: Db, now = new Date()): number {
  return db.transaction(
    (tx) => {
      const stale = tx
        .select({ id: reservations.id })
        .from(reservations)
        .where(
          and(
            eq(reservations.status, "held"),
            lte(reservations.expiresAt, now),
          ),
        )
        .limit(MAX_SWEEP_BATCH)
        .all();

      for (const { id } of stale) {
        expireHold(tx, id, now);
      }

      return stale.length + reconcileOrphanSpends(tx, { now });
    },
    { behavior: "immediate" },
  );
}
