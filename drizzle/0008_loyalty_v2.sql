PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_loyalty_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text,
	`payment_id` text,
	`type` text NOT NULL,
	`points` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`voucherify_transaction_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "loyalty_operations_type_check" CHECK("__new_loyalty_operations"."type" in ('spend', 'earn', 'restore', 'welcome')),
	CONSTRAINT "loyalty_operations_status_check" CHECK("__new_loyalty_operations"."status" in ('pending', 'done', 'failed'))
);
--> statement-breakpoint
INSERT INTO `__new_loyalty_operations`("id", "reservation_id", "payment_id", "type", "points", "status", "voucherify_transaction_id", "created_at", "updated_at") SELECT "id", "reservation_id", "payment_id", "type", "points", "status", NULL, "created_at", "updated_at" FROM `loyalty_operations`;--> statement-breakpoint
DROP TABLE `loyalty_operations`;--> statement-breakpoint
ALTER TABLE `__new_loyalty_operations` RENAME TO `loyalty_operations`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `loyalty_operations_reservation_id_idx` ON `loyalty_operations` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `loyalty_operations_payment_id_idx` ON `loyalty_operations` (`payment_id`);