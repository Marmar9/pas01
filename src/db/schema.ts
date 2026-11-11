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
    // Points spent on the current/locked checkout attempt (1 point = 1 grosz).
    pointsUsed: integer("points_used").notNull().default(0),
    // Set exactly once, when the webhook marks the reservation paid.
    pointsEarned: integer("points_earned"),
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
  "refunded",
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
    // Card amount of this session: reservation.amount - pointsUsed.
    amount: integer("amount").notNull(),
    // Points reserved for this specific Checkout Session.
    pointsUsed: integer("points_used").notNull().default(0),
    currency: text("currency").notNull().default("pln"),
    status: text("status").$type<PaymentStatus>().notNull().default("pending"),
    stripeRefundId: text("stripe_refund_id"),
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
      sql`${table.status} in ('pending', 'paid', 'failed', 'expired', 'refunded')`,
    ),
  ],
);

export const STRIPE_EVENT_OUTCOMES = [
  "processed",
  "ignored",
  "failed",
] as const;
export type StripeEventOutcome = (typeof STRIPE_EVENT_OUTCOMES)[number];

// Inbox of handled Stripe webhook events. Rows with outcome "failed" are the
// dead-letter record for human review and are never pruned.
export const stripeEvents = sqliteTable(
  "stripe_events",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    outcome: text("outcome")
      .$type<StripeEventOutcome>()
      .notNull()
      .default("processed"),
    failureReason: text("failure_reason"),
    processedAt: integer("processed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("stripe_events_outcome_processed_at_idx").on(
      table.outcome,
      table.processedAt,
    ),
    check(
      "stripe_events_outcome_check",
      sql`${table.outcome} in ('processed', 'ignored', 'failed')`,
    ),
  ],
);

export const LOYALTY_OPERATION_TYPES = ["spend", "earn", "restore"] as const;
export type LoyaltyOperationType = (typeof LOYALTY_OPERATION_TYPES)[number];

export const LOYALTY_OPERATION_STATUSES = [
  "pending",
  "done",
  "failed",
] as const;
export type LoyaltyOperationStatus =
  (typeof LOYALTY_OPERATION_STATUSES)[number];

// Local record of every Voucherify balance mutation. The id is the sourceId
// sent to Voucherify, so retries are idempotent. It is never a balance source.
export const loyaltyOperations = sqliteTable(
  "loyalty_operations",
  {
    id: text("id").primaryKey(),
    reservationId: text("reservation_id")
      .notNull()
      .references(() => reservations.id, { onDelete: "cascade" }),
    // No foreign key: a spend is recorded before its payment row exists.
    paymentId: text("payment_id"),
    type: text("type").$type<LoyaltyOperationType>().notNull(),
    points: integer("points").notNull(),
    status: text("status")
      .$type<LoyaltyOperationStatus>()
      .notNull()
      .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("loyalty_operations_reservation_id_idx").on(table.reservationId),
    index("loyalty_operations_payment_id_idx").on(table.paymentId),
    check(
      "loyalty_operations_type_check",
      sql`${table.type} in ('spend', 'earn', 'restore')`,
    ),
    check(
      "loyalty_operations_status_check",
      sql`${table.status} in ('pending', 'done', 'failed')`,
    ),
  ],
);

export const JOB_TASKS = [
  "refund-payment",
  "credit-points",
  "restore-points",
  "send-ticket-email",
] as const;
export type JobTask = (typeof JOB_TASKS)[number];

// Outbox / background job queue (E06, E07). A job is hidden until visibleAt,
// acked by completedAt and dead-lettered by hasError.
export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    task: text("task").$type<JobTask>().notNull(),
    input: text("input", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull(),
    visibleAt: integer("visible_at", { mode: "timestamp_ms" }).notNull(),
    totalTried: integer("total_tried").notNull().default(0),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    hasError: integer("has_error", { mode: "boolean" })
      .notNull()
      .default(false),
    lastError: text("last_error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [
    index("jobs_ready_idx").on(
      table.completedAt,
      table.hasError,
      table.visibleAt,
    ),
  ],
);

export type EventRow = typeof events.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;
export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;
export type StripeEventRow = typeof stripeEvents.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type LoyaltyOperationRow = typeof loyaltyOperations.$inferSelect;
