CREATE TABLE `budget_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_ref` text DEFAULT '' NOT NULL,
	`period` text NOT NULL,
	`limit_micro_usd` integer NOT NULL,
	`hard_stop` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_budget_scope" CHECK("budget_limits"."scope" in ('global','project','task')),
	CONSTRAINT "chk_budget_period" CHECK("budget_limits"."period" in ('day','week','month')),
	CONSTRAINT "chk_budget_amount" CHECK("budget_limits"."limit_micro_usd" >= 0),
	CONSTRAINT "chk_budget_scope_ref" CHECK(("budget_limits"."scope" = 'global' and "budget_limits"."scope_ref" = '') or ("budget_limits"."scope" <> 'global' and "budget_limits"."scope_ref" <> ''))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_budget_limit_scope` ON `budget_limits` (`scope`,`scope_ref`,`period`);--> statement-breakpoint
CREATE INDEX `idx_budget_limits_scope` ON `budget_limits` (`scope`,`scope_ref`);--> statement-breakpoint
CREATE TABLE `learnings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scope` text NOT NULL,
	`platform` text,
	`statement` text NOT NULL,
	`evidence_json` text,
	`sample_size` integer NOT NULL,
	`confidence` text DEFAULT 'faible' NOT NULL,
	`human_reviewed` integer DEFAULT false NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`last_confirmed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_learnings_scope" CHECK("learnings"."scope" in ('platform','topic','format','hook','timing','length')),
	CONSTRAINT "chk_learnings_confidence" CHECK("learnings"."confidence" in ('faible','moyenne','forte')),
	CONSTRAINT "chk_learnings_sample_size" CHECK("learnings"."sample_size" >= 5)
);
--> statement-breakpoint
CREATE INDEX `idx_learnings_project` ON `learnings` (`project_id`,`active`,`confidence`);--> statement-breakpoint
CREATE TABLE `metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`publication_id` text NOT NULL,
	`project_id` text NOT NULL,
	`platform` text NOT NULL,
	`captured_at` integer NOT NULL,
	`captured_date` text NOT NULL,
	`source` text NOT NULL,
	`impressions` integer,
	`reach` integer,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`saves` integer,
	`clicks` integer,
	`follows_gained` integer,
	`watch_time_sec` integer,
	`avg_view_duration_sec` integer,
	`completion_rate_x100` integer,
	`engagement_rate_x100` integer,
	`profile_visits` integer,
	`raw_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_metrics_source" CHECK("metric_snapshots"."source" in ('api','manual','estimated')),
	CONSTRAINT "chk_metrics_captured_date" CHECK(length("metric_snapshots"."captured_date") = 10 and "metric_snapshots"."captured_date" like '____-__-__'),
	CONSTRAINT "chk_metrics_non_negative" CHECK(("metric_snapshots"."impressions" is null or "metric_snapshots"."impressions" >= 0)
        and ("metric_snapshots"."reach" is null or "metric_snapshots"."reach" >= 0)
        and ("metric_snapshots"."views" is null or "metric_snapshots"."views" >= 0)
        and ("metric_snapshots"."likes" is null or "metric_snapshots"."likes" >= 0)
        and ("metric_snapshots"."comments" is null or "metric_snapshots"."comments" >= 0)
        and ("metric_snapshots"."shares" is null or "metric_snapshots"."shares" >= 0)
        and ("metric_snapshots"."saves" is null or "metric_snapshots"."saves" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_metric_day` ON `metric_snapshots` (`publication_id`,`captured_date`,`source`);--> statement-breakpoint
CREATE INDEX `idx_metrics_project_date` ON `metric_snapshots` (`project_id`,`captured_date`);--> statement-breakpoint
CREATE INDEX `idx_metrics_platform` ON `metric_snapshots` (`platform`,`captured_date`);--> statement-breakpoint
CREATE TABLE `performance_patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`platform` text NOT NULL,
	`dimension` text NOT NULL,
	`value` text NOT NULL,
	`metric` text NOT NULL,
	`sample_size` integer NOT NULL,
	`avg_value_x100` integer NOT NULL,
	`median_value_x100` integer,
	`baseline_x100` integer,
	`delta_percent` integer,
	`computed_at` integer NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_patterns_dimension" CHECK("performance_patterns"."dimension" in ('hook_type','length','posting_hour','posting_weekday','topic','format','hashtag_count','has_media','has_video','structure')),
	CONSTRAINT "chk_patterns_metric" CHECK("performance_patterns"."metric" in ('engagement_rate','reach','saves')),
	CONSTRAINT "chk_patterns_sample_size" CHECK("performance_patterns"."sample_size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pattern` ON `performance_patterns` (`project_id`,`platform`,`dimension`,`value`,`metric`,`period_end`);--> statement-breakpoint
CREATE INDEX `idx_patterns_lookup` ON `performance_patterns` (`project_id`,`platform`,`dimension`,`sample_size`);