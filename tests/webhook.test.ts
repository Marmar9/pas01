import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { POST as stripeWebhook } from "@/app/api/webhooks/stripe/route";
import { reservations } from "@/db/schema";
import { createReservation } from "@/lib/reservations";
import { createTestDb, duneEvent, seedTestEvents } from "./helpers";

type TestDb = ReturnType<typeof createTestDb>;

const WEBHOOK_SECRET = "whsec_test_secret";
const originalSecret = process.env.STRIPE_WEBHOOK_SECRET;

let db: TestDb;
let keyCounter = 0;
let errorLog: ReturnType<typeof spyOn>;
let warnLog: ReturnType<typeof spyOn>;

beforeEach(() => {
  db = createTestDb();
  seedTestEvents(db);
  Reflect.set(globalThis, "cinemaDb", db);
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  errorLog = spyOn(console, "error").mockImplementation(() => {});
  warnLog = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "cinemaDb");
  errorLog.mockRestore();
  warnLog.mockRestore();

  if (originalSecret === undefined) {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  } else {
    process.env.STRIPE_WEBHOOK_SECRET = originalSecret;
  }
});

function createHold() {
  keyCounter += 1;

  const created = createReservation(db, {
    eventId: duneEvent.id,
    seatId: "A2",
    customerName: "Ada Lovelace",
    email: "ada@example.com",
    idempotencyKey: `webhook-key-${keyCounter}`,
  });

  if (!created.ok) {
    throw new Error(`Failed to create a test hold: ${created.reason}`);
  }

  return created;
}

function eventPayload(
  reservationId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "evt_webhook_test",
    object: "event",
    api_version: "2025-01-01",
    created: Math.floor(Date.now() / 1000),
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_webhook_test",
        object: "checkout.session",
        payment_status: "paid",
        currency: "pln",
        amount_total: duneEvent.price,
        client_reference_id: reservationId,
        metadata: { reservationId },
        payment_intent: "pi_webhook_test",
        url: "https://checkout.stripe.test/webhook",
      },
    },
    ...overrides,
  };
}

async function signedRequest(
  payload: object,
  secret = WEBHOOK_SECRET,
): Promise<Request> {
  const body = JSON.stringify(payload);
  const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
    payload: body,
    secret,
  });

  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": signature },
    body,
  });
}

async function readJson(response: Response): Promise<unknown> {
  return response.json();
}

describe("POST /api/webhooks/stripe", () => {
  test("verifies the signature and marks the reservation paid", async () => {
    const hold = createHold();
    const response = await stripeWebhook(
      await signedRequest(eventPayload(hold.reservationId)),
    );

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ received: true });

    const reservation = db
      .select()
      .from(reservations)
      .where(eq(reservations.id, hold.reservationId))
      .get();

    expect(reservation?.status).toBe("paid");
    expect(reservation?.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  test("rejects a missing signature", async () => {
    const response = await stripeWebhook(
      new Request("http://localhost/api/webhooks/stripe", {
        method: "POST",
        body: JSON.stringify(eventPayload("res-1")),
      }),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      code: "INVALID_SIGNATURE",
    });
  });

  test("rejects a forged signature", async () => {
    const hold = createHold();
    const response = await stripeWebhook(
      await signedRequest(
        eventPayload(hold.reservationId),
        "whsec_wrong_secret",
      ),
    );

    expect(response.status).toBe(400);
    expect(await readJson(response)).toMatchObject({
      code: "INVALID_SIGNATURE",
    });
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.status,
    ).toBe("held");
  });

  test("acknowledges an amount mismatch without issuing a ticket", async () => {
    const hold = createHold();
    const payload = eventPayload(hold.reservationId);

    payload.data.object.amount_total = duneEvent.price - 1;

    const response = await stripeWebhook(await signedRequest(payload));

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({
      received: true,
      ignored: true,
    });
    expect(warnLog).toHaveBeenCalled();
    expect(
      db
        .select()
        .from(reservations)
        .where(eq(reservations.id, hold.reservationId))
        .get()?.status,
    ).toBe("held");
  });

  test("acknowledges duplicate deliveries idempotently", async () => {
    const hold = createHold();
    const payload = eventPayload(hold.reservationId);

    const first = await stripeWebhook(await signedRequest(payload));
    const second = await stripeWebhook(await signedRequest(payload));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({
      received: true,
      duplicate: true,
    });
  });
});
