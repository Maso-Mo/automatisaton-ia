import {
  applyMigrations,
  countJobsByStatus,
  createProjectMemoryStore,
  getJob,
  isMigrated,
  isWalEnabled,
  lastCompletedJob,
  latestHeartbeatAt,
  listJobEvents,
  listJobs,
  listTables,
  openDatabase,
  promptSummary,
  sqliteVersion,
  STEP_ONE_TABLE_NAMES,
  type DatabaseHandle,
  type JobRow,
} from '@aia/database';
import { createBudgetPort, type BudgetPort } from '@aia/analytics';
import {
  describeConfig,
  ensureLocalDirectories,
  loadConfig,
  SECRET_ENV_KEYS,
  type Config,
} from '@aia/config';
import { createLogger, type AppLogger } from '@aia/observability';
import { loadActivePrompt, syncPrompts, readGitCommit } from '@aia/ai';
import {
  getSystemHealth,
  type ProjectMemoryPorts,
  type SystemHealth,
  type SystemHealthPorts,
} from '@aia/core';
import { createSystemClock, uuidv7, type Clock } from '@aia/shared';

const APP_VERSION = '0.1.0';
const STARTED_AT = Date.now();

/**
 * Composition root de l'API. Contrairement au worker, l'API **ne construit ni
 * file exécutable ni registry de jobs** : elle lit l'état, sert le diagnostic
 * et, depuis l'étape 2, la mémoire des projets (lecture **et** écriture).
 * Aucune autre route d'action n'existe : chaque fonctionnalité arrive avec
 * l'étape qui la spécifie (docs/10 §4.1, §4.2).
 */
export interface ApiContext {
  config: Config;
  handle: DatabaseHandle;
  logger: AppLogger;
  clock: Clock;
  budget: BudgetPort;
  startedAtMs: number;
  /** Ports du domaine « mémoire des projets » — c'est `core` qui décide. */
  memory: ProjectMemoryPorts;
  health(): SystemHealth;
  jobs(filter?: { statuses?: JobRow['status'][]; limit?: number }): JobRow[];
  job(id: string): JobRow | undefined;
  jobEvents(id: string, afterSequence?: number, limit?: number): ReturnType<typeof listJobEvents>;
}

export function buildApi(
  overrides: { config?: Config; logger?: AppLogger; clock?: Clock } = {},
): ApiContext {
  const config = overrides.config ?? loadConfig();
  ensureLocalDirectories(config);

  const logger =
    overrides.logger ??
    createLogger({
      level: config.env.LOG_LEVEL,
      pretty: config.env.LOG_PRETTY && config.env.APP_ENV !== 'production',
      name: 'api',
    });

  const clock = overrides.clock ?? createSystemClock();
  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });

  const migration = applyMigrations(handle);
  logger.info(
    { applied: migration.applied, total: migration.total },
    'migrations de base vérifiées',
  );
  logger.info({ configuration: describeConfig(config) }, 'configuration chargée');

  if (!isMigrated(handle, STEP_ONE_TABLE_NAMES)) {
    handle.close();
    throw new Error(
      'Schéma incomplet : la base ne contient pas les 13 tables de l’étape 1. Lancer « pnpm db:migrate ».',
    );
  }

  syncPrompts({
    handle,
    promptsDir: config.paths.promptsDir,
    clock,
    logger,
    gitCommit: readGitCommit(),
  });

  const budget = createBudgetPort({
    handle,
    clock,
    limits: {
      dailyUsd: config.env.DAILY_BUDGET_USD,
      monthlyUsd: config.env.MONTHLY_BUDGET_USD,
      dailyTokenLimit: config.env.DAILY_TOKEN_LIMIT,
    },
  });

  const ports: SystemHealthPorts = {
    app: {
      name: 'automatisation-ia',
      version: APP_VERSION,
      env: config.env.APP_ENV,
      host: config.env.APP_HOST,
      port: config.env.APP_PORT,
    },
    expectedTables: STEP_ONE_TABLE_NAMES,
    startedAtMs: STARTED_AT,
    clock,
    database: {
      sqliteVersion: () => sqliteVersion(handle),
      tables: () => listTables(handle),
      appliedMigrations: () => migration.total,
      walEnabled: () => isWalEnabled(handle),
    },
    queue: {
      counts: () => countJobsByStatus(handle),
      latestHeartbeatAt: () => latestHeartbeatAt(handle),
      lastCompletedJob: () => {
        const row = lastCompletedJob(handle);
        return row
          ? {
              id: row.id,
              type: row.type,
              finishedAt: row.finished_at ?? 0,
              durationMs: row.duration_ms,
              costMicroUsd: row.cost_micro_usd,
            }
          : null;
      },
    },
    prompts: { summary: () => promptSummary(handle) },
    budget: { status: () => budget.status() },
    secrets: {
      presence: () =>
        Object.fromEntries(SECRET_ENV_KEYS.map((key) => [key, config.secretPresence[key]])),
      providerDefault: () => config.env.LLM_DEFAULT_PROVIDER,
    },
  };

  const activePrompt = loadActivePrompt(handle, config.paths.promptsDir, 'system', 'cost_probe');
  if (!activePrompt) {
    logger.warn('prompt system/cost_probe absent : la sonde de coût ne pourra pas s’exécuter');
  }

  /**
   * Ports du domaine : `core` ne connaît ni SQLite ni Drizzle. Le paquet de
   * persistance rend des objets **structurellement** identiques aux types du
   * domaine (mêmes noms de champs), ce que TypeScript vérifie ici même.
   */
  const memory: ProjectMemoryPorts = {
    store: createProjectMemoryStore(handle, { nowMs: () => clock.nowMs() }),
    clock,
    newId: () => uuidv7(clock.nowMs()),
  };

  return {
    config,
    handle,
    logger,
    clock,
    budget,
    startedAtMs: STARTED_AT,
    memory,
    health: () => getSystemHealth(ports),
    jobs: (filter = {}) => listJobs(handle, filter),
    job: (id) => getJob(handle, id),
    jobEvents: (id, afterSequence, limit) =>
      listJobEvents(handle, { jobId: id, afterSequence, limit }),
  };
}

/** Identifiant de corrélation par requête HTTP : utile dès qu'il y a des logs. */
export function newRequestId(): string {
  return uuidv7();
}
