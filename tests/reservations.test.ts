import { describe, expect, test } from "bun:test";
import { idempotencyKeys, reservations } from "@/db/schema";
import { createReservation } from "@/lib/reservations";
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

describe("createReservation", () => {
  test("creates a reservation with a generated code", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = createReservation(db, reservationInput());

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.replayed).toBe(false);
    expect(result.reservationId).toBeTruthy();
    expect(result.code).toMatch(/^[A-Z2-9]{8}$/);

    const stored = db.select().from(reservations).all();

    expect(stored).toHaveLength(1);
    expect(stored[0].seatId).toBe("A2");
    expect(stored[0].code).toBe(result.code);
  });

  test("normalizes the seat id to uppercase", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = createReservation(db, reservationInput({ seatId: "b7" }));

    expect(result.ok).toBe(true);
    expect(db.select().from(reservations).get()?.seatId).toBe("B7");
  });

  test("rejects a seat that is already taken", () => {
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
    expect(second.code).toBe(first.code);

    expect(db.select().from(reservations).all()).toHaveLength(1);
    expect(db.select().from(idempotencyKeys).all()).toHaveLength(1);
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
    expect(second.code).toBe(first.code);
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
