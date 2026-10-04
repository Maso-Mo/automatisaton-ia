CREATE TABLE `calendar_change_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_slot_id` text NOT NULL,
	`proposed_scheduled_for` integer,
	`proposed_timezone` text,
	`proposed_rigidity` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`proposed_at` integer NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`calendar_slot_id`) REFERENCES `calendar_slots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_calendar_proposal_status" CHECK("calendar_change_proposals"."status" in ('pending','accepted','rejected')),
	CONSTRAINT "chk_calendar_proposal_rigidity" CHECK("calendar_change_proposals"."proposed_rigidity" is null or "calendar_change_proposals"."proposed_rigidity" in ('LOCKED','FLEXIBLE','EVERGREEN'))
);
--> statement-breakpoint
CREATE INDEX `idx_calendar_proposals_slot` ON `calendar_change_proposals` (`calendar_slot_id`,`status`);--> statement-breakpoint
CREATE TABLE `calendar_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text NOT NULL,
	`content_version_id` text NOT NULL,
	`platform_account_id` text NOT NULL,
	`platform` text NOT NULL,
	`scheduled_for` integer NOT NULL,
	`timezone` text NOT NULL,
	`rigidity` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`publication_id` text,
	`job_id` text,
	`missed_reason` text,
	`cancelled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_account_id`) REFERENCES `platform_accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`publication_id`) REFERENCES `publications`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_calendar_rigidity" CHECK("calendar_slots"."rigidity" in ('LOCKED','FLEXIBLE','EVERGREEN')),
	CONSTRAINT "chk_calendar_status" CHECK("calendar_slots"."status" in ('draft','scheduled','due','publishing','published','manual_required','cancelled','missed','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_calendar_range` ON `calendar_slots` (`scheduled_for`,`status`);--> statement-breakpoint
CREATE INDEX `idx_calendar_account` ON `calendar_slots` (`platform_account_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `idx_calendar_project` ON `calendar_slots` (`project_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `idx_calendar_publication` ON `calendar_slots` (`publication_id`);