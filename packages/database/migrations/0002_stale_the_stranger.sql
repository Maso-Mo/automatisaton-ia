CREATE TABLE `conversation_summaries` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`scope` text NOT NULL,
	`from_message_index` integer NOT NULL,
	`to_message_index` integer NOT NULL,
	`summary` text NOT NULL,
	`decisions_json` text,
	`facts_extracted_json` text,
	`tokens_saved_estimate` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_summaries_scope" CHECK("conversation_summaries"."scope" IN ('rolling','final')),
	CONSTRAINT "chk_summaries_range" CHECK("conversation_summaries"."from_message_index" <= "conversation_summaries"."to_message_index")
);
--> statement-breakpoint
CREATE INDEX `idx_summaries_conversation` ON `conversation_summaries` (`conversation_id`,`scope`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text,
	`kind` text DEFAULT 'interview' NOT NULL,
	`stage` text DEFAULT 'intake' NOT NULL,
	`missing_slots_json` text,
	`model_used` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`last_message_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_conversations_stage" CHECK("conversations"."stage" IN ('intake','positioning','audience','voice','fact_extraction','strategy','brief_ready','closed')),
	CONSTRAINT "chk_conversations_kind" CHECK("conversations"."kind" IN ('interview','news_discussion','feedback','freeform')),
	CONSTRAINT "chk_conversations_message_count" CHECK("conversations"."message_count" >= 0),
	CONSTRAINT "chk_conversations_closed_at" CHECK(("conversations"."stage" <> 'closed') OR ("conversations"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_conversations_project` ON `conversations` (`project_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `idx_conversations_stage` ON `conversations` (`project_id`,`stage`);--> statement-breakpoint
CREATE TABLE `master_briefs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`summary` text NOT NULL,
	`positioning` text NOT NULL,
	`target_audience` text NOT NULL,
	`content_pillars_json` text NOT NULL,
	`themes_json` text NOT NULL,
	`formats_json` text,
	`skill_map_json` text,
	`gaps_json` text,
	`cadence_json` text,
	`success_criteria_json` text,
	`source_message_ids_json` text,
	`llm_call_id` text,
	`validated_at` integer,
	`superseded_by_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`llm_call_id`) REFERENCES `llm_calls`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_briefs_status" CHECK("master_briefs"."status" IN ('draft','validated','superseded')),
	CONSTRAINT "chk_briefs_version" CHECK("master_briefs"."version" >= 1),
	CONSTRAINT "chk_briefs_validated_at" CHECK(("master_briefs"."status" <> 'validated') OR ("master_briefs"."validated_at" IS NOT NULL)),
	CONSTRAINT "chk_briefs_supersede_link" CHECK(("master_briefs"."status" = 'superseded') = ("master_briefs"."superseded_by_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_briefs_project` ON `master_briefs` (`project_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_brief_version` ON `master_briefs` (`conversation_id`,`version`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text,
	`content_json` text,
	`message_type` text DEFAULT 'text' NOT NULL,
	`agent` text,
	`input_mode` text,
	`audio_asset_id` text,
	`transcript_status` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`llm_call_id` text,
	`parent_message_id` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`llm_call_id`) REFERENCES `llm_calls`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_messages_role" CHECK("messages"."role" IN ('user','assistant','system','tool')),
	CONSTRAINT "chk_messages_type" CHECK("messages"."message_type" IN ('text','question','options','proposal','confirmation','error')),
	CONSTRAINT "chk_messages_input_mode" CHECK("messages"."input_mode" IS NULL OR "messages"."input_mode" IN ('text','voice','file')),
	CONSTRAINT "chk_messages_cost" CHECK("messages"."cost_micro_usd" >= 0),
	CONSTRAINT "chk_messages_content" CHECK("messages"."content" IS NOT NULL OR "messages"."content_json" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `idx_messages_conversation` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_messages_role` ON `messages` (`conversation_id`,`role`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`statement` text NOT NULL,
	`detail` text,
	`source` text NOT NULL,
	`source_message_id` text,
	`verified_by_user` integer DEFAULT false NOT NULL,
	`verification_status` text DEFAULT 'user_provided' NOT NULL,
	`verification_note` text,
	`verified_at` integer,
	`supersedes_fact_id` text,
	`superseded_by_fact_id` text,
	`superseded_at` integer,
	`importance` integer DEFAULT 3 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supersedes_fact_id`) REFERENCES `project_facts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_fact_id`) REFERENCES `project_facts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_facts_verified_at" CHECK(("__new_project_facts"."verification_status" <> 'verified') OR ("__new_project_facts"."verified_at" IS NOT NULL)),
	CONSTRAINT "chk_facts_verified_by_user" CHECK(("__new_project_facts"."verified_by_user" = 1) = ("__new_project_facts"."verification_status" = 'verified')),
	CONSTRAINT "chk_facts_supersede_link" CHECK(("__new_project_facts"."verification_status" = 'superseded') = ("__new_project_facts"."superseded_by_fact_id" IS NOT NULL)),
	CONSTRAINT "chk_facts_importance" CHECK("__new_project_facts"."importance" BETWEEN 1 AND 5)
);
--> statement-breakpoint
INSERT INTO `__new_project_facts`("id", "project_id", "category", "statement", "detail", "source", "source_message_id", "verified_by_user", "verification_status", "verification_note", "verified_at", "supersedes_fact_id", "superseded_by_fact_id", "superseded_at", "importance", "used_count", "last_used_at", "created_at", "updated_at", "deleted_at") SELECT "id", "project_id", "category", "statement", "detail", "source", "source_message_id", "verified_by_user", "verification_status", "verification_note", "verified_at", "supersedes_fact_id", "superseded_by_fact_id", "superseded_at", "importance", "used_count", "last_used_at", "created_at", "updated_at", "deleted_at" FROM `project_facts`;--> statement-breakpoint
DROP TABLE `project_facts`;--> statement-breakpoint
ALTER TABLE `__new_project_facts` RENAME TO `project_facts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_facts_project` ON `project_facts` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_facts_category` ON `project_facts` (`project_id`,`category`);--> statement-breakpoint
CREATE INDEX `idx_facts_verified` ON `project_facts` (`project_id`,`verified_by_user`);--> statement-breakpoint
CREATE INDEX `idx_facts_verification` ON `project_facts` (`project_id`,`verification_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_facts_supersedes` ON `project_facts` (`supersedes_fact_id`);--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Déclencheurs (docs/03 §15.1, §15.2) — Drizzle ne les génère pas : cette
-- section est écrite à la main et versionnée avec la migration.
--
-- 1. La reconstruction de `project_facts` ci-dessus a supprimé les deux
--    déclencheurs de l'étape 2 (un DROP TABLE emporte ses déclencheurs) : ils
--    sont recréés ici, sinon la garantie « un fait ne se supprime pas »
--    disparaîtrait silencieusement au cours d'une migration.
-- 2. Un message est **auditable** : il ne se supprime pas. La corbeille
--    documentée est `deleted_at` (docs/03 §7.2).
-- 3. Une fiche maître est **immuable** dès qu'elle est validée ou remplacée :
--    une modification crée une nouvelle version (docs/03 §8.1). Et une version
--    remplacée ne redevient jamais courante.
-- ---------------------------------------------------------------------------

CREATE TRIGGER `trg_project_facts_no_delete`
BEFORE DELETE ON `project_facts`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'suppression_interdite: un fait de projet se declare obsolete ou remplace, il ne se supprime pas');
END;--> statement-breakpoint

CREATE TRIGGER `trg_project_facts_verification_requires_human`
BEFORE INSERT ON `project_facts`
FOR EACH ROW
WHEN NEW.`verification_status` = 'verified' AND NEW.`verified_at` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'verification_refusee: un fait confirme doit porter une date de confirmation humaine');
END;--> statement-breakpoint

CREATE TRIGGER `trg_messages_no_delete`
BEFORE DELETE ON `messages`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'suppression_interdite: un message se marque supprime (deleted_at), il ne s efface pas — la conversation doit rester auditable');
END;--> statement-breakpoint

CREATE TRIGGER `trg_master_briefs_frozen_when_validated`
BEFORE UPDATE ON `master_briefs`
FOR EACH ROW
WHEN OLD.`status` <> 'draft' AND (
     NEW.`version` IS NOT OLD.`version`
  OR NEW.`summary` IS NOT OLD.`summary`
  OR NEW.`positioning` IS NOT OLD.`positioning`
  OR NEW.`target_audience` IS NOT OLD.`target_audience`
  OR NEW.`content_pillars_json` IS NOT OLD.`content_pillars_json`
  OR NEW.`themes_json` IS NOT OLD.`themes_json`
  OR NEW.`formats_json` IS NOT OLD.`formats_json`
  OR NEW.`skill_map_json` IS NOT OLD.`skill_map_json`
  OR NEW.`gaps_json` IS NOT OLD.`gaps_json`
  OR NEW.`cadence_json` IS NOT OLD.`cadence_json`
  OR NEW.`success_criteria_json` IS NOT OLD.`success_criteria_json`
  OR NEW.`source_message_ids_json` IS NOT OLD.`source_message_ids_json`
)
BEGIN
  SELECT RAISE(ABORT, 'brief_gele: une fiche validee ou remplacee ne se modifie pas — creer une nouvelle version');
END;--> statement-breakpoint

CREATE TRIGGER `trg_master_briefs_superseded_is_terminal`
BEFORE UPDATE ON `master_briefs`
FOR EACH ROW
WHEN OLD.`status` = 'superseded' AND NEW.`status` <> 'superseded'
BEGIN
  SELECT RAISE(ABORT, 'brief_remplace: une version remplacee ne redevient pas courante — creer une nouvelle version');
END;