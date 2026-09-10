import { ForbiddenError, TransientError, ValidationError, type Clock } from '@aia/shared';
import type { ZodType } from 'zod';
import type {
  GenerateOptions,
  HealthCheckResult,
  LLMCallContext,
  LLMProvider,
  LLMUsage,
  ProviderCapabilities,
} from '../provider';
import {
  computeCostMicroUsd,
  estimateCostMicroUsd,
  estimatePromptTokens,
  type ModelPrice,
} from '../pricing';

/**
 * Provider **scripté** : déterministe, sans réseau, sans coût réel.
 *
 * Il existe à l'étape 1 pour une raison précise : le critère de sortie exige
 * qu'« une ligne `llm_calls` porte un coût calculé », c'est-à-dire que la chaîne
 * *estimation → appel → jetons → coût → journal* soit réellement exercée. Un
 * fournisseur réel arrive à l'étape 3, mais le chemin de coût doit être fiable
 * dès maintenant (docs/09 §4.3).
 *
 * C'est aussi le provider des tests : aucun test ne parle au monde extérieur
 * par défaut (docs/09 §1.1).
 */

export type ScriptedMode = 'ok' | 'error' | 'timeout' | 'refused';

export interface ScriptedCall {
  kind: 'generate' | 'structuredOutput';
  prompt: string;
  options: GenerateOptions;
  ctx: LLMCallContext;
  promptTokens: number;
  completionTokens: number;
  costMicroUsd: number;
}

export interface ScriptedProviderOptions {
  model: string;
  price: ModelPrice;
  clock: Clock;
  id?: string;
  /** Réponses consommées dans l'ordre ; la dernière se répète. */
  responses?: readonly string[];
  /** Réponse par défaut si aucune séquence n'est fournie. */
  text?: string;
  mode?: ScriptedMode;
  latencyMs?: number;
  cachedTokens?: number;
  maxContextTokens?: number;
}

const DEFAULT_GENERATED_TEXT = 'réponse scriptée';

export class ScriptedLLMProvider implements LLMProvider {
  readonly id: string;
  readonly calls: ScriptedCall[] = [];

  private readonly model: string;
  private readonly price: ModelPrice;
  private readonly clock: Clock;
  private readonly responses: readonly string[];
  private readonly fallbackText: string;
  private readonly mode: ScriptedMode;
  private readonly latencyMs: number;
  private readonly cachedTokens: number;
  private readonly maxContextTokens: number;
  private turn = 0;

  constructor(options: ScriptedProviderOptions) {
    this.id = options.id ?? `scripted:${options.model}`;
    this.model = options.model;
    this.price = options.price;
    this.clock = options.clock;
    this.responses = options.responses ?? [];
    this.fallbackText = options.text ?? DEFAULT_GENERATED_TEXT;
    this.mode = options.mode ?? 'ok';
    this.latencyMs = options.latencyMs ?? 0;
    this.cachedTokens = options.cachedTokens ?? 0;
    this.maxContextTokens = options.maxContextTokens ?? 64_000;
  }

  async generate(
    prompt: string,
    options: GenerateOptions,
    ctx: LLMCallContext,
  ): Promise<{ text: string; usage: LLMUsage }> {
    this.assertCallable();
    const text = this.nextResponse();
    const usage = this.buildUsage(prompt, text, options);
    this.calls.push({
      kind: 'generate',
      prompt,
      options,
      ctx,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      costMicroUsd: usage.costMicroUsd,
    });
    return { text, usage };
  }

  async structuredOutput<T>(
    prompt: string,
    schema: ZodType<T>,
    options: GenerateOptions,
    ctx: LLMCallContext,
  ): Promise<{ data: T; usage: LLMUsage; repaired: boolean }> {
    this.assertCallable();
    const raw = this.nextResponse();
    const { value, repaired } = parseWithRepair(raw);

    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ValidationError(
        `Réponse non conforme au schéma attendu : ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(racine)'} ${issue.message}`)
          .join(' ; ')}`,
        { code: 'LLM_SCHEMA_MISMATCH' },
      );
    }

    const usage = this.buildUsage(prompt, raw, options);
    this.calls.push({
      kind: 'structuredOutput',
      prompt,
      options,
      ctx,
      promptTokens: usage.inputTokens,
      completionTokens: usage.outputTokens,
      costMicroUsd: usage.costMicroUsd,
    });
    return { data: parsed.data, usage, repaired };
  }

  async estimateCost(prompt: string, options: GenerateOptions): Promise<number> {
    return estimateCostMicroUsd({
      prompt,
      price: this.price,
      maxOutputTokens: options.maxOutputTokens ?? 256,
    });
  }

  capabilities(): ProviderCapabilities {
    return {
      jsonMode: true,
      toolCalling: false,
      vision: false,
      maxContextTokens: this.maxContextTokens,
      streaming: false,
    };
  }

  async healthCheck(): Promise<HealthCheckResult> {
    if (this.mode === 'error') {
      return { ok: false, error: 'provider scripté en mode erreur' };
    }
    return { ok: true, latencyMs: this.latencyMs };
  }

  /** Horloge injectée : le provider scripté reste daté de façon déterministe. */
  nowMs(): number {
    return this.clock.nowMs();
  }

  private assertCallable(): void {
    switch (this.mode) {
      case 'timeout':
        throw new TransientError('délai dépassé (provider scripté)', { code: 'LLM_TIMEOUT' });
      case 'error':
        throw new TransientError('erreur du fournisseur (provider scripté)', {
          code: 'LLM_PROVIDER_ERROR',
        });
      case 'refused':
        throw new ForbiddenError('contenu refusé par le fournisseur (provider scripté)', {
          code: 'LLM_REFUSED',
        });
      case 'ok':
        return;
    }
  }

  private nextResponse(): string {
    if (this.responses.length === 0) return this.fallbackText;
    const index = Math.min(this.turn, this.responses.length - 1);
    this.turn += 1;
    return this.responses[index] ?? this.fallbackText;
  }

  private buildUsage(prompt: string, output: string, options: GenerateOptions): LLMUsage {
    const inputTokens = estimatePromptTokens(prompt);
    const outputTokens = estimatePromptTokens(output);
    const costMicroUsd = computeCostMicroUsd(
      {
        promptTokens: inputTokens,
        cachedTokens: this.cachedTokens,
        completionTokens: outputTokens,
      },
      this.price,
    );
    return {
      provider: this.price.provider,
      model: options.model ?? this.model,
      inputTokens,
      outputTokens,
      cachedTokens: this.cachedTokens,
      costUsd: costMicroUsd / 1_000_000,
      costMicroUsd,
      latencyMs: this.latencyMs,
    };
  }
}

/**
 * Réparation minimale : un modèle qui répond `` ```json … ``` `` n'est pas en
 * erreur, il est mal emballé. Toute autre non-conformité est une erreur réelle
 * (docs/09 §2, famille « sorties structurées »).
 */
export function parseWithRepair(raw: string): { value: unknown; repaired: boolean } {
  try {
    return { value: JSON.parse(raw) as unknown, repaired: false };
  } catch {
    const stripped = raw
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    return { value: JSON.parse(stripped) as unknown, repaired: true };
  }
}
