-- Migration 0006 — étape 7 : schéma de la veille et rendu vidéo vertical.
--
-- Deux parties, volontairement réunies dans une seule migration : les deux tables
-- de la veille (docs/03 §13, docs/10 §4.7 — le **schéma** seulement, le pipeline
-- arrive à l'étape 10) et l'évolution de `video_renders` (docs/03 §10.3) qui
-- devient exploitable par un rendu réel.
--
-- Le pipeline de veille n'est PAS implémenté ici : aucune table de travail, aucun
-- état de collecte. Ce fichier ne crée que le modèle de données.

CREATE TABLE `news_sources` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `name` text NOT NULL,
  `kind` text NOT NULL,
  `url` text,
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
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
  CONSTRAINT `chk_sources_kind` CHECK (`kind` in ('rss','atom','api','manual')),
  CONSTRAINT `chk_sources_authority` CHECK (`authority` between 1 and 5),
  CONSTRAINT `chk_sources_refresh` CHECK (`refresh_hours` > 0),
  CONSTRAINT `chk_sources_failures` CHECK (`consecutive_failures` >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_sources_due` ON `news_sources` (`enabled`,`last_fetch_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_source_url` ON `news_sources` (`project_id`,`url`);
--> statement-breakpoint
CREATE TABLE `news_items` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `source_id` text NOT NULL,
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
  `final_score` integer,
  `topic_tags_json` text,
  `matched_skill` text,
  `status` text DEFAULT 'new' NOT NULL,
  `dismissal_reason` text,
  `verified` integer DEFAULT true NOT NULL,
  `llm_enriched` integer DEFAULT false NOT NULL,
  `created_at` integer NOT NULL,
  `expires_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
  FOREIGN KEY (`source_id`) REFERENCES `news_sources`(`id`),
  CONSTRAINT `chk_news_status` CHECK (`status` in ('new','shortlisted','used','dismissed','expired')),
  CONSTRAINT `chk_news_scores` CHECK (
    (`relevance_score` is null or `relevance_score` between 0 and 100)
    and (`freshness_score` is null or `freshness_score` between 0 and 100)
    and (`authority_score` is null or `authority_score` between 0 and 100)
    and (`novelty_score` is null or `novelty_score` between 0 and 100)
    and (`final_score` is null or `final_score` between 0 and 100)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_news_hash` ON `news_items` (`project_id`,`content_hash`);
--> statement-breakpoint
CREATE INDEX `idx_news_ranking` ON `news_items` (`project_id`,`status`,`final_score`);
--> statement-breakpoint
CREATE INDEX `idx_news_fresh` ON `news_items` (`project_id`,`published_at`);
--> statement-breakpoint
CREATE INDEX `idx_news_expiry` ON `news_items` (`status`,`expires_at`);
--> statement-breakpoint
-- `video_renders` gagne la version de contenu, le job, la validation humaine, et
-- deux états intermédiaires explicites. SQLite ne sait pas modifier une
-- contrainte CHECK : la table est reconstruite, avec copie des lignes existantes
-- (il n'y en a aucune en pratique — la table existe depuis l'étape 4 sans
-- pipeline — mais une migration qui perd des données est une migration fausse).
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE `__new_video_renders` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `content_item_id` text,
  `content_version_id` text NOT NULL,
  `source_asset_ids_json` text NOT NULL,
  `output_asset_id` text,
  `preset` text NOT NULL,
  `edit_plan_json` text NOT NULL,
  `ffmpeg_args_json` text NOT NULL,
  `ffmpeg_version` text,
  `status` text DEFAULT 'queued' NOT NULL,
  `progress` integer DEFAULT 0 NOT NULL,
  `duration_ms` integer,
  `output_size_bytes` integer,
  `error_json` text,
  `job_id` text,
  `validated_at` integer,
  `requested_at` integer NOT NULL,
  `started_at` integer,
  `finished_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
  FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`),
  FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`),
  CONSTRAINT `chk_renders_preset` CHECK (`preset` in ('vertical_9_16','square_1_1','landscape_16_9','clip_short')),
  CONSTRAINT `chk_renders_status` CHECK (`status` in ('queued','preparing','rendering','completed','failed','cancelled')),
  CONSTRAINT `chk_renders_progress` CHECK (`progress` between 0 and 100)
);
--> statement-breakpoint
INSERT INTO `__new_video_renders` (`id`, `project_id`, `content_item_id`, `content_version_id`, `source_asset_ids_json`, `output_asset_id`, `preset`, `edit_plan_json`, `ffmpeg_args_json`, `ffmpeg_version`, `status`, `progress`, `duration_ms`, `output_size_bytes`, `error_json`, `job_id`, `validated_at`, `requested_at`, `started_at`, `finished_at`)
SELECT `id`, `project_id`, `content_item_id`, NULL, `source_asset_ids_json`, `output_asset_id`, `preset`, `edit_plan_json`, `ffmpeg_args_json`, `ffmpeg_version`, `status`, `progress`, `duration_ms`, `output_size_bytes`, `error_json`, NULL, NULL, `requested_at`, `started_at`, `finished_at` FROM `video_renders`;
--> statement-breakpoint
DROP TABLE `video_renders`;
--> statement-breakpoint
ALTER TABLE `__new_video_renders` RENAME TO `video_renders`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE INDEX `idx_renders_item` ON `video_renders` (`content_item_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_renders_version` ON `video_renders` (`content_version_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_renders_job` ON `video_renders` (`job_id`);
