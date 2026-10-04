CREATE TABLE `content_feature_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`publication_id` text,
	`content_version_id` text,
	`external_example_id` text,
	`platform` text NOT NULL,
	`niche` text,
	`content_type` text NOT NULL,
	`features_json` text NOT NULL,
	`provenance` text NOT NULL,
	`confidence_x100` integer DEFAULT 100 NOT NULL,
	`experiment_key` text,
	`experiment_variant` text,
	`extraction_ms` integer DEFAULT 0 NOT NULL,
	`included` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`external_example_id`) REFERENCES `external_content_examples`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_features_origin" CHECK(("content_feature_sets"."publication_id" is not null and "content_feature_sets"."external_example_id" is null)
        or ("content_feature_sets"."publication_id" is null and "content_feature_sets"."external_example_id" is not null)),
	CONSTRAINT "chk_features_confidence" CHECK("content_feature_sets"."confidence_x100" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_features_publication` ON `content_feature_sets` (`publication_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_features_external` ON `content_feature_sets` (`external_example_id`);--> statement-breakpoint
CREATE INDEX `idx_features_learning` ON `content_feature_sets` (`project_id`,`platform`,`included`);--> statement-breakpoint
CREATE TABLE `external_content_examples` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`platform` text NOT NULL,
	`url` text NOT NULL,
	`creator_name` text,
	`published_at` integer,
	`collected_at` integer NOT NULL,
	`views` integer,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`followers` integer,
	`duration_ms` integer,
	`title` text NOT NULL,
	`topic` text,
	`extracted_features_json` text,
	`provenance` text NOT NULL,
	`confidence_x100` integer DEFAULT 50 NOT NULL,
	`included` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_external_confidence" CHECK("external_content_examples"."confidence_x100" between 0 and 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_external_example_url` ON `external_content_examples` (`project_id`,`url`);--> statement-breakpoint
CREATE INDEX `idx_external_example_project` ON `external_content_examples` (`project_id`,`platform`,`included`);--> statement-breakpoint
ALTER TABLE `learnings` ADD `confidence_x100` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `learnings` ADD `niche` text;--> statement-breakpoint
ALTER TABLE `learnings` ADD `content_type` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_metric_snapshots` (
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
	`followers_at_publish` integer,
	`platform_metrics_json` text,
	`collection_method` text DEFAULT 'manual_entry' NOT NULL,
	`provenance` text DEFAULT 'user' NOT NULL,
	`engagement_rate_x10000` integer,
	`share_rate_x10000` integer,
	`save_rate_x10000` integer,
	`comment_rate_x10000` integer,
	`ctr_x10000` integer,
	`view_velocity_x100` integer,
	`relative_performance_x100` integer,
	`percentile_x100` integer,
	`raw_json` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_metrics_source" CHECK("__new_metric_snapshots"."source" in ('api','manual','estimated')),
	CONSTRAINT "chk_metrics_captured_date" CHECK(length("__new_metric_snapshots"."captured_date") = 10 and "__new_metric_snapshots"."captured_date" like '____-__-__'),
	CONSTRAINT "chk_metrics_non_negative" CHECK(("__new_metric_snapshots"."impressions" is null or "__new_metric_snapshots"."impressions" >= 0)
        and ("__new_metric_snapshots"."reach" is null or "__new_metric_snapshots"."reach" >= 0)
        and ("__new_metric_snapshots"."views" is null or "__new_metric_snapshots"."views" >= 0)
        and ("__new_metric_snapshots"."likes" is null or "__new_metric_snapshots"."likes" >= 0)
        and ("__new_metric_snapshots"."comments" is null or "__new_metric_snapshots"."comments" >= 0)
        and ("__new_metric_snapshots"."shares" is null or "__new_metric_snapshots"."shares" >= 0)
        and ("__new_metric_snapshots"."saves" is null or "__new_metric_snapshots"."saves" >= 0)),
	CONSTRAINT "chk_metrics_followers" CHECK("__new_metric_snapshots"."followers_at_publish" is null or "__new_metric_snapshots"."followers_at_publish" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_metric_snapshots`("id", "publication_id", "project_id", "platform", "captured_at", "captured_date", "source", "impressions", "reach", "views", "likes", "comments", "shares", "saves", "clicks", "follows_gained", "watch_time_sec", "avg_view_duration_sec", "completion_rate_x100", "engagement_rate_x100", "profile_visits", "raw_json", "created_at") SELECT "id", "publication_id", "project_id", "platform", "captured_at", "captured_date", "source", "impressions", "reach", "views", "likes", "comments", "shares", "saves", "clicks", "follows_gained", "watch_time_sec", "avg_view_duration_sec", "completion_rate_x100", "engagement_rate_x100", "profile_visits", "raw_json", "created_at" FROM `metric_snapshots`;--> statement-breakpoint
DROP TABLE `metric_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_metric_snapshots` RENAME TO `metric_snapshots`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_metric_snapshot` ON `metric_snapshots` (`publication_id`,`captured_at`,`source`);--> statement-breakpoint
CREATE INDEX `idx_metrics_project_date` ON `metric_snapshots` (`project_id`,`captured_date`);--> statement-breakpoint
CREATE INDEX `idx_metrics_platform` ON `metric_snapshots` (`platform`,`captured_date`);--> statement-breakpoint
CREATE TABLE `__new_performance_patterns` (
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
	`niche` text,
	`content_type` text,
	`observed_effect` text,
	`positive_sample_size` integer DEFAULT 0 NOT NULL,
	`baseline_sample_size` integer DEFAULT 0 NOT NULL,
	`confidence_x100` integer DEFAULT 0 NOT NULL,
	`evidence_json` text,
	`status` text DEFAULT 'EXPERIMENTAL' NOT NULL,
	`first_observed_at` integer,
	`last_observed_at` integer,
	`computed_at` integer NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_patterns_dimension" CHECK("__new_performance_patterns"."dimension" in ('hook_type','length','posting_hour','posting_weekday','topic','format','hashtag_count','has_media','has_video','has_subtitles','structure','cta_type','technical_level','duration','visual_pace')),
	CONSTRAINT "chk_patterns_metric" CHECK("__new_performance_patterns"."metric" in ('engagement_rate','reach','saves')),
	CONSTRAINT "chk_patterns_sample_size" CHECK("__new_performance_patterns"."sample_size" > 0),
	CONSTRAINT "chk_patterns_status" CHECK("__new_performance_patterns"."status" in ('EXPERIMENTAL','LIKELY','SUPPORTED','REJECTED')),
	CONSTRAINT "chk_patterns_confidence" CHECK("__new_performance_patterns"."confidence_x100" between 0 and 100)
);
--> statement-breakpoint
INSERT INTO `__new_performance_patterns`("id", "project_id", "platform", "dimension", "value", "metric", "sample_size", "avg_value_x100", "median_value_x100", "baseline_x100", "delta_percent", "computed_at", "period_start", "period_end") SELECT "id", "project_id", "platform", "dimension", "value", "metric", "sample_size", "avg_value_x100", "median_value_x100", "baseline_x100", "delta_percent", "computed_at", "period_start", "period_end" FROM `performance_patterns`;--> statement-breakpoint
DROP TABLE `performance_patterns`;--> statement-breakpoint
ALTER TABLE `__new_performance_patterns` RENAME TO `performance_patterns`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_pattern` ON `performance_patterns` (`project_id`,`platform`,`dimension`,`value`,`metric`,`period_end`);--> statement-breakpoint
CREATE INDEX `idx_patterns_lookup` ON `performance_patterns` (`project_id`,`platform`,`dimension`,`sample_size`);
