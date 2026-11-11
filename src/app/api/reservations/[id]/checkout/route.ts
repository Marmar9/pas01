import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";
import { startCheckout } from "@/lib/reservations";
import { getStripeCheckoutGateway } from "@/lib/stripe";
import { checkoutInputSchema, toFieldErrors } from "@/lib/validation";
import { getVoucherifyGateway } from "@/lib/voucherify";

async function readBody(request: Request): Promise<unknown> {
  const raw = await request.text();

  // The body is optional: an etap II client sends none.
  return raw.trim() === "" ? {} : JSON.parse(raw);
}

async function handler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: unknown;

  try {
    body = await readBody(request);
  } catch {
    return errorResponse(
      400,
      "VALIDATION_ERROR",
      "Request body must be valid JSON.",
    );
  }

  const parsed = checkoutInputSchema.safeParse(body);

  if (!parsed.success) {
    return errorResponse(
      400,
      "VALIDATION_ERROR",
      "Invalid checkout data.",
      toFieldErrors(parsed.error),
    );
  }

  try {
    const result = await startCheckout(
      getDb(),
      id,
      getStripeCheckoutGateway(),
      { points: parsed.data.points, loyalty: getVoucherifyGateway() },
    );

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
        case "points_limit_exceeded":
          return errorResponse(
            409,
            "POINTS_LIMIT_EXCEEDED",
            "Points can cover at most half of the ticket price.",
          );
        case "insufficient_points":
          return errorResponse(
            409,
            "INSUFFICIENT_POINTS",
            "Not enough loyalty points.",
          );
        case "checkout_in_progress":
          return errorResponse(
            409,
            "CHECKOUT_IN_PROGRESS",
            "A payment with a different points split is already open.",
          );
        case "loyalty_unavailable":
          return errorResponse(
            503,
            "LOYALTY_UNAVAILABLE",
            "The loyalty program is temporarily unavailable.",
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
