import { createBudgetPort, type BudgetPort } from '@aia/analytics';
import {
  createLlmCallRecorder,
  loadActivePrompt,
  syncPrompts,
  type PromptSyncReport,
} from '@aia/ai';
import { createJobRegistry, SqliteQueue } from '@aia/queue';
import { createSeededRandom } from '@aia/shared';
import {
  createNoopHandler,
  createScriptedProviderFactory,
} from '../../apps/worker/src/handlers/noop';
import { createWorkerLoop, type WorkerLoop } from '../../apps/worker/src/loop';
import { REPO_PROMPTS_DIR, type TestContext } from './harness';

/**
 * Empile la chaîne complète de l'étape 1 sur le contexte de test : prompts
 * synchronisés, budget, enregistreur d'appels, job `noop` et boucle de worker.
 * Tout est du code de production ; seul le provider est scripté.
 */

export interface NoopStack {
  queue: SqliteQueue;
  loop: WorkerLoop;
  budget: BudgetPort;
  prompt: { promptVersionId: string; body: string; filePath: string };
  syncReport: PromptSyncReport;
}

export function createNoopStack(
  context: TestContext,
  options: { workerId?: string; promptsDir?: string; seed?: number } = {},
): NoopStack {
  const { handle, clock, logger } = context;
  const promptsDir = options.promptsDir ?? REPO_PROMPTS_DIR;

  const syncReport = syncPrompts({ handle, promptsDir, clock, logger, gitCommit: null });

  const prompt = loadActivePrompt(handle, promptsDir, 'system', 'cost_probe');
  if (!prompt) {
    throw new Error(`prompt system/cost_probe introuvable dans ${promptsDir}`);
  }

  const budget = createBudgetPort({
    handle,
    clock,
    timeZone: 'UTC',
    limits: { dailyUsd: 1, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
  });
  const recorder = createLlmCallRecorder(handle, clock);

  const registry = createJobRegistry();
  registry.register(
    createNoopHandler({
      handle,
      clock,
      logger,
      recorder,
      budget,
      resolvePrompt: () => prompt,
      createProvider: createScriptedProviderFactory({
        clock,
        recorder,
        budget,
        model: 'deepseek-chat',
      }),
    }),
  );

  const queue = new SqliteQueue({
    db: handle,
    registry,
    clock,
    random: createSeededRandom(options.seed ?? 7),
    logger,
    leaseMs: 60_000,
  });

  const loop = createWorkerLoop({
    handle,
    queue,
    registry,
    logger,
    clock,
    workerId: options.workerId ?? 'worker-test',
    pollMs: 60_000,
    heartbeatMs: 10_000,
    batchSize: 3,
    offline: false,
  });

  return { queue, loop, budget, prompt, syncReport };
}
