import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

export const DEFAULT_DATABASE_PATH = "data/cinema.db";

export function resolveDatabasePath(path?: string): string {
  const databasePath =
    path ?? process.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

  return databasePath === ":memory:"
    ? databasePath
    : resolve(/* turbopackIgnore: true */ process.cwd(), databasePath);
}

export function createDb(path?: string): Db {
  const databasePath = resolveDatabasePath(path);

  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  return drizzle(sqlite, { schema });
}

const globalForDb = globalThis as typeof globalThis & {
  cinemaDb?: Db;
};

/**
 * Lazily opens the database so `next build` never creates it while
 * prerendering GET route handlers.
 */
export function getDb(): Db {
  globalForDb.cinemaDb ??= createDb();
  return globalForDb.cinemaDb;
}
