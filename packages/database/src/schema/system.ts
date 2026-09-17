import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
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
    /**
     * Contenu visé, **sans contrainte de clé étrangère** : `content_items` est
     * archivé, jamais supprimé (docs/03 §2.6), donc la contrainte n'apporterait
     * qu'un cycle de dépendances entre le schéma éditorial et la file. La
     * cohérence est garantie par le domaine, qui refuse de mettre en file un job
     * dont la cible n'existe pas — et le rattrapage lit `content_item_id` tel
     * quel.
     */
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
    // `conversations` (étape 2) et `content_items` (étape 4) sont suivis par
    // identifiant, sans contrainte : un appel LLM doit rester lisible même si le
    // contenu a été archivé, et l'observabilité ne dépend pas du domaine.
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

/**
 * Le journal **centralisé** des erreurs, au-delà de celles des jobs
 * (docs/03 §14.5). `fingerprint` regroupe les erreurs identiques : sans lui, un
 * flux mort produit 200 lignes et masque l'erreur unique qui compte.
 *
 * `resolved_at` fait partie de la clé d'unicité : la même erreur peut
 * réapparaître **après** correction, et cette réapparition doit créer une
 * nouvelle entrée — « toujours cassé » et « recassé » ne se traitent pas pareil.
 */
export const errors = sqliteTable(
  'errors',
  {
    id: text().primaryKey(),
    /** Hash(type + message normalisé + origine). */
    fingerprint: text().notNull(),
    severity: text().notNull(),
    surface: text().notNull(),
    /** Classe d'erreur du domaine : `AppError.code` quand il existe. */
    error_type: text().notNull(),
    message: text().notNull(),
    stack: text(),
    context_json: text(),
    job_id: text(),
    content_item_id: text(),
    publication_id: text(),
    provider: text(),
    http_status: integer(),
    retryable: integer({ mode: 'boolean' }).notNull().default(false),
    occurrence_count: integer().notNull().default(1),
    first_seen_at: integer().notNull(),
    last_seen_at: integer().notNull(),
    resolved_at: integer(),
    resolution_note: text(),
  },
  (table) => [
    uniqueIndex('uq_error_fingerprint').on(table.fingerprint, table.resolved_at),
    index('idx_errors_recent').on(table.last_seen_at, table.severity),
    index('idx_errors_surface').on(table.surface, table.last_seen_at),
    check('chk_errors_severity', sql`${table.severity} in ('warning','error','fatal')`),
    check(
      'chk_errors_surface',
      sql`${table.surface} in ('api','worker','ui','connector','llm','fs')`,
    ),
  ],
);

/**
 * Un **unique** enregistrement par contrôle (docs/03 §14.6) : l'état présent,
 * pas un historique. `consecutive_failures` évite d'alerter sur un incident
 * transitoire — on n'avertit qu'après trois échecs consécutifs.
 */
export const systemHealth = sqliteTable(
  'system_health',
  {
    id: text().primaryKey(),
    check_name: text().notNull(),
    status: text().notNull(),
    message: text(),
    details_json: text(),
    latency_ms: integer(),
    checked_at: integer().notNull(),
    next_check_at: integer(),
    consecutive_failures: integer().notNull().default(0),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_health_check').on(table.check_name),
    check('chk_health_status', sql`${table.status} in ('ok','degraded','down','unknown')`),
  ],
);

/**
 * Le canal par lequel le produit parle à l'utilisateur **sans l'interrompre**
 * (docs/03 §14.7). `dedupe_key` n'admet qu'une notification active par cause :
 * trois échecs de publication ne font pas trois notifications identiques.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text().primaryKey(),
    project_id: text().references(() => projects.id),
    kind: text().notNull(),
    severity: text().notNull(),
    title: text().notNull(),
    body: text(),
    /** Route interne vers l'écran concerné : une notification doit être actionnable. */
    action_url: text(),
    action_label: text(),
    related_type: text(),
    related_id: text(),
    dedupe_key: text().notNull(),
    read_at: integer(),
    dismissed_at: integer(),
    acted_at: integer(),
    created_at: integer().notNull(),
    expires_at: integer(),
  },
  (table) => [
    uniqueIndex('uq_notification_dedupe').on(table.dedupe_key),
    index('idx_notifications_unread').on(table.read_at, table.created_at),
    index('idx_notifications_project').on(table.project_id, table.created_at),
    check('chk_notifications_severity', sql`${table.severity} in ('info','attention','urgent')`),
  ],
);
