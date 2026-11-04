CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`stripe_checkout_session_id` text NOT NULL,
	`stripe_payment_intent_id` text,
	`checkout_url` text,
	`amount` integer NOT NULL,
	`currency` text DEFAULT 'pln' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "payments_status_check" CHECK("payments"."status" in ('pending', 'paid', 'failed', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_checkout_session_unique` ON `payments` (`stripe_checkout_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payments_pending_reservation_unique` ON `payments` (`reservation_id`) WHERE "payments"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `payments_reservation_id_idx` ON `payments` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `payments_status_created_at_idx` ON `payments` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`processed_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
