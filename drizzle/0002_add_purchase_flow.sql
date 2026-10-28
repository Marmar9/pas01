PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`seat_id` text NOT NULL,
	`customer_name` text NOT NULL,
	`email` text NOT NULL,
	`code` text,
	`status` text DEFAULT 'held' NOT NULL,
	`expires_at` integer NOT NULL,
	`purchased_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reservations_status_check" CHECK("__new_reservations"."status" in ('held', 'purchased', 'expired'))
);
--> statement-breakpoint
INSERT INTO `__new_reservations`("id", "event_id", "seat_id", "customer_name", "email", "code", "status", "expires_at", "purchased_at", "created_at")
SELECT "id", "event_id", "seat_id", "customer_name", "email", "code", 'purchased', "created_at" + 900000, "created_at", "created_at" FROM `reservations`;--> statement-breakpoint
CREATE TEMP TABLE `__idempotency_keys_backup` AS SELECT * FROM `idempotency_keys`;--> statement-breakpoint
DROP TABLE `reservations`;--> statement-breakpoint
ALTER TABLE `__new_reservations` RENAME TO `reservations`;--> statement-breakpoint
DELETE FROM `idempotency_keys`;--> statement-breakpoint
INSERT INTO `idempotency_keys`("key", "request_hash", "reservation_id", "created_at")
SELECT "key", "request_hash", "reservation_id", "created_at" FROM `__idempotency_keys_backup`;--> statement-breakpoint
DROP TABLE `__idempotency_keys_backup`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_event_seat_unique` ON `reservations` (`event_id`,`seat_id`) WHERE "reservations"."status" <> 'expired';--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_code_unique` ON `reservations` (`code`);--> statement-breakpoint
CREATE INDEX `reservations_event_id_idx` ON `reservations` (`event_id`);--> statement-breakpoint
CREATE INDEX `reservations_status_expires_at_idx` ON `reservations` (`status`,`expires_at`);
