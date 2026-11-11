CREATE TABLE `loyalty_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`reservation_id` text NOT NULL,
	`payment_id` text,
	`type` text NOT NULL,
	`points` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "loyalty_operations_type_check" CHECK("loyalty_operations"."type" in ('spend', 'earn', 'restore')),
	CONSTRAINT "loyalty_operations_status_check" CHECK("loyalty_operations"."status" in ('pending', 'done', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `loyalty_operations_reservation_id_idx` ON `loyalty_operations` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `loyalty_operations_payment_id_idx` ON `loyalty_operations` (`payment_id`);--> statement-breakpoint
ALTER TABLE `payments` ADD `points_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `points_used` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `points_earned` integer;