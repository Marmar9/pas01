import { describe, expect, test } from "bun:test";
import { reservations } from "@/db/schema";
import {
  getEvent,
  getEventWithTakenSeats,
  listEvents,
  listTakenSeats,
} from "@/lib/events";
import { createTestDb, duneEvent, seedTestEvents } from "./helpers";

const HOLD_TTL_MS = 15 * 60 * 1000;

function futureHold() {
  return new Date(Date.now() + HOLD_TTL_MS);
}

describe("events service", () => {
  test("lists events ordered by start date", () => {
    const db = createTestDb();
    seedTestEvents(db);

    const result = listEvents(db);

    expect(result).toHaveLength(2);
    expect(result.map((event) => event.id)).toEqual([
      "event-interstellar",
      "event-dune",
    ]);
    expect(result[1]).toEqual({
      id: duneEvent.id,
      title: duneEvent.title,
      description: duneEvent.description,
      venue: duneEvent.venue,
      startsAt: duneEvent.startsAt.toISOString(),
      rows: duneEvent.rows,
      seatsPerRow: duneEvent.seatsPerRow,
    });
  });

  test("returns an event with its taken seats in natural order", () => {
    const db = createTestDb();
    seedTestEvents(db);

    db.insert(reservations)
      .values([
        {
          id: "reservation-1",
          eventId: duneEvent.id,
          seatId: "A10",
          customerName: "Ada",
          email: "ada@example.com",
          code: null,
          status: "held",
          expiresAt: futureHold(),
        },
        {
          id: "reservation-2",
          eventId: duneEvent.id,
          seatId: "A2",
          customerName: "Bob",
          email: "bob@example.com",
          code: "CODE0002",
          status: "purchased",
          expiresAt: new Date(Date.now() - 1000),
          purchasedAt: new Date(Date.now() - 2000),
        },
      ])
      .run();

    const result = getEventWithTakenSeats(db, duneEvent.id);

    expect(result?.event.id).toBe(duneEvent.id);
    expect(result?.takenSeats).toEqual(["A2", "A10"]);
  });

  test("excludes expired and stale holds from taken seats", () => {
    const db = createTestDb();
    seedTestEvents(db);

    db.insert(reservations)
      .values([
        {
          id: "expired-status",
          eventId: duneEvent.id,
          seatId: "B1",
          customerName: "Ada",
          email: "ada@example.com",
          code: null,
          status: "expired",
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          id: "stale-held",
          eventId: duneEvent.id,
          seatId: "B2",
          customerName: "Bob",
          email: "bob@example.com",
          code: null,
          status: "held",
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          id: "active-held",
          eventId: duneEvent.id,
          seatId: "B3",
          customerName: "Cara",
          email: "cara@example.com",
          code: null,
          status: "held",
          expiresAt: futureHold(),
        },
      ])
      .run();

    expect(listTakenSeats(db, duneEvent.id)).toEqual(["B3"]);
  });

  test("returns null for unknown events", () => {
    const db = createTestDb();
    seedTestEvents(db);

    expect(getEvent(db, "missing")).toBeNull();
    expect(getEventWithTakenSeats(db, "missing")).toBeNull();
    expect(listTakenSeats(db, "missing")).toEqual([]);
  });
});
