import { describe, expect, test } from "bun:test";
import { reservations } from "@/db/schema";
import { createReservation } from "@/lib/reservations";
import { createTestDb, duneEvent, seedTestEvents } from "./helpers";

function reservationInput(overrides: Record<string, string> = {}) {
  return {
    eventId: duneEvent.id,
    seatId: "A2",
    customerName: "Ada Lovelace",
    email: "ada@example.com",
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
});
