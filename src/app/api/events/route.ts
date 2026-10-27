import { connection } from "next/server";
import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { listEvents } from "@/lib/events";
import { RATE_LIMITS, rateLimited } from "@/lib/rate-limit";

async function handler(_request: Request) {
  // better-sqlite3 is synchronous: without this, Cache Components would
  // prerender the response (and its data) at build time.
  await connection();

  try {
    return Response.json({ events: listEvents(getDb()) });
  } catch (error) {
    console.error("Failed to list events:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Unexpected server error.");
  }
}

export const GET = rateLimited(handler, RATE_LIMITS.events);
