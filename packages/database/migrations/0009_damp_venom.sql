PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__stage_news_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`url` text,
	`categories_json` text,
	`keywords_json` text,
	`exclude_keywords_json` text,
	`language` text,
	`authority` integer DEFAULT 3 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`refresh_hours` integer DEFAULT 12 NOT NULL,
	`last_fetch_at` integer,
	`last_success_at` integer,
	`last_error` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_sources_kind" CHECK("__stage_news_sources"."kind" in ('rss','atom','web','api','manual')),
	CONSTRAINT "chk_sources_authority" CHECK("__stage_news_sources"."authority" between 1 and 5),
	CONSTRAINT "chk_sources_refresh" CHECK("__stage_news_sources"."refresh_hours" > 0),
	CONSTRAINT "chk_sources_failures" CHECK("__stage_news_sources"."consecutive_failures" >= 0)
);
--> statement-breakpoint
INSERT INTO `__stage_news_sources`("id", "project_id", "name", "kind", "url", "keywords_json", "exclude_keywords_json", "language", "authority", "enabled", "refresh_hours", "last_fetch_at", "last_success_at", "last_error", "consecutive_failures", "created_at", "updated_at") SELECT "id", "project_id", "name", "kind", "url", "keywords_json", "exclude_keywords_json", "language", "authority", "enabled", "refresh_hours", "last_fetch_at", "last_success_at", "last_error", "consecutive_failures", "created_at", "updated_at" FROM `news_sources`;--> statement-breakpoint
CREATE TABLE `__new_news_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text,
	`title` text NOT NULL,
	`summary` text,
	`url` text NOT NULL,
	`canonical_url` text,
	`author` text,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`language` text,
	`raw_json` text,
	`content_hash` text NOT NULL,
	`relevance_score` integer,
	`freshness_score` integer,
	`authority_score` integer,
	`novelty_score` integer,
	`project_match_score` integer,
	`audience_match_score` integer,
	`final_score` integer,
	`score_explanation_json` text,
	`topic_tags_json` text,
	`matched_skill` text,
	`urgency` text DEFAULT 'NORMAL' NOT NULL,
	`verification_status` text DEFAULT 'source_confirmed' NOT NULL,
	`claims_json` text,
	`suggestion_json` text,
	`status` text DEFAULT 'new' NOT NULL,
	`dismissal_reason` text,
	`verified` integer DEFAULT true NOT NULL,
	`llm_enriched` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `__stage_news_sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_news_status" CHECK("__new_news_items"."status" in ('new','shortlisted','used','dismissed','expired')),
	CONSTRAINT "chk_news_scores" CHECK(("__new_news_items"."relevance_score" is null or "__new_news_items"."relevance_score" between 0 and 100)
          and ("__new_news_items"."freshness_score" is null or "__new_news_items"."freshness_score" between 0 and 100)
          and ("__new_news_items"."authority_score" is null or "__new_news_items"."authority_score" between 0 and 100)
          and ("__new_news_items"."novelty_score" is null or "__new_news_items"."novelty_score" between 0 and 100)
          and ("__new_news_items"."project_match_score" is null or "__new_news_items"."project_match_score" between 0 and 100)
          and ("__new_news_items"."audience_match_score" is null or "__new_news_items"."audience_match_score" between 0 and 100)
          and ("__new_news_items"."final_score" is null or "__new_news_items"."final_score" between 0 and 100)),
	CONSTRAINT "chk_news_urgency" CHECK("__new_news_items"."urgency" in ('BREAKING','HIGH','NORMAL','EVERGREEN')),
	CONSTRAINT "chk_news_verification" CHECK("__new_news_items"."verification_status" in ('source_confirmed','needs_review','confirmed','disputed'))
);
--> statement-breakpoint
INSERT INTO `__new_news_items`("id", "project_id", "source_id", "title", "summary", "url", "canonical_url", "author", "published_at", "fetched_at", "language", "raw_json", "content_hash", "relevance_score", "freshness_score", "authority_score", "novelty_score", "final_score", "topic_tags_json", "matched_skill", "status", "dismissal_reason", "verified", "llm_enriched", "created_at", "expires_at") SELECT "id", "project_id", "source_id", "title", "summary", "url", "canonical_url", "author", "published_at", "fetched_at", "language", "raw_json", "content_hash", "relevance_score", "freshness_score", "authority_score", "novelty_score", "final_score", "topic_tags_json", "matched_skill", "status", "dismissal_reason", "verified", "llm_enriched", "created_at", "expires_at" FROM `news_items`;--> statement-breakpoint
DROP TABLE `news_items`;--> statement-breakpoint
DROP TABLE `news_sources`;--> statement-breakpoint
ALTER TABLE `__stage_news_sources` RENAME TO `news_sources`;--> statement-breakpoint
ALTER TABLE `__new_news_items` RENAME TO `news_items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_news_hash` ON `news_items` (`project_id`,`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_news_external` ON `news_items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_news_canonical` ON `news_items` (`project_id`,`canonical_url`);--> statement-breakpoint
CREATE INDEX `idx_news_ranking` ON `news_items` (`project_id`,`status`,`final_score`);--> statement-breakpoint
CREATE INDEX `idx_news_fresh` ON `news_items` (`project_id`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_news_expiry` ON `news_items` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_sources_due` ON `news_sources` (`enabled`,`last_fetch_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_source_url` ON `news_sources` (`project_id`,`url`);
