import { errorResponse } from "@/lib/api";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";

async function handler(_request: Request) {
  // Stripe is not connected yet. When it is, verify the Stripe-Signature
  // header against the raw body (`await request.text()` +
  // `stripe.webhooks.constructEvent`) before handling
  // `checkout.session.completed`. Refusing every event is deliberate: an
  // unverified webhook must never mark a reservation as paid.
  return errorResponse(
    501,
    "NOT_IMPLEMENTED",
    "Stripe webhooks are not configured yet.",
  );
}

export const POST = rateLimited(handler, RATE_LIMITS.webhook);
