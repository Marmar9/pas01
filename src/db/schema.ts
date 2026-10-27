import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  venue: text("venue").notNull().default(""),
  startsAt: integer("starts_at", { mode: "timestamp_ms" }).notNull(),
  rows: integer("rows").notNull(),
  seatsPerRow: integer("seats_per_row").notNull(),
});

export const reservations = sqliteTable(
  "reservations",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    seatId: text("seat_id").notNull(),
    customerName: text("customer_name").notNull(),
    email: text("email").notNull(),
    code: text("code").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("reservations_event_seat_unique").on(
      table.eventId,
      table.seatId,
    ),
    uniqueIndex("reservations_code_unique").on(table.code),
    index("reservations_event_id_idx").on(table.eventId),
  ],
);

export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [index("idempotency_keys_created_at_idx").on(table.createdAt)],
);

export type EventRow = typeof events.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
