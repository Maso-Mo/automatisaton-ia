import { z } from 'zod';
import type { DatabaseHandle } from '@aia/database';
import type { AppLogger } from '@aia/observability';
import {
  ScriptedLLMProvider,
  findPrice,
  withRecording,
  type LlmCallRecorder,
  type LLMProvider,
} from '@aia/ai';
import type { BudgetPort } from '@aia/analytics';
import type { Clock } from '@aia/shared';
import type { JobContext, JobDefinition } from '@aia/queue';

/**
 * Le job `noop` : la sonde de bout en bout de l'étape 1.
 *
 * Il n'a aucune valeur produit — et c'est exactement son rôle. Il prouve que la
 * chaîne complète fonctionne : *réservation atomique → étapes persistées →
 * prompt lu depuis un fichier → appel journalisé avec un coût calculé →
 * `jobs`/`job_events`/`llm_calls` cohérents*. Un bug dans cette chaîne casserait
 * toutes les étapes suivantes, donc la chaîne est exercée dès maintenant.
 *
 * Le provider est **scripté** (aucun réseau, aucun coût réel) : à l'étape 3, seule
 * la fabrique `createProvider` est remplacée par un vrai fournisseur, et rien
 * d'autre ne change ici.
 */

export const noopInputSchema = z.object({
  message: z.string().max(200).optional(),
  /** Simule un travail long pour vérifier le battement de cœur et le lease. */
  workMs: z.number().int().min(0).max(5_000).optional(),
});

export type NoopJobInput = z.infer<typeof noopInputSchema>;

export interface NoopJobOutput {
  message: string;
  costMicroUsd: number;
  promptVersionId: string | null;
  promptFile: string;
}

export interface NoopHandlerDeps {
  handle: DatabaseHandle;
  clock: Clock;
  logger: AppLogger;
  recorder: LlmCallRecorder;
  budget: BudgetPort;
  /** Remplace le provider scripté par un fournisseur réel à l'étape 3. */
  createProvider: (ctx: JobContext, promptVersionId: string) => LLMProvider;
  /** Lecture du prompt actif depuis `prompt_versions` (résolu au démarrage). */
  resolvePrompt: () => { promptVersionId: string; body: string; filePath: string };
  sleep?: (ms: number) => Promise<void>;
}

export function createNoopHandler(
  deps: NoopHandlerDeps,
): JobDefinition<NoopJobInput, NoopJobOutput> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return {
    type: 'noop',
    inputSchema: noopInputSchema,
    maxAttempts: 3,
    // 30 s, 2 min, 8 min, 32 min (docs/02 §9.3).
    backoff: (attempt) => 30_000 * 4 ** (Math.max(1, attempt) - 1),
    leaseMs: 60_000,
    idempotent: true,
    priority: 9,
    handler: async (input, ctx) => {
      await ctx.setStep('start', 5);

      if (input.workMs) {
        await sleep(input.workMs);
      }

      await ctx.setStep('prompt', 25);
      const prompt = deps.resolvePrompt();
      deps.logger.debug(
        { promptVersionId: prompt.promptVersionId, promptFile: prompt.filePath },
        'prompt résolu pour la sonde',
      );

      await ctx.setStep('llm_call', 50);
      const provider = deps.createProvider(ctx, prompt.promptVersionId);
      const result = await provider.generate(
        `${prompt.body}\n\nMessage fourni : ${input.message ?? '(aucun)'}`,
        { maxOutputTokens: 128 },
        {
          agent: 'system',
          task: 'cost_probe',
          jobId: ctx.jobId,
          promptVersionId: prompt.promptVersionId,
        },
      );

      await ctx.setStep('validate', 85);
      if (result.text.length === 0) {
        throw new Error('réponse vide : la sonde n’a produit aucun texte');
      }

      await ctx.emitEvent({
        step: 'result',
        message: `sonde terminée (${result.usage.outputTokens} jetons en sortie)`,
        data: {
          provider: result.usage.provider,
          model: result.usage.model,
          costMicroUsd: result.usage.costMicroUsd,
        },
      });

      return {
        message: input.message ?? 'noop',
        costMicroUsd: result.usage.costMicroUsd,
        promptVersionId: prompt.promptVersionId,
        promptFile: prompt.filePath,
      };
    },
  };
}

/** Fabrique par défaut : provider scripté, enveloppé pour l'enregistrement obligatoire. */
export function createScriptedProviderFactory(options: {
  clock: Clock;
  recorder: LlmCallRecorder;
  budget: BudgetPort;
  model?: string;
}): (ctx: JobContext, promptVersionId: string) => LLMProvider {
  const model = options.model ?? 'deepseek-chat';

  return (ctx, promptVersionId) => {
    const inner = new ScriptedLLMProvider({
      model,
      price: findPrice('deepseek', model),
      clock: options.clock,
      text: 'sonde de coût : réponse scriptée de l’étape 1',
    });

    return withRecording(inner, {
      recorder: options.recorder,
      clock: options.clock,
      baseContext: {
        agent: 'system',
        task: 'cost_probe',
        jobId: ctx.jobId,
        promptVersionId,
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
  };
}
