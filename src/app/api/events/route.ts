import { connection } from "next/server";
import { getDb } from "@/db/client";
import { listEvents } from "@/lib/events";

export async function GET() {
  // better-sqlite3 is synchronous: without this, Cache Components would
  // prerender the response (and its data) at build time.
  await connection();

  return Response.json({ events: listEvents(getDb()) });
}
