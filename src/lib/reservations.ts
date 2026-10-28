import { and, eq, lt } from "drizzle-orm";
import objectHash from "object-hash";
import type { Db } from "@/db/client";
import { events, idempotencyKeys, reservations } from "@/db/schema";
import { generateReservationCode } from "./reservation-code";
import { isSeatInLayout, parseSeatId } from "./validation";

export type CreateReservationInput = {
  eventId: string;
  seatId: string;
  customerName: string;
  email: string;
  idempotencyKey: string;
};

export type CreateReservationResult =
  | { ok: true; reservationId: string; code: string; replayed: boolean }
  | {
      ok: false;
      reason:
        | "event_not_found"
        | "invalid_seat"
        | "seat_taken"
        | "idempotency_key_reused";
    };

const MAX_CODE_ATTEMPTS = 5;
const IDEMPOTENCY_KEY_TTL_MS = 24 * 60 * 60 * 1000;

type NormalizedInput = Omit<CreateReservationInput, "idempotencyKey">;

type SqliteConstraintError = {
  code: string;
  message: string;
};

function normalizeInput(input: CreateReservationInput): NormalizedInput {
  return {
    eventId: input.eventId.trim(),
    seatId: input.seatId.trim().toUpperCase(),
    customerName: input.customerName.trim(),
    email: input.email.trim().toLowerCase(),
  };
}

function hashReservationRequest(input: NormalizedInput): string {
  return objectHash(
    {
      eventId: input.eventId,
      seatId: input.seatId,
      customerName: input.customerName,
      email: input.email,
    },
    { algorithm: "sha256", encoding: "hex" },
  );
}

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

function replayExistingKey(
  db: Db,
  key: string,
  requestHash: string,
): CreateReservationResult {
  const existingKey = db
    .select()
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key))
    .get();

  if (!existingKey) {
    throw new Error("Idempotency key conflict could not be resolved.");
  }

  if (existingKey.requestHash !== requestHash) {
    return { ok: false, reason: "idempotency_key_reused" };
  }

  const reservation = db
    .select()
    .from(reservations)
    .where(eq(reservations.id, existingKey.reservationId))
    .get();

  if (!reservation) {
    throw new Error("Idempotency key points at a missing reservation.");
  }

  return {
    ok: true,
    reservationId: reservation.id,
    code: reservation.code,
    replayed: true,
  };
}

export function createReservation(
  db: Db,
  input: CreateReservationInput,
): CreateReservationResult {
  const normalized = normalizeInput(input);
  const requestHash = hashReservationRequest(normalized);
  const expiresBefore = new Date(Date.now() - IDEMPOTENCY_KEY_TTL_MS);

  try {
    // BEGIN IMMEDIATE takes the write lock before the reads, so competing
    // writers (even across processes) queue on busy_timeout instead of
    // failing to upgrade a stale read snapshot with SQLITE_BUSY_SNAPSHOT.
    return db.transaction(
      (tx) => {
        tx.delete(idempotencyKeys)
          .where(lt(idempotencyKeys.createdAt, expiresBefore))
          .run();

        const existingKey = tx
          .select()
          .from(idempotencyKeys)
          .where(eq(idempotencyKeys.key, input.idempotencyKey))
          .get();

        if (existingKey) {
          if (existingKey.requestHash !== requestHash) {
            return { ok: false, reason: "idempotency_key_reused" };
          }

          const reservation = tx
            .select()
            .from(reservations)
            .where(eq(reservations.id, existingKey.reservationId))
            .get();

          if (reservation) {
            return {
              ok: true,
              reservationId: reservation.id,
              code: reservation.code,
              replayed: true,
            };
          }

          tx.delete(idempotencyKeys)
            .where(eq(idempotencyKeys.key, existingKey.key))
            .run();
        }

        const event = tx
          .select()
          .from(events)
          .where(eq(events.id, normalized.eventId))
          .get();

        if (!event) {
          return { ok: false, reason: "event_not_found" };
        }

        const seat = parseSeatId(normalized.seatId);

        if (!seat || !isSeatInLayout(seat, event.rows, event.seatsPerRow)) {
          return { ok: false, reason: "invalid_seat" };
        }

        const taken = tx
          .select({ id: reservations.id })
          .from(reservations)
          .where(
            and(
              eq(reservations.eventId, normalized.eventId),
              eq(reservations.seatId, normalized.seatId),
            ),
          )
          .get();

        if (taken) {
          return { ok: false, reason: "seat_taken" };
        }

        for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt += 1) {
          const code = generateReservationCode();

          try {
            const inserted = tx
              .insert(reservations)
              .values({
                id: crypto.randomUUID(),
                eventId: normalized.eventId,
                seatId: normalized.seatId,
                customerName: normalized.customerName,
                email: normalized.email,
                code,
              })
              .returning({ id: reservations.id, code: reservations.code })
              .get();

            tx.insert(idempotencyKeys)
              .values({
                key: input.idempotencyKey,
                requestHash,
                reservationId: inserted.id,
              })
              .run();

            return {
              ok: true,
              reservationId: inserted.id,
              code: inserted.code,
              replayed: false,
            };
          } catch (error) {
            const constraint = findConstraintError(error);

            if (!constraint) {
              throw error;
            }

            if (constraint.message.includes("reservations.code")) {
              continue;
            }

            throw error;
          }
        }

        throw new Error("Could not generate a unique reservation code.");
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    const constraint = findConstraintError(error);

    if (constraint?.message.includes("idempotency_keys.key")) {
      return replayExistingKey(db, input.idempotencyKey, requestHash);
    }

    if (
      constraint &&
      (constraint.message.includes("reservations.event_id") ||
        constraint.message.includes("reservations.seat_id"))
    ) {
      return { ok: false, reason: "seat_taken" };
    }

    throw error;
  }
}
