import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";
import { purchaseReservation } from "@/lib/reservations";

async function handler(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const result = purchaseReservation(getDb(), id);

    if (!result.ok) {
      switch (result.reason) {
        case "reservation_not_found":
          return errorResponse(
            404,
            "RESERVATION_NOT_FOUND",
            "Reservation not found.",
          );
        case "reservation_expired":
          return errorResponse(
            410,
            "RESERVATION_EXPIRED",
            "Reservation has expired.",
          );
      }
    }

    return Response.json({ code: result.code });
  } catch (error) {
    console.error("Failed to purchase reservation:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export const POST = rateLimited(handler, RATE_LIMITS.purchase);
