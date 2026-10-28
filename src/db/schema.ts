import { sql } from "drizzle-orm";
import {
  check,
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

export const RESERVATION_STATUSES = ["held", "purchased", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

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
    code: text("code"),
    status: text("status").$type<ReservationStatus>().notNull().default("held"),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    purchasedAt: integer("purchased_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    // Expired holds stay in the table (so purchase can report 410 and
    // idempotent replays keep working) but must not block the seat.
    uniqueIndex("reservations_event_seat_unique")
      .on(table.eventId, table.seatId)
      .where(sql`${table.status} <> 'expired'`),
    uniqueIndex("reservations_code_unique").on(table.code),
    index("reservations_event_id_idx").on(table.eventId),
    index("reservations_status_expires_at_idx").on(
      table.status,
      table.expiresAt,
    ),
    check(
      "reservations_status_check",
      sql`${table.status} in ('held', 'purchased', 'expired')`,
    ),
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
