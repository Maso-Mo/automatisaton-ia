import { hostname } from 'node:os';
import {
  applyMigrations,
  missingTables,
  openDatabase,
  REQUIRED_TABLE_NAMES,
  type DatabaseHandle,
} from '@aia/database';
import { createBudgetPort, type BudgetPort } from '@aia/analytics';
import { ensureLocalDirectories, loadConfig, type Config } from '@aia/config';
import { createLogger, type AppLogger } from '@aia/observability';
import { createJobRegistry, SqliteQueue, type JobRegistry } from '@aia/queue';
import { createSystemClock, createSystemRandom, uuidv7, type Clock } from '@aia/shared';
import { createLlmCallRecorder, loadActivePrompt, readGitCommit, syncPrompts } from '@aia/ai';
import { createNoopHandler, createScriptedProviderFactory } from './handlers/noop';
import { createWorkerLoop, type WorkerLoop } from './loop';

/**
 * Composition root du worker. C'est le seul endroit où les implémentations
 * d'infrastructure rencontrent le domaine : SQLite, la file, le fournisseur et
 * les promptes sont assemblés ici, jamais dans `packages/core` (docs/02 §5).
 */

export interface WorkerContext {
  config: Config;
  handle: DatabaseHandle;
  logger: AppLogger;
  clock: Clock;
  budget: BudgetPort;
  registry: JobRegistry;
  queue: SqliteQueue;
  loop: WorkerLoop;
  workerId: string;
  shutdown: () => Promise<void>;
}

export function buildWorker(
  overrides: { config?: Config; logger?: AppLogger } = {},
): WorkerContext {
  const config = overrides.config ?? loadConfig();
  ensureLocalDirectories(config);

  const logger =
    overrides.logger ??
    createLogger({
      level: config.env.LOG_LEVEL,
      pretty: config.env.LOG_PRETTY && config.env.APP_ENV !== 'production',
      name: 'worker',
    });

  const clock = createSystemClock();
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

  const missing = missingTables(handle, REQUIRED_TABLE_NAMES);
  if (missing.length > 0) {
    handle.close();
    throw new Error(
      `Schéma incomplet : ${missing.length} table(s) manquante(s) sur ${REQUIRED_TABLE_NAMES.length} (${missing.join(', ')}). Lancer « pnpm db:migrate ».`,
    );
  }

  const promptSync = syncPrompts({
    handle,
    promptsDir: config.paths.promptsDir,
    clock,
    logger,
    gitCommit: readGitCommit(),
  });
  if (promptSync.active === 0) {
    handle.close();
    throw new Error(
      `Aucun prompt actif trouvé dans ${config.paths.promptsDir} : vérifier l’en-tête agent/task des fichiers.`,
    );
  }

  const budget = createBudgetPort({
    handle,
    clock,
    limits: {
      dailyUsd: config.env.DAILY_BUDGET_USD,
      monthlyUsd: config.env.MONTHLY_BUDGET_USD,
      dailyTokenLimit: config.env.DAILY_TOKEN_LIMIT,
    },
  });

  const recorder = createLlmCallRecorder(handle, clock);
  const registry = createJobRegistry();

  const costProbe = loadActivePrompt(handle, config.paths.promptsDir, 'system', 'cost_probe');
  if (!costProbe) {
    handle.close();
    throw new Error('Prompt actif introuvable : system/cost_probe (job noop de l’étape 1)');
  }

  registry.register(
    createNoopHandler({
      handle,
      clock,
      logger,
      recorder,
      budget,
      resolvePrompt: () => costProbe,
      createProvider: createScriptedProviderFactory({
        clock,
        recorder,
        budget,
        model: config.env.LLM_MODEL_LIGHT ?? 'deepseek-chat',
      }),
    }),
  );

  const workerId = `worker-${hostname()}-${uuidv7().slice(-8)}`;
  const queue = new SqliteQueue({
    db: handle,
    registry,
    clock,
    random: createSystemRandom(),
    logger,
    leaseMs: config.env.JOB_LEASE_MS,
    offline: config.env.OFFLINE_MODE,
  });

  const loop = createWorkerLoop({
    handle,
    queue,
    registry,
    logger,
    clock,
    workerId,
    pollMs: config.env.WORKER_POLL_MS,
    heartbeatMs: config.env.JOB_HEARTBEAT_MS,
    batchSize: config.env.QUEUE_CONCURRENCY,
    offline: config.env.OFFLINE_MODE,
  });

  const shutdown = async (): Promise<void> => {
    await loop.stop();
    handle.close();
  };

  return { config, handle, logger, clock, budget, registry, queue, loop, workerId, shutdown };
}
