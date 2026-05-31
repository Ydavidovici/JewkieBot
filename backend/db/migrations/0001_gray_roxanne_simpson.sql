CREATE TABLE `move_evals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` integer NOT NULL,
	`ply` integer NOT NULL,
	`best_uci` text,
	`best_cp` integer,
	`played_cp` integer,
	`cp_loss` integer,
	`is_mate` integer DEFAULT 0,
	`classification` text,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `move_evals_game_idx` ON `move_evals` (`game_id`);--> statement-breakpoint
ALTER TABLE `games` ADD `source` text DEFAULT 'local';--> statement-breakpoint
ALTER TABLE `games` ADD `lichess_game_id` text;--> statement-breakpoint
ALTER TABLE `games` ADD `variant` text;--> statement-breakpoint
ALTER TABLE `games` ADD `rated` integer;--> statement-breakpoint
ALTER TABLE `games` ADD `time_control` text;--> statement-breakpoint
ALTER TABLE `games` ADD `white_rating` integer;--> statement-breakpoint
ALTER TABLE `games` ADD `black_rating` integer;--> statement-breakpoint
ALTER TABLE `games` ADD `opening_eco` text;--> statement-breakpoint
ALTER TABLE `games` ADD `opening_name` text;--> statement-breakpoint
CREATE UNIQUE INDEX `games_lichess_game_id_unique` ON `games` (`lichess_game_id`);