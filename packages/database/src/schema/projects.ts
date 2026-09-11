import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  type AnySQLiteColumn,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { users } from './users';
import { messages } from './conversation';

/**
 * Projets et mémoire longue — le différenciateur du produit (docs/03 §5, §6).
 * Sans cette mémoire, le produit n'est qu'un générateur de texte.
 */

export const projects = sqliteTable(
  'projects',
  {
    id: text().primaryKey(),
    owner_id: text()
      .notNull()
      .references(() => users.id),
    name: text().notNull(),
    slug: text().notNull().unique(),
    positioning: text(),
    status: text().notNull().default('discovery'), // 'discovery'|'active'|'paused'|'archived'
    target_goal: text(),
    start_date: integer(),
    timezone: text(), // hérité de app_settings si null
    language: text().notNull().default('fr'),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    archived_at: integer(),
  },
  (table) => [
    index('idx_projects_status').on(table.status),
    index('idx_projects_owner').on(table.owner_id),
  ],
);

export const projectGoals = sqliteTable(
  'project_goals',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    label: text().notNull(), // « publier 3×/semaine »
    metric: text().notNull(), // 'cadence'|'abonnes'|'vues'|'engagement'|'clics'|'ventes'
    target_value: integer(),
    current_value: integer(),
    period: text().notNull().default('month'),
    deadline: integer(),
    status: text().notNull().default('active'), // 'active'|'reached'|'missed'|'abandoned'
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [index('idx_project_goals_project').on(table.project_id, table.status)],
);

/**
 * Faits durables du projet : expériences, chiffres, opinions, échecs — **et**,
 * depuis l'étape 2, la connaissance du projet elle-même (motivation, problème
 * traité, stack, architecture, décisions, difficultés, erreurs, solutions,
 * apprentissages, état actuel, prochaines étapes, URLs, notes — docs/10 §4.2).
 *
 * Trois garanties sont portées par la **base** et non par le code (docs/03 §15.1) :
 * 1. un fait `verified` porte toujours une date de confirmation (`verified_at`) ;
 * 2. `verified_by_user` (colonne documentée) ne peut pas diverger de
 *    `verification_status` ;
 * 3. `superseded` ⇔ un successeur est enregistré : un fait remplacé ne peut pas
 *    perdre la trace de ce qui le remplace.
 */
export const projectFacts = sqliteTable(
  'project_facts',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    category: text().notNull(), // 'experience'|'chiffre'|…|'url'|'note' (voir FACT_CATEGORIES)
    statement: text().notNull(),
    detail: text(),
    source: text().notNull(), // 'user_input'|'user_edit'|'user_import'|'conversation'|'ai_proposal'
    // Contrainte ajoutée par la migration qui crée `messages` (SQLite ne sait pas
    // ajouter une clé étrangère sans reconstruire la table) : un fait extrait d'un
    // échange cite toujours le message dont il vient.
    source_message_id: text().references(() => messages.id),
    verified_by_user: integer({ mode: 'boolean' }).notNull().default(false),
    /**
     * `proposed` | `user_provided` | `verified` | `uncertain` | `obsolete` | `superseded`.
     * Distinct de `verified_by_user` (booléen documenté, conservé) : quatre états
     * ne tiennent pas dans un booléen (docs/10 §4.2).
     */
    verification_status: text().notNull().default('user_provided'),
    /** Raison lisible d'un état `uncertain`, `obsolete` ou `superseded`. */
    verification_note: text(),
    /** Date de la confirmation humaine : renseignée ⇔ `verified`. */
    verified_at: integer(),
    /** Fait que celui-ci remplace (chaîne d'historique explicite). */
    supersedes_fact_id: text().references((): AnySQLiteColumn => projectFacts.id),
    /** Fait qui remplace celui-ci : renseigné ⇔ `verification_status = 'superseded'`. */
    superseded_by_fact_id: text().references((): AnySQLiteColumn => projectFacts.id),
    superseded_at: integer(),
    importance: integer().notNull().default(3), // 1–5
    used_count: integer().notNull().default(0),
    last_used_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    /** Jamais utilisé pour la mémoire de projet : un fait ne se supprime pas (docs/03 §16.1). */
    deleted_at: integer(),
  },
  (table) => [
    index('idx_facts_project').on(table.project_id, table.deleted_at),
    index('idx_facts_category').on(table.project_id, table.category),
    index('idx_facts_verified').on(table.project_id, table.verified_by_user),
    // Requête réelle : « les faits d'un projet, par état de vérification » (API étape 2).
    index('idx_facts_verification').on(table.project_id, table.verification_status),
    // Un fait ne peut être remplacé qu'une fois : sinon l'historique se contredit.
    uniqueIndex('uq_facts_supersedes').on(table.supersedes_fact_id),
    check(
      'chk_facts_verified_at',
      sql`(${table.verification_status} <> 'verified') OR (${table.verified_at} IS NOT NULL)`,
    ),
    check(
      'chk_facts_verified_by_user',
      sql`(${table.verified_by_user} = 1) = (${table.verification_status} = 'verified')`,
    ),
    check(
      'chk_facts_supersede_link',
      sql`(${table.verification_status} = 'superseded') = (${table.superseded_by_fact_id} IS NOT NULL)`,
    ),
    check('chk_facts_importance', sql`${table.importance} BETWEEN 1 AND 5`),
  ],
);

/**
 * **Table critique** : une compétence n'est pas une automatisation (docs/03 §6.2).
 * Elle ne contient que ce que l'utilisateur maîtrise ou apprend activement.
 */
export const projectSkillFacts = sqliteTable(
  'project_skill_facts',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    skill: text().notNull(),
    level: text().notNull(), // 'debutant'|'intermediaire'|'avance'|'expert'
    evidence: text(),
    learned_how: text(), // 'autodidacte'|'formation'|'projet'|'travail'|'en_apprentissage'
    is_learning: integer({ mode: 'boolean' }).notNull().default(false),
    learning_target: text(),
    confidence: integer().notNull().default(3), // 1–5
    last_updated_at: integer().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [uniqueIndex('uq_skill_project').on(table.project_id, table.skill)],
);

export const styleProfiles = sqliteTable(
  'style_profiles',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    name: text().notNull(),
    scope: text().notNull().default('project'), // 'project' | 'platform'
    platform: text(), // requis si scope = 'platform'
    tone: text(), // 'pedagogue'|'direct'|'chaleureux'|'technique'|'provocateur'
    formality: integer().notNull().default(3), // 1 (tu) → 5 (vouvoiement strict)
    sentence_length: text(),
    humor_level: integer().notNull().default(2), // 0–5
    emoji_level: integer().notNull().default(2), // 0–5
    forbidden_words_json: text(),
    signature_openings_json: text(),
    signature_closings_json: text(),
    example_paragraphs_json: text(), // 3–5 exemples RÉELS de l'utilisateur
    derived_from_texts: integer().notNull().default(0),
    confidence: integer().notNull().default(1), // 1–5
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_style_scope').on(table.project_id, table.scope, table.platform),
    index('idx_style_project').on(table.project_id),
  ],
);

export const audienceProfiles = sqliteTable(
  'audience_profiles',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    name: text().notNull(),
    description: text(),
    pain_points_json: text(),
    goals_json: text(),
    objections_json: text(),
    knowledge_level: text().notNull(), // 'debutant'|'intermediaire'|'avance'
    vocabulary_json: text(),
    platforms_json: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [index('idx_audience_project').on(table.project_id)],
);
