import { resolve } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createDb } from "./client";

const db = createDb();

migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });

console.log("Migrations applied.");
