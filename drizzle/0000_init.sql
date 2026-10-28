CREATE TABLE `analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`inventory_json` text NOT NULL,
	`summary_json` text,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_case_id_unique` ON `analyses` (`case_id`);--> statement-breakpoint
CREATE TABLE `cases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_label` text NOT NULL,
	`stage` text DEFAULT 'imported' NOT NULL,
	`size_bytes` integer NOT NULL,
	`file_count` integer NOT NULL,
	`verdict` text,
	`verdict_reason` text,
	`verdict_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "cases_source_kind_check" CHECK(source_kind IN ('sample', 'folder', 'archive')),
	CONSTRAINT "cases_stage_check" CHECK(stage IN ('imported', 'analyzed', 'diagnosed', 'patched', 'verified')),
	CONSTRAINT "cases_verdict_check" CHECK(verdict IS NULL OR verdict IN ('resurrected', 'partially_repaired', 'failed', 'unverified'))
);
--> statement-breakpoint
CREATE INDEX `cases_updated_idx` ON `cases` (`updated_at`);--> statement-breakpoint
CREATE TABLE `error_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `error_logs_case_idx` ON `error_logs` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress_note` text,
	`steps_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "jobs_kind_check" CHECK(kind IN ('analyze', 'diagnose', 'propose_patch', 'verify')),
	CONSTRAINT "jobs_status_check" CHECK(status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX `jobs_case_idx` ON `jobs` (`case_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_one_active_idx` ON `jobs` (`case_id`) WHERE status IN ('queued', 'running');