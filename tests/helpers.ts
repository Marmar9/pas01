import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb, type Db } from "@/db/client";
import { events } from "@/db/schema";

export function createTestDb(): Db {
  const db = createDb(":memory:");

  migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });

  return db;
}

export const duneEvent = {
  id: "event-dune",
  title: "Dune: Part Three",
  description: "Desert power.",
  venue: "Hall 1",
  startsAt: new Date("2026-11-05T18:00:00.000Z"),
  rows: 10,
  seatsPerRow: 14,
};

export const interstellarEvent = {
  id: "event-interstellar",
  title: "Interstellar",
  description: "Beyond the stars.",
  venue: "Hall 2",
  startsAt: new Date("2026-11-04T18:00:00.000Z"),
  rows: 8,
  seatsPerRow: 12,
};

export function seedTestEvents(db: Db): void {
  db.insert(events).values([duneEvent, interstellarEvent]).run();
}
