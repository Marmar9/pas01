import { describe, expect, test } from "bun:test";
import { jobs, payments, reservations } from "@/db/schema";
import { runDueJobs } from "@/lib/jobs";
import { processStripeEvent } from "@/lib/payments";
import { createRefundHandler, refundJobId } from "@/lib/refunds";
import { createReservation } from "@/lib/reservations";
import type { RefundGateway, RefundInput } from "@/lib/stripe";
import { createTestDb, duneEvent, seedTestEvents } from "./helpers";

type TestDb = ReturnType<typeof createTestDb>;

function latePayment(db: TestDb) {
  seedTestEvents(db);
  const hold = createReservation(db, {
    eventId: duneEvent.id,
    seatId: "B4",
    customerName: "Ada Lovelace",
    email: "ada@example.com",
    idempotencyKey: "refund-test-key",
  });

  if (!hold.ok) {
    throw new Error(`Failed to create a test hold: ${hold.reason}`);
  }

  db.update(reservations)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .run();
  processStripeEvent(db, {
    id: "evt_late",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_late",
        object: "checkout.session",
        payment_status: "paid",
        currency: "pln",
        amount_total: duneEvent.price,
        client_reference_id: hold.reservationId,
        payment_intent: "pi_test_late",
        url: null,
      },
    },
  });

  const payment = db.select().from(payments).get();

  if (!payment) {
    throw new Error("expected a recorded payment");
  }

  return payment;
}

function fakeRefundGateway(fail = false) {
  const calls: RefundInput[] = [];
  const gateway: RefundGateway = {
    async refundPayment(input) {
      calls.push(input);

      if (fail) {
        throw new Error("Stripe is down");
      }

      return { id: "re_test_1" };
    },
  };

  return { gateway, calls };
}

describe("refund worker", () => {
  test("refunds a late payment once, keyed by the job id", async () => {
    const db = createTestDb();
    const payment = latePayment(db);
    const { gateway, calls } = fakeRefundGateway();
    const handlers = {
      "refund-payment": createRefundHandler(db, () => gateway),
    };

    await runDueJobs(db, handlers);
    await runDueJobs(db, handlers);

    expect(calls).toEqual([
      {
        paymentIntentId: "pi_test_late",
        amount: duneEvent.price,
        idempotencyKey: refundJobId(payment.id),
      },
    ]);
    expect(db.select().from(payments).get()).toMatchObject({
      status: "refunded",
      stripeRefundId: "re_test_1",
    });
    expect(db.select().from(jobs).get()?.completedAt).toBeInstanceOf(Date);
  });

  test("skips the Stripe call when the payment is already refunded", async () => {
    const db = createTestDb();
    latePayment(db);
    db.update(payments).set({ status: "refunded" }).run();
    const { gateway, calls } = fakeRefundGateway();

    await runDueJobs(db, {
      "refund-payment": createRefundHandler(db, () => gateway),
    });

    expect(calls).toHaveLength(0);
    expect(db.select().from(jobs).get()?.completedAt).toBeInstanceOf(Date);
  });

  test("keeps the job for a retry when Stripe fails", async () => {
    const db = createTestDb();
    latePayment(db);
    const { gateway } = fakeRefundGateway(true);

    await runDueJobs(db, {
      "refund-payment": createRefundHandler(db, () => gateway),
    });

    expect(db.select().from(payments).get()?.status).toBe("paid");
    expect(db.select().from(jobs).get()).toMatchObject({
      completedAt: null,
      totalTried: 1,
      hasError: false,
      lastError: "Stripe is down",
    });
  });

  test("retries while Stripe is not configured", async () => {
    const db = createTestDb();
    latePayment(db);

    await runDueJobs(db, {
      "refund-payment": createRefundHandler(db, () => null),
    });

    expect(db.select().from(jobs).get()).toMatchObject({
      completedAt: null,
      lastError: "Stripe is not configured.",
    });
  });
});
