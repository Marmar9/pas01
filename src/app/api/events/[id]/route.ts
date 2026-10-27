import { connection } from "next/server";
import { getDb } from "@/db/client";
import { errorResponse } from "@/lib/api";
import { getEventWithTakenSeats } from "@/lib/events";

export async function GET(
  _request: Request,
  context: RouteContext<"/api/events/[id]">,
) {
  await connection();

  const { id } = await context.params;
  const result = getEventWithTakenSeats(getDb(), id);

  if (!result) {
    return errorResponse(404, "EVENT_NOT_FOUND", "Event not found.");
  }

  return Response.json(result);
}
