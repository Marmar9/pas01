CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`venue` text DEFAULT '' NOT NULL,
	`starts_at` integer NOT NULL,
	`rows` integer NOT NULL,
	`seats_per_row` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`seat_id` text NOT NULL,
	`customer_name` text NOT NULL,
	`email` text NOT NULL,
	`code` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_event_seat_unique` ON `reservations` (`event_id`,`seat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `reservations_code_unique` ON `reservations` (`code`);--> statement-breakpoint
CREATE INDEX `reservations_event_id_idx` ON `reservations` (`event_id`);