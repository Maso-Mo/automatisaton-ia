import { assertWithinBudget } from '@aia/analytics';
import { toAppError, type Clock } from '@aia/shared';
import type { ZodType } from 'zod';
import type {
  GenerateOptions,
  HealthCheckResult,
  LLMCallContext,
  LLMProvider,
  LLMUsage,
  LlmCallStatus,
  ProviderCapabilities,
} from './provider';
import { fingerprintContext, type LlmCallRecorder } from './recorder';

/**
 * Enveloppe **obligatoire** de tout provider : elle applique les deux règles qui
 * ne peuvent pas dépendre de la discipline d'un appelant.
 *
 * 1. **Le veto de budget arrive avant l'appel** : on estime, on compare au budget
 *    restant, et on refuse avant de dépenser (docs/08 §8.1).
 * 2. **Chaque appel est journalisé**, y compris en erreur : un appel qui timeout
 *    après 40 000 jetons a coûté, et le cacher ferait croire que réessayer est
 *    gratuit (docs/08 §7.3).
 */

export interface RecordingBudgetPort {
  (): { remainingMicroUsd: number; hardStop: boolean; periodLabel: string };
}

export interface RecordingProviderDeps {
  recorder: LlmCallRecorder;
  clock: Clock;
  budget?: RecordingBudgetPort;
  baseContext?: LLMCallContext;
  /** Cumul du coût sur le job : c'est ce qui relie un coût à un job. */
  onCost?: (microUsd: number, usage: LLMUsage) => void | Promise<void>;
}

export function withRecording(inner: LLMProvider, deps: RecordingProviderDeps): LLMProvider {
  async function guardBudget(prompt: string, options: GenerateOptions): Promise<void> {
    if (!deps.budget) return;
    const estimated = await inner.estimateCost(prompt, options);
    const budget = deps.budget();
    assertWithinBudget({
      estimatedMicroUsd: estimated,
      remainingMicroUsd: budget.remainingMicroUsd,
      hardStop: budget.hardStop,
      periodLabel: budget.periodLabel,
    });
  }

  function record(
    ctx: LLMCallContext,
    params: {
      prompt: string;
      response?: unknown;
      usage?: LLMUsage;
      status: LlmCallStatus;
      errorCode?: string | null;
      startedAt: number;
      model: string;
      temperature?: number;
    },
  ): void {
    deps.recorder.record({
      jobId: ctx.jobId ?? deps.baseContext?.jobId ?? null,
      projectId: ctx.projectId ?? deps.baseContext?.projectId ?? null,
      contentItemId: ctx.contentId ?? deps.baseContext?.contentId ?? null,
      agent: ctx.agent,
      task: ctx.task,
      provider: params.usage?.provider ?? inner.id,
      model: params.usage?.model ?? params.model,
      promptVersionId: ctx.promptVersionId ?? deps.baseContext?.promptVersionId ?? null,
      contextFingerprint: fingerprintContext({ prompt: params.prompt, task: ctx.task }),
      request: { prompt: params.prompt },
      response: params.response,
      promptTokens: params.usage?.inputTokens ?? null,
      completionTokens: params.usage?.outputTokens ?? null,
      cachedTokens: params.usage?.cachedTokens ?? null,
      costMicroUsd: params.usage?.costMicroUsd ?? 0,
      latencyMs: deps.clock.nowMs() - params.startedAt,
      status: params.status,
      errorCode: params.errorCode ?? null,
      temperature: params.temperature ?? null,
    });
  }

  return {
    id: inner.id,

    async generate(prompt, options, ctx) {
      await guardBudget(prompt, options);
      const startedAt = deps.clock.nowMs();
      try {
        const result = await inner.generate(prompt, options, ctx);
        record(ctx, {
          prompt,
          response: result.text,
          usage: result.usage,
          status: 'success',
          startedAt,
          model: options.model ?? '',
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        });
        await deps.onCost?.(result.usage.costMicroUsd, result.usage);
        return result;
      } catch (error) {
        const appError = toAppError(error);
        record(ctx, {
          prompt,
          status: statusFromError(appError.category, appError.code),
          errorCode: appError.code ?? appError.name,
          startedAt,
          model: options.model ?? '',
        });
        throw error;
      }
    },

    async structuredOutput<T>(
      prompt: string,
      schema: ZodType<T>,
      options: GenerateOptions,
      ctx: LLMCallContext,
    ) {
      await guardBudget(prompt, options);
      const startedAt = deps.clock.nowMs();
      try {
        const result = await inner.structuredOutput(prompt, schema, options, ctx);
        record(ctx, {
          prompt,
          response: result.data,
          usage: result.usage,
          status: 'success',
          startedAt,
          model: options.model ?? '',
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        });
        await deps.onCost?.(result.usage.costMicroUsd, result.usage);
        return result;
      } catch (error) {
        const appError = toAppError(error);
        record(ctx, {
          prompt,
          status: statusFromError(appError.category, appError.code),
          errorCode: appError.code ?? appError.name,
          startedAt,
          model: options.model ?? '',
        });
        throw error;
      }
    },

    estimateCost: (prompt, options) => inner.estimateCost(prompt, options),
    capabilities: (): ProviderCapabilities => inner.capabilities(),
    healthCheck: (): Promise<HealthCheckResult> => inner.healthCheck(),
  };
}

function statusFromError(
  category: ReturnType<typeof toAppError>['category'],
  code: string | undefined,
): LlmCallStatus {
  if (code === 'LLM_TIMEOUT' || category === 'transient') return 'timeout';
  if (code === 'RATE_LIMITED') return 'rate_limited';
  if (category === 'forbidden' || code === 'LLM_REFUSED') return 'refused';
  return 'error';
}
