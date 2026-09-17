CREATE TABLE `content_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`content_version_id` text NOT NULL,
	`claim` text NOT NULL,
	`claim_type` text NOT NULL,
	`verifiability` text NOT NULL,
	`evidence` text,
	`evidence_source` text,
	`risk` text NOT NULL,
	`status` text NOT NULL,
	`user_confirmed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_claims_claim_type" CHECK("content_claims"."claim_type" in ('chiffre','fait','experience','opinion','prediction','generalite')),
	CONSTRAINT "chk_claims_verifiability" CHECK("content_claims"."verifiability" in ('verifiable','non_verifiable','depend_du_contexte')),
	CONSTRAINT "chk_claims_risk" CHECK("content_claims"."risk" in ('faible','moyen','eleve')),
	CONSTRAINT "chk_claims_status" CHECK("content_claims"."status" in ('supported','unsupported','needs_user_confirmation','rejected')),
	CONSTRAINT "chk_claims_evidence_source" CHECK("content_claims"."evidence_source" is null or "content_claims"."evidence_source" in ('project_fact','news_item','user','web','none'))
);
--> statement-breakpoint
CREATE INDEX `idx_claims_version` ON `content_claims` (`content_version_id`,`risk`);--> statement-breakpoint
CREATE INDEX `idx_claims_status` ON `content_claims` (`content_version_id`,`status`);--> statement-breakpoint
CREATE TABLE `content_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`subject_id` text,
	`angle_id` text,
	`platform` text NOT NULL,
	`platform_account_id` text,
	`format` text NOT NULL,
	`title` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`current_version_id` text,
	`approved_version_id` text,
	`content_hash` text,
	`ai_generated` integer DEFAULT true NOT NULL,
	`human_edited` integer DEFAULT false NOT NULL,
	`edit_ratio` integer,
	`regenerated_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`approved_at` integer,
	`scheduled_for` integer,
	`published_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_id`) REFERENCES `content_subjects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`angle_id`) REFERENCES `subject_angles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_items_state" CHECK("content_items"."state" in ('draft','generated','in_review','editing','approved','scheduled','publishing','published','publish_failed','publish_ambiguous','archived')),
	CONSTRAINT "chk_items_format" CHECK("content_items"."format" in ('post_texte','post_image','video_courte','video_longue','thread','article')),
	CONSTRAINT "chk_items_edit_ratio" CHECK("content_items"."edit_ratio" is null or ("content_items"."edit_ratio" >= 0 and "content_items"."edit_ratio" <= 100))
);
--> statement-breakpoint
CREATE INDEX `idx_items_project` ON `content_items` (`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_items_platform` ON `content_items` (`platform`,`state`);--> statement-breakpoint
CREATE INDEX `idx_items_scheduled` ON `content_items` (`scheduled_for`);--> statement-breakpoint
CREATE INDEX `idx_items_hash` ON `content_items` (`content_hash`);--> statement-breakpoint
CREATE TABLE `content_review_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`content_item_id` text NOT NULL,
	`content_version_id` text,
	`author` text NOT NULL,
	`note_type` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`anchor_text` text,
	`resolved` integer DEFAULT false NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_version_id`) REFERENCES `content_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_notes_note_type" CHECK("content_review_notes"."note_type" in ('critique','suggestion','erreur','warning','decision')),
	CONSTRAINT "chk_notes_severity" CHECK("content_review_notes"."severity" in ('info','basse','moyenne','haute'))
);
--> statement-breakpoint
CREATE INDEX `idx_notes_item` ON `content_review_notes` (`content_item_id`,`resolved`);--> statement-breakpoint
CREATE TABLE `content_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`master_brief_id` text,
	`news_item_id` text,
	`conversation_id` text,
	`title` text NOT NULL,
	`thesis` text NOT NULL,
	`pillar` text,
	`audience_id` text,
	`origin` text DEFAULT 'conversation' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`skill_coverage` text,
	`evidence_json` text,
	`priority_score` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`master_brief_id`) REFERENCES `master_briefs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audience_id`) REFERENCES `audience_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_subjects_skill_coverage" CHECK("content_subjects"."skill_coverage" is null or "content_subjects"."skill_coverage" in ('couverte','partielle','non_couverte')),
	CONSTRAINT "chk_subjects_origin" CHECK("content_subjects"."origin" in ('conversation','news','manual','recycling','analytics'))
);
--> statement-breakpoint
CREATE INDEX `idx_subjects_project` ON `content_subjects` (`project_id`,`status`,`priority_score`);--> statement-breakpoint
CREATE INDEX `idx_subjects_origin` ON `content_subjects` (`project_id`,`origin`);--> statement-breakpoint
CREATE TABLE `content_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`content_item_id` text NOT NULL,
	`version_number` integer NOT NULL,
	`body` text NOT NULL,
	`title` text,
	`hook` text,
	`hashtags_json` text,
	`mentions_json` text,
	`link_url` text,
	`media_asset_ids_json` text,
	`char_count` integer,
	`word_count` integer,
	`reading_time_sec` integer,
	`generation` text DEFAULT 'initial' NOT NULL,
	`prompt_version_hash` text,
	`llm_call_id` text,
	`model_used` text,
	`temperature_x100` integer,
	`critique_json` text,
	`quality_score` integer,
	`approved_at` integer,
	`approved_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`llm_call_id`) REFERENCES `llm_calls`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_versions_generation" CHECK("content_versions"."generation" in ('initial','regenerated','edited','reformatted')),
	CONSTRAINT "chk_versions_quality_score" CHECK("content_versions"."quality_score" is null or ("content_versions"."quality_score" >= 0 and "content_versions"."quality_score" <= 100))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_content_version` ON `content_versions` (`content_item_id`,`version_number`);--> statement-breakpoint
CREATE INDEX `idx_versions_item` ON `content_versions` (`content_item_id`,`version_number`);--> statement-breakpoint
CREATE TABLE `subject_angles` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`platform` text DEFAULT 'all' NOT NULL,
	`hook` text NOT NULL,
	`angle_type` text NOT NULL,
	`structure_json` text,
	`audience_id` text,
	`estimated_length` text,
	`difficulty` text,
	`evidence_json` text,
	`rationale` text,
	`score` integer,
	`selected` integer DEFAULT false NOT NULL,
	`rejection_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `content_subjects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`audience_id`) REFERENCES `audience_profiles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_angles_angle_type" CHECK("subject_angles"."angle_type" in ('retour_experience','tutoriel','opinion','comparaison','erreur','coulisses','question','etude_de_cas')),
	CONSTRAINT "chk_angles_estimated_length" CHECK("subject_angles"."estimated_length" is null or "subject_angles"."estimated_length" in ('court','moyen','long')),
	CONSTRAINT "chk_angles_difficulty" CHECK("subject_angles"."difficulty" is null or "subject_angles"."difficulty" in ('faible','moyenne','elevee'))
);
--> statement-breakpoint
CREATE INDEX `idx_angles_subject` ON `subject_angles` (`subject_id`,`score`);--> statement-breakpoint
CREATE TABLE `video_renders` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`content_item_id` text,
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
	`requested_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`content_item_id`) REFERENCES `content_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_renders_preset" CHECK("video_renders"."preset" in ('vertical_9_16','square_1_1','landscape_16_9','clip_short')),
	CONSTRAINT "chk_renders_status" CHECK("video_renders"."status" in ('queued','running','completed','failed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_renders_item` ON `video_renders` (`content_item_id`,`status`);--> statement-breakpoint
CREATE TABLE `errors` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`severity` text NOT NULL,
	`surface` text NOT NULL,
	`error_type` text NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`context_json` text,
	`job_id` text,
	`content_item_id` text,
	`publication_id` text,
	`provider` text,
	`http_status` integer,
	`retryable` integer DEFAULT false NOT NULL,
	`occurrence_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	`resolution_note` text,
	CONSTRAINT "chk_errors_severity" CHECK("errors"."severity" in ('warning','error','fatal')),
	CONSTRAINT "chk_errors_surface" CHECK("errors"."surface" in ('api','worker','ui','connector','llm','fs'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_error_fingerprint` ON `errors` (`fingerprint`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `idx_errors_recent` ON `errors` (`last_seen_at`,`severity`);--> statement-breakpoint
CREATE INDEX `idx_errors_surface` ON `errors` (`surface`,`last_seen_at`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`action_url` text,
	`action_label` text,
	`related_type` text,
	`related_id` text,
	`dedupe_key` text NOT NULL,
	`read_at` integer,
	`dismissed_at` integer,
	`acted_at` integer,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_notifications_severity" CHECK("notifications"."severity" in ('info','attention','urgent'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_notification_dedupe` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `idx_notifications_unread` ON `notifications` (`read_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notifications_project` ON `notifications` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `system_health` (
	`id` text PRIMARY KEY NOT NULL,
	`check_name` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`details_json` text,
	`latency_ms` integer,
	`checked_at` integer NOT NULL,
	`next_check_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "chk_health_status" CHECK("system_health"."status" in ('ok','degraded','down','unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_health_check` ON `system_health` (`check_name`);--> statement-breakpoint

-- Étape 4 : les invariants du contenu (docs/03 §9.2, §9.3 et §15).
-- Les déclencheurs sont ajoutés au fichier généré par `drizzle-kit` : ils
-- portent ce que le code ne peut pas garantir (un bug d'API ou de worker ne doit
-- pas pouvoir réécrire une version ni approuver une affirmation non étayée).
-- Le motif est celui de 0002 : `RAISE(ABORT, 'code: message')`, avec le code
-- stable en premier pour que les tests puissent l'affirmer.

-- 1) Une version de contenu est **append-only** : elle ne se modifie pas, pas
-- même avant approbation. Seuls les champs d'approbation sont modifiables.
CREATE TRIGGER `trg_content_versions_immutable`
BEFORE UPDATE ON `content_versions`
FOR EACH ROW
WHEN NEW.`version_number` IS NOT OLD.`version_number`
  OR NEW.`content_item_id` IS NOT OLD.`content_item_id`
  OR NEW.`body` IS NOT OLD.`body`
  OR NEW.`title` IS NOT OLD.`title`
  OR NEW.`hook` IS NOT OLD.`hook`
  OR NEW.`hashtags_json` IS NOT OLD.`hashtags_json`
  OR NEW.`mentions_json` IS NOT OLD.`mentions_json`
  OR NEW.`char_count` IS NOT OLD.`char_count`
  OR NEW.`word_count` IS NOT OLD.`word_count`
  OR NEW.`generation` IS NOT OLD.`generation`
  OR NEW.`prompt_version_hash` IS NOT OLD.`prompt_version_hash`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'version_immuable: une version de contenu ne se modifie pas — toute modification cree une nouvelle version (docs/03 §9.2)');
END;--> statement-breakpoint

-- 2) La version courante appartient au contenu (docs/03 §15.1,
-- `trg_current_version_same_item`) : une version orpheline rendrait l'historique
-- incohérent — et `approved_version_id` servirait de preuve d'approbation.
CREATE TRIGGER `trg_current_version_same_item`
BEFORE UPDATE OF `current_version_id` ON `content_items`
FOR EACH ROW
WHEN NEW.`current_version_id` IS NOT NULL
  AND (SELECT `content_item_id` FROM `content_versions` WHERE `id` = NEW.`current_version_id`) IS NOT NEW.`id`
BEGIN
  SELECT RAISE(ABORT, 'version_courante_incoherente: la version courante n appartient pas a ce contenu (docs/03 §15.1)');
END;--> statement-breakpoint

-- 3) Le garde-fou anti-hallucination principal (docs/03 §9.3 et §15.1,
-- `trg_approval_requires_claims_ok`) : une affirmation à risque élevé non
-- étayée bloque l'approbation. Vide à l'étape 4 (le `fact_checker` arrive à
-- l'étape 5) — c'est précisément le genre de règle qu'il faut poser **avant**
-- d'en avoir besoin, sinon elle arrive après le premier contenu publié.
CREATE TRIGGER `trg_approval_requires_claims_ok`
BEFORE UPDATE ON `content_items`
FOR EACH ROW
WHEN NEW.`state` = 'approved' AND OLD.`state` IS NOT 'approved'
BEGIN
  SELECT RAISE(ABORT, 'approbation_refusee: une affirmation a risque eleve n est pas etayee (docs/03 §9.3)')
  WHERE EXISTS (
    SELECT 1
    FROM `content_claims`
    WHERE `content_claims`.`content_version_id` = NEW.`approved_version_id`
      AND `content_claims`.`risk` = 'eleve'
      AND `content_claims`.`status` <> 'supported'
  );
END;--> statement-breakpoint

-- 4) Une affirmation n'est « étayée » qu'avec une preuve : `supported` sans
-- source est une contradiction, et c'est une contradiction qui se propage dans
-- un contenu publié.
CREATE TRIGGER `trg_content_claims_supported_requires_evidence`
BEFORE INSERT ON `content_claims`
FOR EACH ROW
WHEN NEW.`status` = 'supported'
BEGIN
  SELECT RAISE(ABORT, 'claim_non_etaye: une affirmation supportee doit citer une preuve (docs/03 §9.3)')
  WHERE NEW.`evidence` IS NULL OR NEW.`evidence_source` IS NULL OR NEW.`evidence_source` = 'none';
END;--> statement-breakpoint

CREATE TRIGGER `trg_content_claims_evidence_on_update`
BEFORE UPDATE ON `content_claims`
FOR EACH ROW
WHEN NEW.`status` = 'supported'
BEGIN
  SELECT RAISE(ABORT, 'claim_non_etaye: une affirmation supportee doit citer une preuve (docs/03 §9.3)')
  WHERE NEW.`evidence` IS NULL OR NEW.`evidence_source` IS NULL OR NEW.`evidence_source` = 'none';
END;
