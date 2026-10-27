import { connection } from "next/server";
import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { getEventWithTakenSeats } from "@/lib/events";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";

async function handler(
  _request: Request,
  context: RouteContext<"/api/events/[id]">,
) {
  await connection();

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

export const GET = rateLimited(handler, RATE_LIMITS.event);
