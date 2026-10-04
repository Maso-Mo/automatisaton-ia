import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';

/**
 * Veille — tables amorcées à l'étape 7, complétées à l'étape 10 par les champs de
 * normalisation, scoring explicable, vérification et suggestion éditoriale.
 */

/** Une source de veille déclarée par l'utilisateur (docs/03 §13.1). */
export const newsSources = sqliteTable(
  'news_sources',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    name: text().notNull(),
    kind: text().notNull(),
    url: text(),
    categories_json: text(),
    keywords_json: text(),
    exclude_keywords_json: text(),
    language: text(),
    /** 1–5 : pondère le scoring local (étape 10). */
    authority: integer().notNull().default(3),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    refresh_hours: integer().notNull().default(12),
    last_fetch_at: integer(),
    last_success_at: integer(),
    last_error: text(),
    /** Après 5 échecs consécutifs, la source est désactivée (docs/03 §13.1). */
    consecutive_failures: integer().notNull().default(0),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index('idx_sources_due').on(table.enabled, table.last_fetch_at),
    uniqueIndex('uq_source_url').on(table.project_id, table.url),
    check('chk_sources_kind', sql`${table.kind} in ('rss','atom','web','api','manual')`),
    check('chk_sources_authority', sql`${table.authority} between 1 and 5`),
    check('chk_sources_refresh', sql`${table.refresh_hours} > 0`),
    check('chk_sources_failures', sql`${table.consecutive_failures} >= 0`),
  ],
);

/**
 * Une actualité **récupérée**, jamais inventée (docs/03 §13.2).
 *
 * `verified` reste à `true` par défaut et n'est jamais forcé : il n'existe que
 * pour trahir un cas anormal — une ligne insérée sans récupération réelle.
 */
export const newsItems = sqliteTable(
  'news_items',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    source_id: text()
      .notNull()
      .references(() => newsSources.id),
    external_id: text(),
    title: text().notNull(),
    summary: text(),
    url: text().notNull(),
    canonical_url: text(),
    author: text(),
    published_at: integer(),
    fetched_at: integer().notNull(),
    language: text(),
    /** La charge utile d'origine : l'utilisateur peut cliquer et vérifier. */
    raw_json: text(),
    content_hash: text().notNull(),
    relevance_score: integer(),
    freshness_score: integer(),
    authority_score: integer(),
    novelty_score: integer(),
    project_match_score: integer(),
    audience_match_score: integer(),
    final_score: integer(),
    score_explanation_json: text(),
    topic_tags_json: text(),
    matched_skill: text(),
    urgency: text().notNull().default('NORMAL'),
    verification_status: text().notNull().default('source_confirmed'),
    claims_json: text(),
    suggestion_json: text(),
    status: text().notNull().default('new'),
    dismissal_reason: text(),
    verified: integer({ mode: 'boolean' }).notNull().default(true),
    llm_enriched: integer({ mode: 'boolean' }).notNull().default(false),
    created_at: integer().notNull(),
    expires_at: integer(),
  },
  (table) => [
    uniqueIndex('uq_news_hash').on(table.project_id, table.content_hash),
    uniqueIndex('uq_news_external').on(table.source_id, table.external_id),
    index('idx_news_canonical').on(table.project_id, table.canonical_url),
    index('idx_news_ranking').on(table.project_id, table.status, table.final_score),
    index('idx_news_fresh').on(table.project_id, table.published_at),
    index('idx_news_expiry').on(table.status, table.expires_at),
    check(
      'chk_news_status',
      sql`${table.status} in ('new','shortlisted','used','dismissed','expired')`,
    ),
    check(
      'chk_news_scores',
      sql`(${table.relevance_score} is null or ${table.relevance_score} between 0 and 100)
          and (${table.freshness_score} is null or ${table.freshness_score} between 0 and 100)
          and (${table.authority_score} is null or ${table.authority_score} between 0 and 100)
          and (${table.novelty_score} is null or ${table.novelty_score} between 0 and 100)
          and (${table.project_match_score} is null or ${table.project_match_score} between 0 and 100)
          and (${table.audience_match_score} is null or ${table.audience_match_score} between 0 and 100)
          and (${table.final_score} is null or ${table.final_score} between 0 and 100)`,
    ),
    check('chk_news_urgency', sql`${table.urgency} in ('BREAKING','HIGH','NORMAL','EVERGREEN')`),
    check(
      'chk_news_verification',
      sql`${table.verification_status} in ('source_confirmed','needs_review','confirmed','disputed')`,
    ),
  ],
);
