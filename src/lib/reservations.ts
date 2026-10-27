import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { reservations } from "@/db/schema";
import { getEvent } from "./events";
import { generateReservationCode } from "./reservation-code";
import { isSeatInLayout, parseSeatId } from "./validation";

export type CreateReservationInput = {
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
};

export type CreateReservationResult =
  | { ok: true; reservationId: string; code: string }
  | { ok: false; reason: "event_not_found" | "invalid_seat" | "seat_taken" };

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

export function createReservation(
  db: Db,
  input: CreateReservationInput,
): CreateReservationResult {
  const event = getEvent(db, input.eventId);

  if (!event) {
    return { ok: false, reason: "event_not_found" };
  }

  const seatId = input.seatId.trim().toUpperCase();
  const seat = parseSeatId(seatId);

  if (!seat || !isSeatInLayout(seat, event.rows, event.seatsPerRow)) {
    return { ok: false, reason: "invalid_seat" };
  }

  const existing = db
    .select({ id: reservations.id })
    .from(reservations)
    .where(
      and(
        eq(reservations.eventId, input.eventId),
        eq(reservations.seatId, seatId),
      ),
    )
    .get();

  if (existing) {
    return { ok: false, reason: "seat_taken" };
  }

  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
    const code = generateReservationCode();

    try {
      const inserted = db
        .insert(reservations)
        .values({
          id: crypto.randomUUID(),
          eventId: input.eventId,
          seatId,
          customerName: input.customerName,
          email: input.email,
          code,
        })
        .returning({ id: reservations.id, code: reservations.code })
        .get();

      return { ok: true, reservationId: inserted.id, code: inserted.code };
    } catch (error) {
      const constraint = findConstraintError(error);

      if (!constraint) {
        throw error;
      }

      if (constraint.message.includes("reservations.code")) {
        continue;
      }

      if (
        constraint.message.includes("reservations.event_id") ||
        constraint.message.includes("reservations.seat_id")
      ) {
        return { ok: false, reason: "seat_taken" };
      }

      throw error;
    }
  }

  throw new Error("Could not generate a unique reservation code.");
}
