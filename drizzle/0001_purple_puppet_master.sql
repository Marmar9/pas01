CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`request_hash` text NOT NULL,
	`reservation_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`reservation_id`) REFERENCES `reservations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idempotency_keys_created_at_idx` ON `idempotency_keys` (`created_at`);