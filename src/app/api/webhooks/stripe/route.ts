import Stripe from "stripe";
import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { processStripeEvent } from "@/lib/payments";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";
import { getStripeWebhookSecret } from "@/lib/stripe";

async function handler(request: Request) {
  const webhookSecret = getStripeWebhookSecret();

  if (!webhookSecret) {
    return errorResponse(
      503,
      "PAYMENT_UNAVAILABLE",
      "Stripe webhooks are not configured.",
    );
  }

  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return errorResponse(
      400,
      "INVALID_SIGNATURE",
      "Missing Stripe-Signature header.",
    );
  }

  // Stripe signs the exact bytes it sent, so the raw body is required.
  const payload = await request.text();
  let event: Stripe.Event;

  try {
    // Bun resolves Stripe's worker build, whose crypto is async-only, so the
    // async verifier is required. It performs the same signature check.
    event = await Stripe.webhooks.constructEventAsync(
      payload,
      signature,
      webhookSecret,
    );
  } catch (error) {
    console.error("Rejected Stripe webhook with an invalid signature:", error);
    return errorResponse(
      400,
      "INVALID_SIGNATURE",
      "Stripe webhook signature is invalid.",
    );
  }

  try {
    const result = processStripeEvent(getDb(), event);

    if (!result.ok) {
      console.warn(
        `Stripe webhook ${event.id} (${event.type}) was not applied: ${result.reason}`,
      );

      // Stripe retries non-2xx responses. Permanent business mismatches are
      // acknowledged so they do not loop forever; they still need an alert.
      if (result.permanent) {
        return Response.json({ received: true, ignored: true });
      }

      return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
    }

    return Response.json({
      received: true,
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(result.ignored ? { ignored: true } : {}),
    });
  } catch (error) {
    console.error("Failed to process Stripe webhook:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export const POST = rateLimited(handler, RATE_LIMITS.webhook);
