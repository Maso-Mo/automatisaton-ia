import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';

/**
 * Système, jobs et observabilité (docs/03 §14). La file **vit en base** : il n'y
 * a ni Redis ni courtier de messages en V1, donc la même table porte la file,
 * le lease et l'historique (docs/08 §1).
 */

export const jobs = sqliteTable(
  'jobs',
  {
    id: text().primaryKey(),
    type: text().notNull(), // 'noop','transcribe_media','render_video','publish_content'…
    status: text().notNull().default('queued'),
    // 'queued'|'running'|'completed'|'failed'|'cancelled'|'dead'
    priority: integer().notNull().default(5), // 1 (urgent) – 9 (batch)
    input_json: text().notNull(),
    output_json: text(),
    error_json: text(),
    project_id: text().references(() => projects.id),
    // Références vers des tables d'étapes ultérieures (`content_items` : étape 4,
    // `publications` : étape 5) : colonnes créées maintenant, contrainte de clé
    // étrangère ajoutée par la migration qui crée la table cible.
    content_item_id: text(),
    publication_id: text(),
    dedupe_key: text(), // un seul job en attente par clé logique
    idempotent: integer({ mode: 'boolean' }).notNull().default(false),
    scheduled_for: integer().notNull(),
    available_at: integer().notNull(),
    attempt: integer().notNull().default(0),
    max_attempts: integer().notNull().default(3),
    worker_id: text(),
    lease_expires_at: integer(),
    heartbeat_at: integer(),
    progress: integer().notNull().default(0),
    current_step: text(),
    started_at: integer(),
    finished_at: integer(),
    duration_ms: integer(),
    cost_micro_usd: integer().notNull().default(0),
    parent_job_id: text(),
    requires_network: integer({ mode: 'boolean' }).notNull().default(false),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    index('idx_jobs_claim').on(table.status, table.available_at, table.priority),
    // Anti-doublon : dix clics sur « régénérer » ne doivent pas coûter dix fois.
    uniqueIndex('uq_jobs_dedupe')
      .on(table.type, table.dedupe_key)
      .where(sql`${table.status} in ('queued','running') and ${table.dedupe_key} is not null`),
    index('idx_jobs_lease').on(table.status, table.lease_expires_at),
    index('idx_jobs_item').on(table.content_item_id, table.type, table.status),
    index('idx_jobs_schedule').on(table.status, table.scheduled_for),
  ],
);

/** Journal append-only d'un job : ce que l'interface affiche en temps réel (SSE). */
export const jobEvents = sqliteTable(
  'job_events',
  {
    id: text().primaryKey(),
    job_id: text()
      .notNull()
      .references(() => jobs.id),
    sequence: integer().notNull(), // 1, 2, 3… strictement croissant par job
    level: text().notNull(), // 'debug'|'info'|'warn'|'error'
    step: text(),
    message: text().notNull(),
    data_json: text(),
    progress: integer(),
    duration_ms: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_job_sequence').on(table.job_id, table.sequence),
    index('idx_events_job').on(table.job_id, table.sequence),
    index('idx_events_retention').on(table.created_at),
  ],
);

/** **Chaque** appel à un modèle, sans exception : c'est ce qui rend le budget possible. */
export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: text().primaryKey(),
    job_id: text().references(() => jobs.id),
    project_id: text().references(() => projects.id),
    // `conversations` arrive à l'étape 2, `content_items` à l'étape 4.
    conversation_id: text(),
    content_item_id: text(),
    agent: text(), // 'strategist','copywriter','critic','fact_checker','analyst'
    task: text().notNull(),
    provider: text().notNull(),
    model: text().notNull(),
    prompt_version_id: text().references(() => promptVersions.id),
    context_fingerprint: text(), // sha256 du contexte exact envoyé
    request_json: text().notNull(), // messages complets (sans secret)
    response_json: text(),
    prompt_tokens: integer(),
    completion_tokens: integer(),
    cached_tokens: integer(),
    total_tokens: integer(),
    cost_micro_usd: integer().notNull().default(0),
    currency: text().notNull().default('USD'),
    latency_ms: integer(),
    ttft_ms: integer(),
    status: text().notNull(), // 'success'|'error'|'timeout'|'rate_limited'|'refused'
    error_code: text(),
    retried_from_id: text(),
    finish_reason: text(),
    temperature_x100: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    index('idx_calls_project_time').on(table.project_id, table.created_at),
    index('idx_calls_task').on(table.task, table.created_at),
    index('idx_calls_agent').on(table.agent, table.created_at),
    index('idx_calls_status').on(table.status, table.created_at),
    index('idx_calls_cost').on(table.created_at, table.cost_micro_usd),
  ],
);

/**
 * Les prompts sont des **fichiers du dépôt**, synchronisés en base au démarrage.
 * La base ne contient qu'un index : le contenu reste dans Git (docs/03 §14.4).
 */
export const promptVersions = sqliteTable(
  'prompt_versions',
  {
    id: text().primaryKey(),
    agent: text().notNull(),
    task: text().notNull(),
    file_path: text().notNull(),
    content_hash: text().notNull(), // sha256 du contenu du fichier
    git_commit: text(),
    version_label: text(),
    is_active: integer({ mode: 'boolean' }).notNull().default(true),
    notes: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_prompt_hash').on(table.agent, table.task, table.content_hash),
    index('idx_prompts_active').on(table.agent, table.task, table.is_active),
  ],
);
