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
	FOREIGN KEY (`supersedes_fact_id`) REFERENCES `project_facts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_fact_id`) REFERENCES `project_facts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "chk_facts_verified_at" CHECK(("__new_project_facts"."verification_status" <> 'verified') OR ("__new_project_facts"."verified_at" IS NOT NULL)),
	CONSTRAINT "chk_facts_verified_by_user" CHECK(("__new_project_facts"."verified_by_user" = 1) = ("__new_project_facts"."verification_status" = 'verified')),
	CONSTRAINT "chk_facts_supersede_link" CHECK(("__new_project_facts"."verification_status" = 'superseded') = ("__new_project_facts"."superseded_by_fact_id" IS NOT NULL)),
	CONSTRAINT "chk_facts_importance" CHECK("__new_project_facts"."importance" BETWEEN 1 AND 5)
);
--> statement-breakpoint
INSERT INTO `__new_project_facts`("id", "project_id", "category", "statement", "detail", "source", "source_message_id", "verified_by_user", "verification_status", "verified_at", "importance", "used_count", "last_used_at", "created_at", "updated_at", "deleted_at") SELECT "id", "project_id", "category", "statement", "detail", "source", "source_message_id", "verified_by_user", CASE WHEN "verified_by_user" = 1 THEN 'verified' ELSE 'user_provided' END, CASE WHEN "verified_by_user" = 1 THEN "updated_at" ELSE NULL END, "importance", "used_count", "last_used_at", "created_at", "updated_at", "deleted_at" FROM `project_facts`;--> statement-breakpoint
DROP TABLE `project_facts`;--> statement-breakpoint
ALTER TABLE `__new_project_facts` RENAME TO `project_facts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_facts_project` ON `project_facts` (`project_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `idx_facts_category` ON `project_facts` (`project_id`,`category`);--> statement-breakpoint
CREATE INDEX `idx_facts_verified` ON `project_facts` (`project_id`,`verified_by_user`);--> statement-breakpoint
CREATE INDEX `idx_facts_verification` ON `project_facts` (`project_id`,`verification_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_facts_supersedes` ON `project_facts` (`supersedes_fact_id`);--> statement-breakpoint
-- ---------------------------------------------------------------------------
-- Fin de la partie générée par Drizzle Kit (drizzle-kit generate). Ce qui suit
-- est écrit à la main, comme le prévoit docs/03 §16.3 pour les déclencheurs :
-- Drizzle ne les modélise pas, et un déclencheur oublié est un invariant perdu.
-- ---------------------------------------------------------------------------
-- La mémoire longue ne se supprime pas (docs/03 §16.1) : « supprimer une
-- mémoire détruit le différenciateur du produit ». Un fait s'invalide
-- (`obsolete`) ou se remplace (`superseded`) — il ne disparaît jamais. Le
-- déclencheur rend la suppression physique impossible, y compris depuis une
-- requête manuelle ou un script d'administration.
CREATE TRIGGER `trg_project_facts_no_delete`
BEFORE DELETE ON `project_facts`
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'suppression_interdite: un fait de projet se declare obsolete ou remplace, il ne se supprime pas');
END;--> statement-breakpoint
-- Une proposition de l'IA ne peut pas être confirmée sans acte humain : la
-- confirmation est un geste explicite, daté (`verified_at`), et le domaine seul
-- l'écrit. Le déclencheur refuse l'inverse — un fait `verified` sans date de
-- confirmation — même écrit directement en SQL.
CREATE TRIGGER `trg_project_facts_verification_requires_human`
BEFORE INSERT ON `project_facts`
FOR EACH ROW
WHEN NEW.`verification_status` = 'verified' AND NEW.`verified_at` IS NULL
BEGIN
  SELECT RAISE(ABORT, 'verification_refusee: un fait confirme doit porter une date de confirmation humaine');
END;