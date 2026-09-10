import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './users';

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

/** Faits durables du projet : expériences, chiffres, opinions, échecs. */
export const projectFacts = sqliteTable(
  'project_facts',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    category: text().notNull(), // 'experience'|'chiffre'|'opinion'|'projet'|'echec'|'ressource'|'contrainte'
    statement: text().notNull(),
    detail: text(),
    source: text().notNull(), // 'conversation'|'user_edit'|'user_import'
    // La contrainte vers `messages` (étape 2) est ajoutée par la migration qui crée
    // cette table : SQLite ne sait pas ajouter une FK sans reconstruire la table.
    source_message_id: text(),
    verified_by_user: integer({ mode: 'boolean' }).notNull().default(false),
    importance: integer().notNull().default(3), // 1–5
    used_count: integer().notNull().default(0),
    last_used_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    deleted_at: integer(),
  },
  (table) => [
    index('idx_facts_project').on(table.project_id, table.deleted_at),
    index('idx_facts_category').on(table.project_id, table.category),
    index('idx_facts_verified').on(table.project_id, table.verified_by_user),
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
