CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`task` text NOT NULL,
	`input` text NOT NULL,
	`visible_at` integer NOT NULL,
	`total_tried` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`has_error` integer DEFAULT false NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_ready_idx` ON `jobs` (`completed_at`,`has_error`,`visible_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`stripe_checkout_session_id` text NOT NULL,
	`stripe_payment_intent_id` text,
	`checkout_url` text,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'pln' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`stripe_refund_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "payments_status_check" CHECK("__new_payments"."status" in ('pending', 'paid', 'failed', 'expired', 'refunded'))
);
--> statement-breakpoint
INSERT INTO `__new_payments`("id", "reservation_id", "stripe_checkout_session_id", "stripe_payment_intent_id", "checkout_url", "amount", "currency", "status", "created_at", "updated_at") SELECT "id", "reservation_id", "stripe_checkout_session_id", "stripe_payment_intent_id", "checkout_url", "amount", "currency", "status", "created_at", "updated_at" FROM `payments`;--> statement-breakpoint
DROP TABLE `payments`;--> statement-breakpoint
ALTER TABLE `__new_payments` RENAME TO `payments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `payments_checkout_session_unique` ON `payments` (`stripe_checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_pending_reservation_unique` ON `payments` (`reservation_id`) WHERE "payments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `payments_reservation_id_idx` ON `payments` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `payments_status_created_at_idx` ON `payments` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `__new_stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`outcome` text DEFAULT 'processed' NOT NULL,
	`failure_reason` text,
	`processed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "stripe_events_outcome_check" CHECK("__new_stripe_events"."outcome" in ('processed', 'ignored', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_stripe_events`("id", "type", "processed_at") SELECT "id", "type", "processed_at" FROM `stripe_events`;--> statement-breakpoint
DROP TABLE `stripe_events`;--> statement-breakpoint
ALTER TABLE `__new_stripe_events` RENAME TO `stripe_events`;--> statement-breakpoint
CREATE INDEX `stripe_events_outcome_processed_at_idx` ON `stripe_events` (`outcome`,`processed_at`);