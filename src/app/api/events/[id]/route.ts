import { connection } from "next/server";
import { getDb } from "@/db/client";
import { errorResponse, rateLimitResponse } from "@/lib/api";
import { getEventWithTakenSeats } from "@/lib/events";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET(
  request: Request,
  context: RouteContext<"/api/events/[id]">,
) {
  await connection();

  const rateLimit = checkRateLimit(
    `${getClientIp(request)}:event`,
    RATE_LIMITS.event,
  );

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit);
  }

  const { id } = await context.params;

  try {
    const result = getEventWithTakenSeats(getDb(), id);

    if (!result) {
      return errorResponse(404, "EVENT_NOT_FOUND", "Event not found.");
    }

    return Response.json(result);
  } catch (error) {
    console.error("Failed to load event:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}
