import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { contentItems, contentVersions } from './editorial';
import { projects } from './projects';

/** Comptes préparés pour les connecteurs futurs ; l'étape 5 n'effectue aucun appel social. */
export const platformAccounts = sqliteTable(
  'platform_accounts',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    platform: text().notNull(),
    account_label: text().notNull(),
    remote_account_id: text(),
    access_token_encrypted: text(),
    refresh_token_encrypted: text(),
    token_key_version: integer().notNull().default(1),
    scopes_json: text(),
    token_expires_at: integer(),
    capabilities_json: text(),
    connection_state: text().notNull().default('disconnected'),
    last_ok_at: integer(),
    last_error: text(),
    last_rate_limit_at: integer(),
    rate_limit_reset_at: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_platform_account').on(
      table.project_id,
      table.platform,
      table.remote_account_id,
    ),
    index('idx_accounts_state').on(table.platform, table.connection_state),
    index('idx_accounts_expiry').on(table.token_expires_at),
    check(
      'chk_accounts_state',
      sql`${table.connection_state} in ('connected','expired','revoked','disconnected','rate_limited')`,
    ),
  ],
);

export const projectPlatforms = sqliteTable(
  'project_platforms',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    platform: text().notNull(),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    priority: integer().notNull().default(0),
    purposes_json: text(),
    cadence_per_week: integer(),
    default_account_id: text().references(() => platformAccounts.id),
    created_at: integer().notNull(),
  },
  (table) => [uniqueIndex('uq_project_platform').on(table.project_id, table.platform)],
);

export const manualPackages = sqliteTable(
  'manual_packages',
  {
    id: text().primaryKey(),
    content_item_id: text()
      .notNull()
      .references(() => contentItems.id),
    content_version_id: text()
      .notNull()
      .references(() => contentVersions.id),
    platform: text().notNull(),
    body_text: text().notNull(),
    title_text: text(),
    copy_blocks_json: text(),
    asset_paths_json: text(),
    instructions: text(),
    deep_link: text(),
    downloaded_at: integer(),
    marked_published_at: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    index('idx_manual_item').on(table.content_item_id, table.platform),
    uniqueIndex('uq_manual_version_platform').on(table.content_version_id, table.platform),
  ],
);

export const publications = sqliteTable(
  'publications',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    content_item_id: text()
      .notNull()
      .references(() => contentItems.id),
    content_version_id: text()
      .notNull()
      .references(() => contentVersions.id),
    platform_account_id: text()
      .notNull()
      .references(() => platformAccounts.id),
    platform: text().notNull(),
    status: text().notNull().default('planned'),
    scheduled_for: integer(),
    idempotency_key: text().notNull(),
    remote_id: text(),
    remote_url: text(),
    remote_status: text(),
    manual_package_id: text().references(() => manualPackages.id),
    first_attempt_at: integer(),
    published_at: integer(),
    last_attempt_at: integer(),
    attempt_count: integer().notNull().default(0),
    needs_human_decision: integer({ mode: 'boolean' }).notNull().default(false),
    decision_note: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_publication_version_account').on(
      table.content_version_id,
      table.platform_account_id,
    ),
    uniqueIndex('uq_publication_idempotency').on(table.idempotency_key),
    index('idx_publications_schedule').on(table.status, table.scheduled_for),
    index('idx_publications_item').on(table.content_item_id, table.status),
    index('idx_publications_platform').on(table.platform, table.published_at),
    check(
      'chk_publications_status',
      sql`${table.status} in ('planned','queued','publishing','published','failed','ambiguous','manual_required','cancelled')`,
    ),
  ],
);

export const publicationAttempts = sqliteTable(
  'publication_attempts',
  {
    id: text().primaryKey(),
    publication_id: text()
      .notNull()
      .references(() => publications.id),
    attempt_number: integer().notNull(),
    started_at: integer().notNull(),
    finished_at: integer(),
    outcome: text().notNull(),
    http_status: integer(),
    request_json: text(),
    response_json: text(),
    error_code: text(),
    error_message: text(),
    duration_ms: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_attempt_number').on(table.publication_id, table.attempt_number),
    index('idx_attempts_outcome').on(table.outcome, table.created_at),
  ],
);
