import { and, asc, eq, gt, or } from "drizzle-orm";
import type { Db } from "@/db/client";
import { type EventRow, events, reservations } from "@/db/schema";

export type EventDto = {
  id: string;
  title: string;
  description: string;
  venue: string;
  startsAt: string;
  rows: number;
  seatsPerRow: number;
};

export type EventWithTakenSeats = {
  event: EventDto;
  takenSeats: string[];
};

export function toEventDto(event: EventRow): EventDto {
  return {
    id: event.id,
    title: event.title,
    description: event.description,
    venue: event.venue,
    startsAt: event.startsAt.toISOString(),
    rows: event.rows,
    seatsPerRow: event.seatsPerRow,
  };
}

export function listEvents(db: Db): EventDto[] {
  return db
    .select()
    .from(events)
    .orderBy(asc(events.startsAt))
    .all()
    .map(toEventDto);
}

export function getEvent(db: Db, eventId: string): EventRow | null {
  return db.select().from(events).where(eq(events.id, eventId)).get() ?? null;
}

export function listTakenSeats(db: Db, eventId: string): string[] {
  const now = new Date();

  return db
    .select({ seatId: reservations.seatId })
    .from(reservations)
    .where(
      and(
        eq(reservations.eventId, eventId),
        or(
          eq(reservations.status, "purchased"),
          and(eq(reservations.status, "held"), gt(reservations.expiresAt, now)),
        ),
      ),
    )
    .all()
    .map((reservation) => reservation.seatId)
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );
}

export function getEventWithTakenSeats(
  db: Db,
  eventId: string,
): EventWithTakenSeats | null {
  const event = getEvent(db, eventId);

  if (!event) {
    return null;
  }

  return {
    event: toEventDto(event),
    takenSeats: listTakenSeats(db, eventId),
  };
}
