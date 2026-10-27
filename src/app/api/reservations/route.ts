import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { createReservation } from "@/lib/reservations";
import { reservationInputSchema, toFieldErrors } from "@/lib/validation";

export async function POST(request: Request) {
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

  const result = createReservation(getDb(), parsed.data);

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
    }
  }

  return Response.json(
    { reservationId: result.reservationId, code: result.code },
    { status: 201 },
  );
}
