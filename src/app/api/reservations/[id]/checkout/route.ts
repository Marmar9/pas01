import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";
import { startCheckout } from "@/lib/reservations";
import { getStripeCheckoutGateway } from "@/lib/stripe";

async function handler(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  try {
    const result = await startCheckout(getDb(), id, getStripeCheckoutGateway());

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
        case "reservation_already_paid":
          return errorResponse(
            409,
            "RESERVATION_ALREADY_PAID",
            "Reservation is already paid.",
          );
        case "payment_unavailable":
          return errorResponse(
            503,
            "PAYMENT_UNAVAILABLE",
            "Online payments are temporarily unavailable.",
          );
      }
    }

    return Response.json({ url: result.url });
  } catch (error) {
    console.error("Failed to start checkout:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export const POST = rateLimited(handler, RATE_LIMITS.checkout);
