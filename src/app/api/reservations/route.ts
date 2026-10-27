import { getDb } from "@/db/client";
import { errorResponse, rateLimitResponse } from "@/lib/api";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";
import { createReservation } from "@/lib/reservations";
import {
  idempotencyKeySchema,
  reservationInputSchema,
  toFieldErrors,
} from "@/lib/validation";

export async function POST(request: Request) {
  const rateLimit = checkRateLimit(
    `${getClientIp(request)}:reservations`,
    RATE_LIMITS.reservations,
  );

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse(
      400,
      "VALIDATION_ERROR",
      "Request body must be valid JSON.",
    );
  }

  const parsed = reservationInputSchema.safeParse(body);

  if (!parsed.success) {
    return errorResponse(
      400,
      "VALIDATION_ERROR",
      "Invalid reservation data.",
      toFieldErrors(parsed.error),
    );
  }

  const rawIdempotencyKey = request.headers.get("idempotency-key");

  if (!rawIdempotencyKey) {
    return errorResponse(
      400,
      "VALIDATION_ERROR",
      "Missing Idempotency-Key header.",
      { "Idempotency-Key": "Idempotency-Key header is required." },
    );
  }

  const idempotencyKey = idempotencyKeySchema.safeParse(rawIdempotencyKey);

  if (!idempotencyKey.success) {
    return errorResponse(
      400,
      "VALIDATION_ERROR",
      "Invalid Idempotency-Key header.",
      {
        "Idempotency-Key":
          idempotencyKey.error.issues[0]?.message ??
          "Idempotency key is invalid.",
      },
    );
  }

  try {
    const result = createReservation(getDb(), {
      ...parsed.data,
      idempotencyKey: idempotencyKey.data,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "event_not_found":
          return errorResponse(404, "EVENT_NOT_FOUND", "Event not found.");
        case "invalid_seat":
          return errorResponse(
            400,
            "VALIDATION_ERROR",
            "Seat does not exist for this event.",
            { seatId: "Seat is outside this event's seating layout." },
          );
        case "seat_taken":
          return errorResponse(
            409,
            "SEAT_TAKEN",
            "Seat is already reserved for this event.",
          );
        case "idempotency_key_reused":
          return errorResponse(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency-Key was already used with a different payload.",
          );
      }
    }

    return Response.json(
      { reservationId: result.reservationId, code: result.code },
      {
        status: 201,
        headers: result.replayed
          ? { "Idempotency-Replayed": "true" }
          : undefined,
      },
    );
  } catch (error) {
    console.error("Failed to create reservation:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}
