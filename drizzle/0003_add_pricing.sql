ALTER TABLE `events` ADD `price` integer DEFAULT 3200 NOT NULL;--> statement-breakpoint
ALTER TABLE `reservations` ADD `amount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `reservations`
SET `amount` = COALESCE(
  (SELECT `price` FROM `events` WHERE `events`.`id` = `reservations`.`event_id`),
  `amount`
);