import { connection } from "next/server";
import { getDb } from "@/db/client";
import { errorResponse, rateLimitResponse } from "@/lib/api";
import { listEvents } from "@/lib/events";
import { checkRateLimit, getClientIp, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET(request: Request) {
  // better-sqlite3 is synchronous: without this, Cache Components would
  // prerender the response (and its data) at build time.
  await connection();

  const rateLimit = checkRateLimit(
    `${getClientIp(request)}:events`,
    RATE_LIMITS.events,
  );

  if (!rateLimit.allowed) {
    return rateLimitResponse(rateLimit);
  }

  try {
    return Response.json({ events: listEvents(getDb()) });
  } catch (error) {
    console.error("Failed to list events:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}
