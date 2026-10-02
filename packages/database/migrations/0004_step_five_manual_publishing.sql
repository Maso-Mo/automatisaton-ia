CREATE TABLE `platform_accounts` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `platform` text NOT NULL,
  `account_label` text NOT NULL,
  `remote_account_id` text,
  `access_token_encrypted` text,
  `refresh_token_encrypted` text,
  `token_key_version` integer DEFAULT 1 NOT NULL,
  `scopes_json` text,
  `token_expires_at` integer,
  `capabilities_json` text,
  `connection_state` text DEFAULT 'disconnected' NOT NULL,
  `last_ok_at` integer,
  `last_error` text,
  `last_rate_limit_at` integer,
  `rate_limit_reset_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
  CONSTRAINT `chk_accounts_state` CHECK (`connection_state` in ('connected','expired','revoked','disconnected','rate_limited'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_platform_account` ON `platform_accounts` (`project_id`,`platform`,`remote_account_id`);
--> statement-breakpoint
CREATE INDEX `idx_accounts_state` ON `platform_accounts` (`platform`,`connection_state`);
--> statement-breakpoint
CREATE INDEX `idx_accounts_expiry` ON `platform_accounts` (`token_expires_at`);
--> statement-breakpoint
CREATE TABLE `project_platforms` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `platform` text NOT NULL,
  `enabled` integer DEFAULT true NOT NULL,
  `priority` integer DEFAULT 0 NOT NULL,
  `purposes_json` text,
  `cadence_per_week` integer,
  `default_account_id` text,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
  FOREIGN KEY (`default_account_id`) REFERENCES `platform_accounts`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_project_platform` ON `project_platforms` (`project_id`,`platform`);
--> statement-breakpoint
CREATE TABLE `manual_packages` (
  `id` text PRIMARY KEY NOT NULL,
  `content_item_id` text NOT NULL,
  `content_version_id` text NOT NULL,
  `platform` text NOT NULL,
  `body_text` text NOT NULL,
  `title_text` text,
  `copy_blocks_json` text,
  `asset_paths_json` text,
  `instructions` text,
  `deep_link` text,
  `downloaded_at` integer,
  `marked_published_at` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`),
  FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_manual_item` ON `manual_packages` (`content_item_id`,`platform`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_manual_version_platform` ON `manual_packages` (`content_version_id`,`platform`);
--> statement-breakpoint
CREATE TABLE `publications` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `content_item_id` text NOT NULL,
  `content_version_id` text NOT NULL,
  `platform_account_id` text NOT NULL,
  `platform` text NOT NULL,
  `status` text DEFAULT 'planned' NOT NULL,
  `scheduled_for` integer,
  `idempotency_key` text NOT NULL,
  `remote_id` text,
  `remote_url` text,
  `remote_status` text,
  `manual_package_id` text,
  `first_attempt_at` integer,
  `published_at` integer,
  `last_attempt_at` integer,
  `attempt_count` integer DEFAULT 0 NOT NULL,
  `needs_human_decision` integer DEFAULT false NOT NULL,
  `decision_note` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`),
  FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`),
  FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`),
  FOREIGN KEY (`platform_account_id`) REFERENCES `platform_accounts`(`id`),
  FOREIGN KEY (`manual_package_id`) REFERENCES `manual_packages`(`id`),
  CONSTRAINT `chk_publications_status` CHECK (`status` in ('planned','queued','publishing','published','failed','ambiguous','manual_required','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_publication_version_account` ON `publications` (`content_version_id`,`platform_account_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_publication_idempotency` ON `publications` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_publications_schedule` ON `publications` (`status`,`scheduled_for`);
--> statement-breakpoint
CREATE INDEX `idx_publications_item` ON `publications` (`content_item_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_publications_platform` ON `publications` (`platform`,`published_at`);
--> statement-breakpoint
CREATE TABLE `publication_attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `publication_id` text NOT NULL,
  `attempt_number` integer NOT NULL,
  `started_at` integer NOT NULL,
  `finished_at` integer,
  `outcome` text NOT NULL,
  `http_status` integer,
  `request_json` text,
  `response_json` text,
  `error_code` text,
  `error_message` text,
  `duration_ms` integer,
  `created_at` integer NOT NULL,
  FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attempt_number` ON `publication_attempts` (`publication_id`,`attempt_number`);
--> statement-breakpoint
CREATE INDEX `idx_attempts_outcome` ON `publication_attempts` (`outcome`,`created_at`);
--> statement-breakpoint

-- Garde irréversible : une publication référence exactement une version déjà approuvée.
CREATE TRIGGER `trg_publication_requires_approval`
BEFORE INSERT ON `publications`
FOR EACH ROW
WHEN (SELECT `approved_at` FROM `content_versions` WHERE `id` = NEW.`content_version_id`) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'publication_refusee: version de contenu non approuvee');
END;
