import { errorResponse } from "@/lib/api";
import { getLoyaltyBalance } from "@/lib/loyalty";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";
import { emailSchema, toFieldErrors } from "@/lib/validation";
import { getVoucherifyGateway } from "@/lib/voucherify";

async function handler(request: Request) {
  const parsed = emailSchema.safeParse(
    new URL(request.url).searchParams.get("email") ?? "",
  );

  if (!parsed.success) {
    return errorResponse(400, "VALIDATION_ERROR", "Invalid email address.", {
      email: toFieldErrors(parsed.error)._root ?? "Email is invalid.",
    });
  }

  const gateway = getVoucherifyGateway();

  if (!gateway) {
    return errorResponse(
      503,
      "LOYALTY_UNAVAILABLE",
      "The loyalty program is temporarily unavailable.",
    );
  }

  try {
    const points = await getLoyaltyBalance(gateway, parsed.data);

    return Response.json({ email: parsed.data, points });
  } catch (error) {
    // Never log the email or balance.
    console.error(
      "Failed to read a loyalty balance:",
      error instanceof Error ? error.message : "unknown error",
    );
    return errorResponse(
      503,
      "LOYALTY_UNAVAILABLE",
      "The loyalty program is temporarily unavailable.",
    );
  }
}

export const GET = rateLimited(handler, RATE_LIMITS.loyalty);
