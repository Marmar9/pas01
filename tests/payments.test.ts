import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { payments, reservations, stripeEvents } from "@/db/schema";
import { processStripeEvent } from "@/lib/payments";
import { createReservation } from "@/lib/reservations";
import { createTestDb, duneEvent, seedTestEvents } from "./helpers";

type TestDb = ReturnType<typeof createTestDb>;

let keyCounter = 0;

function createHold(db: TestDb) {
  keyCounter += 1;

  const created = createReservation(db, {
    eventId: duneEvent.id,
    seatId: "A2",
    customerName: "Ada Lovelace",
    email: "ada@example.com",
    idempotencyKey: `payment-key-${keyCounter}`,
  });

  if (!created.ok) {
    throw new Error(`Failed to create a test hold: ${created.reason}`);
  }

  return created;
}

function checkoutSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_test_1",
    object: "checkout.session",
    payment_status: "paid",
    currency: "pln",
    amount_total: duneEvent.price,
    client_reference_id: undefined as string | undefined,
    metadata: {} as Record<string, string>,
    payment_intent: "pi_test_1",
    url: "https://checkout.stripe.test/1",
    ...overrides,
  };
}

function stripeEvent(type: string, session: unknown, id = "evt_test_1") {
  return { id, type, data: { object: session } };
}

function insertPendingPayment(
  db: TestDb,
  reservationId: string,
  sessionId = "cs_test_pending",
) {
  db.insert(payments)
    .values({
      id: crypto.randomUUID(),
      reservationId,
      stripeCheckoutSessionId: sessionId,
      stripePaymentIntentId: null,
      checkoutUrl: `https://checkout.stripe.test/${sessionId}`,
      amount: duneEvent.price,
      currency: "pln",
      status: "pending",
    })
    .run();
}

describe("processStripeEvent", () => {
  test("marks a reservation paid and issues its code exactly once", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ client_reference_id: hold.reservationId }),
      ),
    );

    expect(result).toEqual({ ok: true });

    const reservation = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId))
      .get();

    expect(reservation?.status).toBe("paid");
    expect(reservation?.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(reservation?.purchasedAt).toBeInstanceOf(Date);

    const payment = db.select().from(payments).get();

    expect(payment).toMatchObject({
      reservationId: hold.reservationId,
      stripeCheckoutSessionId: "cs_test_1",
      stripePaymentIntentId: "pi_test_1",
      amount: duneEvent.price,
      currency: "pln",
      status: "paid",
    });
  });

  test("uses metadata.reservationId when client_reference_id is absent", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({
          metadata: { reservationId: hold.reservationId },
        }),
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.status,
    ).toBe("paid");
  });

  test("ignores a duplicate delivery of the same event", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({ client_reference_id: hold.reservationId }),
    );

    const first = processStripeEvent(db, event);
    const code = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId))
      .get()?.code;

    const second = processStripeEvent(db, event);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true, duplicate: true });
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.code,
    ).toBe(code);
    expect(db.select().from(payments).all()).toHaveLength(1);
    expect(db.select().from(stripeEvents).all()).toHaveLength(1);
  });

  test("accepts async_payment_succeeded as a paid signal", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.async_payment_succeeded",
        checkoutSession({ client_reference_id: hold.reservationId }),
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.status,
    ).toBe("paid");
  });

  test("does not mark a reservation paid when the amount differs", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({
          client_reference_id: hold.reservationId,
          amount_total: duneEvent.price - 1,
        }),
      ),
    );

    expect(result).toEqual({
      ok: false,
      reason: "amount_mismatch",
      permanent: true,
    });

    const reservation = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId))
      .get();

    expect(reservation?.status).toBe("held");
    expect(reservation?.code).toBeNull();
    expect(db.select().from(payments).all()).toHaveLength(0);
  });

  test("does not mark a reservation paid when the currency differs", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({
          client_reference_id: hold.reservationId,
          currency: "eur",
        }),
      ),
    );

    expect(result).toEqual({
      ok: false,
      reason: "currency_mismatch",
      permanent: true,
    });
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.status,
    ).toBe("held");
  });

  test("ignores a completed session that is not paid yet", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({
          client_reference_id: hold.reservationId,
          payment_status: "unpaid",
        }),
      ),
    );

    expect(result).toEqual({ ok: true, ignored: true });
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.status,
    ).toBe("held");
    expect(db.select().from(payments).all()).toHaveLength(0);
  });

  test("reports an unknown reservation without marking anything paid", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ client_reference_id: "missing-reservation" }),
      ),
    );

    expect(result).toEqual({
      ok: false,
      reason: "reservation_not_found",
      permanent: true,
    });
    expect(db.select().from(payments).all()).toHaveLength(0);
  });

  test("rejects a session without a reservation reference", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = processStripeEvent(
      db,
      stripeEvent("checkout.session.completed", checkoutSession()),
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid_session",
      permanent: true,
    });
  });

  test("records a payment for an expired hold but does not issue a code", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    db.update(reservations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(reservations.id, hold.reservationId))
      .run();

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ client_reference_id: hold.reservationId }),
      ),
    );

    expect(result).toEqual({
      ok: false,
      reason: "reservation_expired",
      permanent: true,
    });

    const reservation = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId))
      .get();

    expect(reservation?.status).toBe("expired");
    expect(reservation?.code).toBeNull();
    expect(db.select().from(payments).get()?.status).toBe("paid");
  });

  test("keeps the first code when a later session reports the same reservation paid", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({ client_reference_id: hold.reservationId }),
        "evt_first",
      ),
    );

    const firstCode = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId))
      .get()?.code;

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({
          id: "cs_test_2",
          client_reference_id: hold.reservationId,
          payment_intent: "pi_test_2",
        }),
        "evt_second",
      ),
    );

    expect(result).toEqual({ ok: true });

    const reservation = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId))
      .get();

    expect(reservation?.code).toBe(firstCode);
    expect(reservation?.status).toBe("paid");
    expect(
      db
        .select()
        .from(payments)
        .where(eq(payments.reservationId, hold.reservationId))
        .all(),
    ).toHaveLength(2);
  });

  test("marks a pending payment expired on checkout.session.expired", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    insertPendingPayment(db, hold.reservationId);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.expired",
        checkoutSession({
          id: "cs_test_pending",
          payment_status: "unpaid",
        }),
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(db.select().from(payments).get()?.status).toBe("expired");
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.status,
    ).toBe("held");
  });

  test("marks a pending payment failed on async payment failure", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);
    insertPendingPayment(db, hold.reservationId);

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.async_payment_failed",
        checkoutSession({
          id: "cs_test_pending",
          payment_status: "unpaid",
        }),
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(db.select().from(payments).get()?.status).toBe("failed");
  });

  test("acknowledges unrelated event types", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = processStripeEvent(
      db,
      stripeEvent("customer.created", { id: "cus_test" }),
    );

    expect(result).toEqual({ ok: true, ignored: true });
  });

  test("does not regress a paid payment on an out-of-order expiry event", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.completed",
        checkoutSession({
          id: "cs_test_paid",
          client_reference_id: hold.reservationId,
        }),
        "evt_paid",
      ),
    );

    const result = processStripeEvent(
      db,
      stripeEvent(
        "checkout.session.expired",
        checkoutSession({ id: "cs_test_paid", payment_status: "unpaid" }),
        "evt_late_expiry",
      ),
    );

    expect(result).toEqual({ ok: true });
    expect(
      db
        .select()
        .from(payments)
        .where(eq(payments.stripeCheckoutSessionId, "cs_test_paid"))
        .get()?.status,
    ).toBe("paid");
  });

  test("allows only one pending payment attempt per reservation", () => {
    const db = createTestDb();
    seedTestEvents(db);
    const hold = createHold(db);

    insertPendingPayment(db, hold.reservationId, "cs_test_first");

    expect(() =>
      insertPendingPayment(db, hold.reservationId, "cs_test_second"),
    ).toThrow();
    expect(db.select().from(payments).all()).toHaveLength(1);
  });

  test("rejects an event whose object is not a Checkout Session", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = processStripeEvent(
      db,
      stripeEvent("checkout.session.completed", { object: "payment_intent" }),
    );

    expect(result).toEqual({
      ok: false,
      reason: "invalid_session",
      permanent: true,
    });
  });
});
