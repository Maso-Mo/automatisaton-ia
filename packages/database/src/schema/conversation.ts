import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';
import { llmCalls } from './system';

/**
 * Conversation et fiche maître (docs/03 §7, §8.1) — l'entrée du produit.
 *
 * « On n'ouvre pas un formulaire : on parle. » Ces quatre tables portent
 * l'entretien : la conversation et son état d'avancement, ses messages, ses
 * résumés par paliers, et la fiche maître qui en sort.
 *
 * Trois garanties sont portées par la **base**, pas par le code (docs/03 §15.1) :
 *
 * 1. un message est **auditable** : il ne se supprime pas (la corbeille se fait
 *    par `deleted_at`, un déclencheur refuse `DELETE`) ;
 * 2. une fiche maître **validée** porte toujours la date de validation humaine,
 *    et `superseded` ⇔ un successeur est enregistré ;
 * 3. une conversation `closed` porte toujours sa date de clôture.
 */

export const conversations = sqliteTable(
  'conversations',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    title: text(), // généré après 3 messages
    kind: text().notNull().default('interview'),
    // 'intake'|'positioning'|'audience'|'voice'|'fact_extraction'|'strategy'|'brief_ready'|'closed'
    stage: text().notNull().default('intake'),
    /**
     * Ce qu'il reste à apprendre : `['voice','audience']`. **C'est la clé du
     * produit** : recalculé localement après chaque tour, il garantit qu'une
     * question déjà répondue par la mémoire n'est jamais reposée (docs/03 §7.1).
     */
    missing_slots_json: text(),
    model_used: text(),
    message_count: integer().notNull().default(0),
    last_message_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    closed_at: integer(),
  },
  (table) => [
    index('idx_conversations_project').on(table.project_id, table.last_message_at),
    index('idx_conversations_stage').on(table.project_id, table.stage),
    check(
      'chk_conversations_stage',
      sql`${table.stage} IN ('intake','positioning','audience','voice','fact_extraction','strategy','brief_ready','closed')`,
    ),
    check(
      'chk_conversations_kind',
      sql`${table.kind} IN ('interview','news_discussion','feedback','freeform')`,
    ),
    check('chk_conversations_message_count', sql`${table.message_count} >= 0`),
    check(
      'chk_conversations_closed_at',
      sql`(${table.stage} <> 'closed') OR (${table.closed_at} IS NOT NULL)`,
    ),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    id: text().primaryKey(),
    conversation_id: text()
      .notNull()
      .references(() => conversations.id),
    role: text().notNull(), // 'user'|'assistant'|'system'|'tool'
    content: text(),
    content_json: text(), // messages structurés (questions, options, propositions)
    message_type: text().notNull().default('text'),
    // 'text'|'question'|'options'|'proposal'|'confirmation'|'error'
    agent: text(), // agent émetteur si role = 'assistant'
    input_mode: text(), // 'text'|'voice'|'file'
    // `media_assets` est créée à l'étape média : colonne posée maintenant,
    // contrainte de clé étrangère ajoutée par la migration de cette table.
    audio_asset_id: text(),
    transcript_status: text(), // null si non vocal ; 'pending'|'done'|'failed'
    tokens_in: integer(),
    tokens_out: integer(),
    cost_micro_usd: integer().notNull().default(0),
    llm_call_id: text().references(() => llmCalls.id),
    parent_message_id: text(), // questions à options multiples
    created_at: integer().notNull(),
    edited_at: integer(),
    deleted_at: integer(), // corbeille logique : jamais une suppression physique
  },
  (table) => [
    index('idx_messages_conversation').on(table.conversation_id, table.created_at),
    index('idx_messages_role').on(table.conversation_id, table.role),
    check('chk_messages_role', sql`${table.role} IN ('user','assistant','system','tool')`),
    check(
      'chk_messages_type',
      sql`${table.message_type} IN ('text','question','options','proposal','confirmation','error')`,
    ),
    check(
      'chk_messages_input_mode',
      sql`${table.input_mode} IS NULL OR ${table.input_mode} IN ('text','voice','file')`,
    ),
    check('chk_messages_cost', sql`${table.cost_micro_usd} >= 0`),
    // Un message vide n'existe pas : il porte du texte ou une structure.
    check(
      'chk_messages_content',
      sql`${table.content} IS NOT NULL OR ${table.content_json} IS NOT NULL`,
    ),
  ],
);

/**
 * Résumé cumulatif par paliers (docs/03 §7.4) : un résumé couvre des blocs de
 * 20 messages. C'est ce qui borne le coût d'un entretien long : 80 messages ne
 * coûtent pas 8 fois plus cher que 10.
 */
export const conversationSummaries = sqliteTable(
  'conversation_summaries',
  {
    id: text().primaryKey(),
    conversation_id: text()
      .notNull()
      .references(() => conversations.id),
    scope: text().notNull(), // 'rolling' | 'final'
    from_message_index: integer().notNull(),
    to_message_index: integer().notNull(),
    summary: text().notNull(),
    decisions_json: text(),
    facts_extracted_json: text(),
    tokens_saved_estimate: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    index('idx_summaries_conversation').on(table.conversation_id, table.scope, table.created_at),
    check('chk_summaries_scope', sql`${table.scope} IN ('rolling','final')`),
    check('chk_summaries_range', sql`${table.from_message_index} <= ${table.to_message_index}`),
  ],
);

/**
 * La **fiche maître** : la synthèse validée d'un entretien, dont tout le reste
 * découle (docs/03 §8.1). Elle est **immuable** : une modification crée une
 * nouvelle version, l'ancienne passe en `superseded` avec un lien
 * `superseded_by_id`. Un contenu généré reste rattaché à la version qui l'a
 * produit — sinon on ne saurait plus ce qui a été rédigé à partir de quoi.
 */
export const masterBriefs = sqliteTable(
  'master_briefs',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    conversation_id: text()
      .notNull()
      .references(() => conversations.id),
    version: integer().notNull().default(1),
    status: text().notNull().default('draft'), // 'draft'|'validated'|'superseded'
    summary: text().notNull(),
    positioning: text().notNull(),
    target_audience: text().notNull(),
    content_pillars_json: text().notNull(),
    themes_json: text().notNull(),
    formats_json: text(),
    skill_map_json: text(),
    /** Ce que l'utilisateur ne maîtrise PAS : utilisé en négatif, jamais en positif. */
    gaps_json: text(),
    cadence_json: text(),
    success_criteria_json: text(),
    source_message_ids_json: text(), // traçabilité : quels messages ont produit la fiche
    llm_call_id: text().references(() => llmCalls.id),
    validated_at: integer(),
    superseded_by_id: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index('idx_briefs_project').on(table.project_id, table.status),
    uniqueIndex('uq_brief_version').on(table.conversation_id, table.version),
    check('chk_briefs_status', sql`${table.status} IN ('draft','validated','superseded')`),
    check('chk_briefs_version', sql`${table.version} >= 1`),
    check(
      'chk_briefs_validated_at',
      sql`(${table.status} <> 'validated') OR (${table.validated_at} IS NOT NULL)`,
    ),
    check(
      'chk_briefs_supersede_link',
      sql`(${table.status} = 'superseded') = (${table.superseded_by_id} IS NOT NULL)`,
    ),
  ],
);
