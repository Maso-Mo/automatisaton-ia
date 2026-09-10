CREATE TABLE `audience_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`pain_points_json` text,
	`goals_json` text,
	`objections_json` text,
	`knowledge_level` text NOT NULL,
	`vocabulary_json` text,
	`platforms_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audience_project` ON `audience_profiles` (`project_id`);--> statement-breakpoint
CREATE TABLE `project_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`statement` text NOT NULL,
	`detail` text,
	`source` text NOT NULL,
	`source_message_id` text,
	`verified_by_user` integer DEFAULT false NOT NULL,
	`importance` integer DEFAULT 3 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_facts_project` ON `project_facts` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_facts_category` ON `project_facts` (`project_id`,`category`);--> statement-breakpoint
CREATE INDEX `idx_facts_verified` ON `project_facts` (`project_id`,`verified_by_user`);--> statement-breakpoint
CREATE TABLE `project_goals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	`metric` text NOT NULL,
	`target_value` integer,
	`current_value` integer,
	`period` text DEFAULT 'month' NOT NULL,
	`deadline` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_project_goals_project` ON `project_goals` (`project_id`,`status`);--> statement-breakpoint
CREATE TABLE `project_skill_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`skill` text NOT NULL,
	`level` text NOT NULL,
	`evidence` text,
	`learned_how` text,
	`is_learning` integer DEFAULT false NOT NULL,
	`learning_target` text,
	`confidence` integer DEFAULT 3 NOT NULL,
	`last_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_skill_project` ON `project_skill_facts` (`project_id`,`skill`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`positioning` text,
	`status` text DEFAULT 'discovery' NOT NULL,
	`target_goal` text,
	`start_date` integer,
	`timezone` text,
	`language` text DEFAULT 'fr' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_projects_status` ON `projects` (`status`);--> statement-breakpoint
CREATE INDEX `idx_projects_owner` ON `projects` (`owner_id`);--> statement-breakpoint
CREATE TABLE `style_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`scope` text DEFAULT 'project' NOT NULL,
	`platform` text,
	`tone` text,
	`formality` integer DEFAULT 3 NOT NULL,
	`sentence_length` text,
	`humor_level` integer DEFAULT 2 NOT NULL,
	`emoji_level` integer DEFAULT 2 NOT NULL,
	`forbidden_words_json` text,
	`signature_openings_json` text,
	`signature_closings_json` text,
	`example_paragraphs_json` text,
	`derived_from_texts` integer DEFAULT 0 NOT NULL,
	`confidence` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_style_scope` ON `style_profiles` (`project_id`,`scope`,`platform`);--> statement-breakpoint
CREATE INDEX `idx_style_project` ON `style_profiles` (`project_id`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`level` text NOT NULL,
	`step` text,
	`message` text NOT NULL,
	`data_json` text,
	`progress` integer,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_job_sequence` ON `job_events` (`job_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_events_job` ON `job_events` (`job_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_events_retention` ON `job_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`input_json` text NOT NULL,
	`output_json` text,
	`error_json` text,
	`project_id` text,
	`content_item_id` text,
	`publication_id` text,
	`dedupe_key` text,
	`idempotent` integer DEFAULT false NOT NULL,
	`scheduled_for` integer NOT NULL,
	`available_at` integer NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`worker_id` text,
	`lease_expires_at` integer,
	`heartbeat_at` integer,
	`progress` integer DEFAULT 0 NOT NULL,
	`current_step` text,
	`started_at` integer,
	`finished_at` integer,
	`duration_ms` integer,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`parent_job_id` text,
	`requires_network` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_claim` ON `jobs` (`status`,`available_at`,`priority`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_jobs_dedupe` ON `jobs` (`type`,`dedupe_key`) WHERE "jobs"."status" in ('queued','running') and "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX `idx_jobs_lease` ON `jobs` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_jobs_item` ON `jobs` (`content_item_id`,`type`,`status`);--> statement-breakpoint
CREATE INDEX `idx_jobs_schedule` ON `jobs` (`status`,`scheduled_for`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`project_id` text,
	`conversation_id` text,
	`content_item_id` text,
	`agent` text,
	`task` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version_id` text,
	`context_fingerprint` text,
	`request_json` text NOT NULL,
	`response_json` text,
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`cached_tokens` integer,
	`total_tokens` integer,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`latency_ms` integer,
	`ttft_ms` integer,
	`status` text NOT NULL,
	`error_code` text,
	`retried_from_id` text,
	`finish_reason` text,
	`temperature_x100` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`prompt_version_id`) REFERENCES `prompt_versions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_calls_project_time` ON `llm_calls` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_task` ON `llm_calls` (`task`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_agent` ON `llm_calls` (`agent`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_status` ON `llm_calls` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_calls_cost` ON `llm_calls` (`created_at`,`cost_micro_usd`);--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent` text NOT NULL,
	`task` text NOT NULL,
	`file_path` text NOT NULL,
	`content_hash` text NOT NULL,
	`git_commit` text,
	`version_label` text,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_prompt_hash` ON `prompt_versions` (`agent`,`task`,`content_hash`);--> statement-breakpoint
CREATE INDEX `idx_prompts_active` ON `prompt_versions` (`agent`,`task`,`is_active`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`value_type` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `llm_providers_config` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`api_key_encrypted` text,
	`key_version` integer DEFAULT 1 NOT NULL,
	`base_url` text,
	`enabled` integer DEFAULT false NOT NULL,
	`default_model` text,
	`is_default` integer DEFAULT false NOT NULL,
	`last_health_ok_at` integer,
	`last_health_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_provider_default` ON `llm_providers_config` (`is_default`) WHERE "llm_providers_config"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `idx_provider_enabled` ON `llm_providers_config` (`enabled`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`password_hash` text,
	`locale` text DEFAULT 'fr-FR' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);