CREATE TABLE `media_assets` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text,
  `kind` text NOT NULL,
  `role` text DEFAULT 'original' NOT NULL,
  `parent_asset_id` text,
  `storage_key` text NOT NULL,
  `original_filename` text,
  `mime_type` text NOT NULL,
  `size_bytes` integer NOT NULL,
  `sha256` text NOT NULL,
  `width` integer,
  `height` integer,
  `duration_ms` integer,
  `bitrate` integer,
  `codec` text,
  `fps` integer,
  `has_audio` integer,
  `language` text,
  `source` text NOT NULL,
  `source_url` text,
  `usage_count` integer DEFAULT 0 NOT NULL,
  `last_used_at` integer,
  `created_at` integer NOT NULL,
  `deleted_at` integer,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
  CONSTRAINT `chk_assets_kind` CHECK (`kind` in ('audio','image','video','document')),
  CONSTRAINT `chk_assets_role` CHECK (`role` in ('original','poster','thumbnail','vertical','square','subtitled','audio_normalized')),
  CONSTRAINT `chk_assets_source` CHECK (`source` in ('upload','generated','url_import','render')),
  CONSTRAINT `chk_assets_size` CHECK (`size_bytes` > 0),
  CONSTRAINT `chk_assets_usage` CHECK (`usage_count` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_asset_hash` ON `media_assets` (`project_id`,`sha256`,`role`);
--> statement-breakpoint
CREATE INDEX `idx_assets_project` ON `media_assets` (`project_id`,`kind`,`deleted_at`);
--> statement-breakpoint
CREATE INDEX `idx_assets_orphans` ON `media_assets` (`usage_count`,`created_at`);
--> statement-breakpoint
CREATE TABLE `transcripts` (
  `id` text PRIMARY KEY NOT NULL,
  `media_asset_id` text NOT NULL,
  `engine` text NOT NULL,
  `model` text,
  `language` text,
  `text` text NOT NULL,
  `segments_json` text NOT NULL,
  `word_count` integer,
  `duration_ms` integer,
  `confidence` integer,
  `has_word_timestamps` integer DEFAULT false NOT NULL,
  `processing_ms` integer,
  `cost_micro_usd` integer DEFAULT 0 NOT NULL,
  `edited_body` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`),
  CONSTRAINT `chk_transcripts_engine` CHECK (`engine` in ('whisper_cpp','faster_whisper','cloud')),
  CONSTRAINT `chk_transcripts_cost` CHECK (`cost_micro_usd` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_transcript_asset` ON `transcripts` (`media_asset_id`,`engine`,`model`);
--> statement-breakpoint
CREATE INDEX `idx_transcripts_lang` ON `transcripts` (`language`);
--> statement-breakpoint
CREATE TABLE `message_attachments` (
  `id` text PRIMARY KEY NOT NULL,
  `message_id` text NOT NULL,
  `media_asset_id` text NOT NULL,
  `kind` text NOT NULL,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`),
  FOREIGN KEY (`media_asset_id`) REFERENCES `media_assets`(`id`),
  CONSTRAINT `chk_attachments_kind` CHECK (`kind` in ('audio','image','video','document'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attachment` ON `message_attachments` (`message_id`,`media_asset_id`,`kind`);
--> statement-breakpoint
CREATE INDEX `idx_attachments_asset` ON `message_attachments` (`media_asset_id`);
