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
  // Price per seat in grosze (3200 = 32 zł).
  price: integer("price").notNull().default(3200),
});

export const RESERVATION_STATUSES = ["held", "paid", "expired"] as const;
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
    // Price captured at reservation time, in grosze.
    amount: integer("amount").notNull().default(0),
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
      sql`${table.status} in ('held', 'paid', 'expired')`,
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

export const PAYMENT_STATUSES = [
  "pending",
  "paid",
  "failed",
  "expired",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    stripeCheckoutSessionId: text("stripe_checkout_session_id").notNull(),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    checkoutUrl: text("checkout_url"),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull().default("pln"),
    status: text("status").$type<PaymentStatus>().notNull().default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    uniqueIndex("payments_checkout_session_unique").on(
      table.stripeCheckoutSessionId,
    ),
    // At most one open payment attempt per reservation, so concurrent checkout
    // requests cannot create two chargeable sessions.
    uniqueIndex("payments_pending_reservation_unique")
      .on(table.reservationId)
      .where(sql`${table.status} = 'pending'`),
    index("payments_reservation_id_idx").on(table.reservationId),
    index("payments_status_created_at_idx").on(table.status, table.createdAt),
    check(
      "payments_status_check",
      sql`${table.status} in ('pending', 'paid', 'failed', 'expired')`,
    ),
  ],
);

export const stripeEvents = sqliteTable("stripe_events", {
  id: text("id").primaryKey(),
  type: text("type").notNull(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type EventRow = typeof events.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type StripeEventRow = typeof stripeEvents.$inferSelect;
