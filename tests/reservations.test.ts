import { describe, expect, test } from "bun:test";
import { idempotencyKeys, reservations } from "@/db/schema";
import {
  createReservation,
  getReservationHoldTtlMs,
  purchaseReservation,
  RESERVATION_HOLD_TTL_MS,
} from "@/lib/reservations";
import { createTestDb, duneEvent, seedTestEvents } from "./helpers";

let keyCounter = 0;

function reservationInput(overrides: Record<string, string> = {}) {
  keyCounter += 1;

  return {
    eventId: duneEvent.id,
    seatId: "A2",
    customerName: "Ada Lovelace",
    email: "ada@example.com",
    idempotencyKey: `test-key-${keyCounter}`,
    ...overrides,
  };
}

function expireReservations(db: ReturnType<typeof createTestDb>) {
  db.update(reservations)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .run();
}

describe("reservation hold TTL", () => {
  test("uses 15 minutes in production", () => {
    expect(getReservationHoldTtlMs("production")).toBe(15 * 60 * 1000);
  });

  test("uses 2 minutes outside production", () => {
    expect(getReservationHoldTtlMs("development")).toBe(2 * 60 * 1000);
    expect(getReservationHoldTtlMs("test")).toBe(2 * 60 * 1000);
    expect(getReservationHoldTtlMs("staging")).toBe(2 * 60 * 1000);
  });
});

describe("createReservation", () => {
  test("creates a hold with an expiry and no code", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = createReservation(db, reservationInput());

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.replayed).toBe(false);
    expect(result.reservationId).toBeTruthy();
    expect(result.expiresAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect("code" in result).toBe(false);

    const expiresAt = new Date(result.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(
      Date.now() + RESERVATION_HOLD_TTL_MS + 1000,
    );

    const stored = db.select().from(reservations).all();

    expect(stored).toHaveLength(1);
    expect(stored[0].seatId).toBe("A2");
    expect(stored[0].code).toBeNull();
    expect(stored[0].status).toBe("held");
    expect(stored[0].purchasedAt).toBeNull();
    expect(stored[0].expiresAt.toISOString()).toBe(result.expiresAt);
  });

  test("normalizes the seat id to uppercase", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = createReservation(db, reservationInput({ seatId: "b7" }));

    expect(result.ok).toBe(true);
    expect(db.select().from(reservations).get()?.seatId).toBe("B7");
  });

  test("rejects a seat that is already held", () => {
    const db = createTestDb();
    seedTestEvents(db);

    expect(createReservation(db, reservationInput()).ok).toBe(true);
    expect(createReservation(db, reservationInput())).toEqual({
      ok: false,
      reason: "seat_taken",
    });
    expect(db.select().from(reservations).all()).toHaveLength(1);
  });

  test("rejects seats outside the event layout", () => {
    const db = createTestDb();
    seedTestEvents(db);

    expect(createReservation(db, reservationInput({ seatId: "K1" }))).toEqual({
      ok: false,
      reason: "invalid_seat",
    });
    expect(createReservation(db, reservationInput({ seatId: "A15" }))).toEqual({
      ok: false,
      reason: "invalid_seat",
    });
    expect(createReservation(db, reservationInput({ seatId: "A0" }))).toEqual({
      ok: false,
      reason: "invalid_seat",
    });
    expect(createReservation(db, reservationInput({ seatId: "12" }))).toEqual({
      ok: false,
      reason: "invalid_seat",
    });
  });

  test("rejects reservations for unknown events", () => {
    const db = createTestDb();
    seedTestEvents(db);

    expect(
      createReservation(db, reservationInput({ eventId: "missing" })),
    ).toEqual({ ok: false, reason: "event_not_found" });
  });

  test("allows the same seat for different events", () => {
    const db = createTestDb();
    seedTestEvents(db);

    expect(createReservation(db, reservationInput()).ok).toBe(true);
    expect(
      createReservation(db, reservationInput({ eventId: "event-interstellar" }))
        .ok,
    ).toBe(true);
  });

  test("replays the original response for a repeated idempotency key", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const input = reservationInput({ idempotencyKey: "replay-key-123" });
    const first = createReservation(db, input);
    const second = createReservation(db, input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (!first.ok || !second.ok) {
      return;
    }

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.expiresAt).toBe(first.expiresAt);

    expect(db.select().from(reservations).all()).toHaveLength(1);
    expect(db.select().from(idempotencyKeys).all()).toHaveLength(1);
  });

  test("replays the original hold after it expired", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const input = reservationInput({ idempotencyKey: "expired-replay-key" });
    const first = createReservation(db, input);

    expect(first.ok).toBe(true);

    if (!first.ok) {
      return;
    }

    const expiredAt = new Date(Date.now() - 1000);
    db.update(reservations).set({ expiresAt: expiredAt }).run();

    const replay = createReservation(db, input);

    expect(replay.ok).toBe(true);

    if (!replay.ok) {
      return;
    }

    expect(replay.replayed).toBe(true);
    expect(replay.reservationId).toBe(first.reservationId);
    expect(replay.expiresAt).toBe(expiredAt.toISOString());
    expect(purchaseReservation(db, first.reservationId)).toEqual({
      ok: false,
      reason: "reservation_expired",
    });
  });

  test("replays a purchased reservation without issuing a second code", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const input = reservationInput({ idempotencyKey: "purchased-replay-key" });
    const first = createReservation(db, input);

    expect(first.ok).toBe(true);

    if (!first.ok) {
      return;
    }

    const purchased = purchaseReservation(db, first.reservationId);

    expect(purchased.ok).toBe(true);

    if (!purchased.ok) {
      return;
    }

    const replay = createReservation(db, input);

    expect(replay.ok).toBe(true);

    if (!replay.ok) {
      return;
    }

    expect(replay.replayed).toBe(true);
    expect(replay.reservationId).toBe(first.reservationId);
    expect(replay.expiresAt).toBe(first.expiresAt);
    expect(purchaseReservation(db, first.reservationId)).toEqual({
      ok: true,
      code: purchased.code,
    });
    expect(db.select().from(reservations).all()).toHaveLength(1);
  });

  test("treats payloads with reordered keys as the same request", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const key = "key-order-123";
    const first = createReservation(db, {
      eventId: duneEvent.id,
      seatId: "A2",
      customerName: "Ada Lovelace",
      email: "ada@example.com",
      idempotencyKey: key,
    });
    const second = createReservation(db, {
      email: "ada@example.com",
      customerName: "Ada Lovelace",
      seatId: "A2",
      eventId: duneEvent.id,
      idempotencyKey: key,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (!first.ok || !second.ok) {
      return;
    }

    expect(second.replayed).toBe(true);
    expect(second.reservationId).toBe(first.reservationId);
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(db.select().from(reservations).all()).toHaveLength(1);
  });

  test("rejects an idempotency key reused with a different payload", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const key = "reuse-key-123";

    expect(
      createReservation(db, reservationInput({ idempotencyKey: key })).ok,
    ).toBe(true);
    expect(
      createReservation(
        db,
        reservationInput({ idempotencyKey: key, seatId: "A3" }),
      ),
    ).toEqual({ ok: false, reason: "idempotency_key_reused" });

    expect(db.select().from(reservations).all()).toHaveLength(1);
  });

  test("expires idempotency keys after the retention window", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const key = "expired-key-123";
    const input = reservationInput({ idempotencyKey: key });

    expect(createReservation(db, input).ok).toBe(true);

    db.update(idempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) })
      .run();

    const second = createReservation(
      db,
      reservationInput({ idempotencyKey: key, seatId: "B2" }),
    );

    expect(second.ok).toBe(true);

    if (second.ok) {
      expect(second.replayed).toBe(false);
    }

    expect(db.select().from(reservations).all()).toHaveLength(2);
    expect(db.select().from(idempotencyKeys).all()).toHaveLength(1);
  });
});

describe("purchaseReservation", () => {
  test("issues a code for an active hold and marks it purchased", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const created = createReservation(db, reservationInput());

    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    const purchased = purchaseReservation(db, created.reservationId);

    expect(purchased.ok).toBe(true);

    if (!purchased.ok) {
      return;
    }

    expect(purchased.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);

    const stored = db.select().from(reservations).get();

    expect(stored?.status).toBe("purchased");
    expect(stored?.code).toBe(purchased.code);
    expect(stored?.purchasedAt).toBeInstanceOf(Date);
  });

  test("returns the same code when purchased again", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const created = createReservation(db, reservationInput());

    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    const first = purchaseReservation(db, created.reservationId);
    const second = purchaseReservation(db, created.reservationId);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(db.select().from(reservations).all()).toHaveLength(1);
  });

  test("rejects unknown reservation ids", () => {
    const db = createTestDb();
    seedTestEvents(db);

    expect(purchaseReservation(db, "missing-reservation")).toEqual({
      ok: false,
      reason: "reservation_not_found",
    });
  });

  test("rejects an expired hold and marks it expired", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const created = createReservation(db, reservationInput());

    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    expireReservations(db);

    expect(purchaseReservation(db, created.reservationId)).toEqual({
      ok: false,
      reason: "reservation_expired",
    });

    const stored = db.select().from(reservations).get();

    expect(stored?.status).toBe("expired");
    expect(stored?.code).toBeNull();
    expect(stored?.purchasedAt).toBeNull();
  });

  test("frees an expired seat for a new hold", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const first = createReservation(db, reservationInput());

    expect(first.ok).toBe(true);

    if (!first.ok) {
      return;
    }

    expireReservations(db);

    const second = createReservation(db, reservationInput());

    expect(second.ok).toBe(true);

    if (!second.ok) {
      return;
    }

    const rows = db.select().from(reservations).all();
    const firstRow = rows.find((row) => row.id === first.reservationId);
    const secondRow = rows.find((row) => row.id === second.reservationId);

    expect(rows).toHaveLength(2);
    expect(firstRow?.status).toBe("expired");
    expect(secondRow?.status).toBe("held");
  });

  test("keeps a purchased seat taken after the hold window", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const created = createReservation(db, reservationInput());

    expect(created.ok).toBe(true);

    if (!created.ok) {
      return;
    }

    const purchased = purchaseReservation(db, created.reservationId);

    expect(purchased.ok).toBe(true);

    if (!purchased.ok) {
      return;
    }

    expireReservations(db);

    expect(createReservation(db, reservationInput())).toEqual({
      ok: false,
      reason: "seat_taken",
    });
    expect(purchaseReservation(db, created.reservationId)).toEqual({
      ok: true,
      code: purchased.code,
    });
  });
});
