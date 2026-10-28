CREATE TABLE `check_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`patch_id` text,
	`phase` text NOT NULL,
	`check_kind` text NOT NULL,
	`command_label` text NOT NULL,
	`target` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`output_excerpt` text,
	`unrunnable_reason` text,
	`duration_ms` integer,
	`limits_json` text NOT NULL,
	`consented_at` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`patch_id`) REFERENCES `patches`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "check_runs_phase_check" CHECK(phase IN ('baseline', 'after')),
	CONSTRAINT "check_runs_kind_check" CHECK(check_kind IN ('test', 'build', 'start')),
	CONSTRAINT "check_runs_target_check" CHECK(target IN ('original', 'working')),
	CONSTRAINT "check_runs_status_check" CHECK(status IN ('passed', 'failed', 'timed_out', 'unrunnable')),
	CONSTRAINT "check_runs_phase_patch_check" CHECK((phase = 'after') = (patch_id IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `check_runs_case_idx` ON `check_runs` (`case_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`label` text NOT NULL,
	`title` text NOT NULL,
	`explanation` text NOT NULL,
	`category` text,
	`evidence_json` text NOT NULL,
	`check_run_id` text,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`check_run_id`) REFERENCES `check_runs`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "findings_label_check" CHECK(label IN ('confirmed_by_check', 'supported_by_files', 'hypothesis', 'no_failure_found')),
	CONSTRAINT "findings_category_check" CHECK(category IS NULL OR category IN ('module_format', 'removed_api', 'bad_path_or_config', 'missing_file', 'dependency_version', 'runtime_error', 'other'))
);
--> statement-breakpoint
CREATE INDEX `findings_case_idx` ON `findings` (`case_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `patches` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`finding_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`rationale` text NOT NULL,
	`edits_json` text NOT NULL,
	`diff_text` text NOT NULL,
	`files_affected_json` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`case_id`) REFERENCES `cases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "patches_status_check" CHECK(status IN ('proposed', 'approved', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX `patches_case_idx` ON `patches` (`case_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `patches_one_approved_idx` ON `patches` (`case_id`) WHERE status = 'approved';