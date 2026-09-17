import { hostname } from 'node:os';
import {
  applyMigrations,
  createConversationStore,
  createEditorialStore,
  createProjectMemoryStore,
  missingTables,
  openDatabase,
  REQUIRED_TABLE_NAMES,
  type DatabaseHandle,
} from '@aia/database';
import { createBudgetPort, type BudgetPort } from '@aia/analytics';
import {
  ensureLocalDirectories,
  llmModelFor,
  loadConfig,
  providerApiKey,
  type Config,
} from '@aia/config';
import { createLogger, type AppLogger } from '@aia/observability';
import { createJobRegistry, generateContentSpec, SqliteQueue, type JobRegistry } from '@aia/queue';
import { createSystemClock, createSystemRandom, uuidv7, type Clock } from '@aia/shared';
import {
  PLATFORM_WRITER_AGENT,
  PLATFORM_WRITER_TASK,
  PLATFORM_WRITER_TEMPERATURE,
  createLlmCallRecorder,
  createLlmProvider,
  loadActivePrompt,
  readGitCommit,
  syncPrompts,
  withRecording,
  type LlmCallRecorder,
} from '@aia/ai';
import type { EditorialPorts, ProjectMemoryPorts } from '@aia/core';
import { createGenerateContentHandler } from './handlers/generate-content';
import { createNoopHandler, createScriptedProviderFactory } from './handlers/noop';
import type { WriterProviderFactory } from './features/platform-writer';
import { createWorkerLoop, type WorkerLoop } from './loop';

/**
 * Composition root du worker. C'est le seul endroit où les implémentations
 * d'infrastructure rencontrent le domaine : SQLite, la file, le fournisseur et
 * les promptes sont assemblés ici, jamais dans `packages/core` (docs/02 §5).
 */

/**
 * La fabrique du fournisseur de **rédaction** (étape 4, docs/05 §4.3).
 *
 * Elle est au worker ce que `apps/api/src/features/agents.ts` est à l'API : le
 * seul endroit qui choisit un fournisseur, un modèle et une température pour
 * `platform_writer`. Trois propriétés y sont portées, et aucune n'est laissée à
 * la discipline d'un appelant :
 *
 * 1. **un fournisseur enregistré** (`withRecording`) : chaque appel part dans
 *    `llm_calls`, y compris en erreur — un appel qui timeout a coûté ;
 * 2. **le veto de budget avant l'appel** : l'estimation est comparée au solde
 *    restant, et un refus n'écrit rien ni ne paie (docs/08 §8.1) ;
 * 3. **le coût est cumulé sur le job** (`ctx.recordCost`) : `jobs.cost_micro_usd`
 *    est la somme des appels du job, jamais une valeur recalculée après coup.
 *
 * Un bundle par appel, jamais un fournisseur partagé : `lastCallId()` désigne
 * alors l'appel de **ce** lot, celui dont la version de contenu dépend.
 */
function createWriterProviderFactory(options: {
  config: Config;
  clock: Clock;
  logger: AppLogger;
  recorder: LlmCallRecorder;
  budget: BudgetPort;
}): WriterProviderFactory {
  const providerId = options.config.env.LLM_DEFAULT_PROVIDER;
  const model = llmModelFor(options.config.env, 'standard');

  options.logger.info(
    { provider: providerId, model, temperature: PLATFORM_WRITER_TEMPERATURE },
    'rédacteur configuré : un appel par lot, journalisé et soumis au budget',
  );

  return (ctx, request) => {
    let lastCallId: string | null = null;

    const inner = createLlmProvider({
      providerId,
      apiKey: providerApiKey(options.config.env, providerId),
      model,
      clock: options.clock,
      localBaseUrl: `${options.config.env.OLLAMA_BASE_URL}/v1`,
    });

    const provider = withRecording(inner, {
      recorder: options.recorder,
      clock: options.clock,
      // Sans le job dans le contexte, un coût de rédaction ne serait rattaché à rien.
      baseContext: {
        agent: PLATFORM_WRITER_AGENT,
        task: PLATFORM_WRITER_TASK,
        projectId: request.projectId,
        jobId: ctx.jobId,
        promptVersionId: request.promptVersionId,
      },
      onLlmCallId: (id) => {
        lastCallId = id;
      },
      onCost: async (microUsd) => {
        await ctx.recordCost(microUsd);
      },
      budget: () => {
        const snapshot = options.budget.snapshot();
        return {
          remainingMicroUsd: snapshot.remainingMicroUsd,
          hardStop: snapshot.hardStop,
          periodLabel: snapshot.periodLabel,
        };
      },
    });

    return { provider, lastCallId: () => lastCallId };
  };
}

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

  /**
   * Éditorial (étape 4) : les ports du domaine, puis le job de rédaction.
   *
   * Les ports sont les **mêmes** que ceux de l'API — le domaine éditorial est
   * partagé par les deux processus, et sa seule source de vérité est
   * `packages/core` : l'API enfile, le worker exécute, et les deux lisent les
   * mêmes tables. La fiche maître vient du domaine « conversation », qui en est
   * le propriétaire : la recopier créerait deux vérités.
   *
   * Le job est enregistré **avec** sa spécification (`generateContentSpec`,
   * importée de `@aia/queue`) : c'est la même que celle utilisée par l'API pour
   * enfiler. Un worker qui recopierait ses valeurs produirait un autre job que
   * celui que l'API a écrit — et le refus arriverait au mauvais endroit.
   */
  const memoryPorts: ProjectMemoryPorts = {
    store: createProjectMemoryStore(handle, { nowMs: () => clock.nowMs() }),
    clock,
    newId: () => uuidv7(clock.nowMs()),
  };

  const conversationStore = createConversationStore(handle, { nowMs: () => clock.nowMs() });

  const editorialPorts: EditorialPorts = {
    store: createEditorialStore(handle, { nowMs: () => clock.nowMs() }),
    memory: memoryPorts.store,
    briefs: conversationStore.briefs,
    clock,
    newId: () => uuidv7(clock.nowMs()),
  };

  registry.register({
    ...generateContentSpec,
    handler: createGenerateContentHandler({
      handle,
      memory: memoryPorts,
      ports: editorialPorts,
      logger,
      writer: {
        promptsDir: config.paths.promptsDir,
        model: llmModelFor(config.env, 'standard'),
        temperature: PLATFORM_WRITER_TEMPERATURE,
        createProvider: createWriterProviderFactory({ config, clock, logger, recorder, budget }),
      },
    }),
  });

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
