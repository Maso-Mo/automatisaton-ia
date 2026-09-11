import {
  ForbiddenError,
  InternalError,
  MissingCredentialError,
  TransientError,
  ValidationError,
  type Clock,
} from '@aia/shared';
import type { ZodType } from 'zod';
import {
  computeCostMicroUsd,
  estimateCostMicroUsd,
  estimatePromptTokens,
  type ModelPrice,
} from '../pricing';
import type {
  GenerateOptions,
  HealthCheckResult,
  LLMCallContext,
  LLMProvider,
  LLMUsage,
  ProviderCapabilities,
} from '../provider';
import { parseWithRepair } from './scripted';

/**
 * Transport **compatible OpenAI** (`POST /chat/completions`) — le dialecte
 * qu'utilisent DeepSeek, OpenRouter, Ollama et la plupart des passerelles
 * locales.
 *
 * Pourquoi un transport séparé du fournisseur : le contrat `LLMProvider`
 * (docs/02 §9.1) décrit *ce que le produit attend* (sortie structurée, coût,
 * santé), pas la forme d'un `POST` HTTP. Un fournisseur = un base URL, une clé et
 * un tarif ; tout le reste est ici.
 *
 * `fetch` est **injecté** : les tests exercent le client réel (en-têtes, corps,
 * codes d'erreur, usage) sans réseau, donc sans serveur simulé à maintenir
 * (docs/09 §1.1, §2 famille 6).
 */

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OpenAiCompatibleConfig {
  /** Identifiant du fournisseur : `deepseek`, `openrouter`, `ollama`… */
  provider: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  price: ModelPrice;
  clock: Clock;
  fetchImpl?: FetchLike;
  /** Délai maximal d'un appel. Au-delà : `LLM_TIMEOUT` (transitoire). */
  timeoutMs?: number;
  defaultTemperature?: number;
}

export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
  };
}

export class OpenAiCompatibleProvider implements LLMProvider {
  readonly id: string;

  protected readonly config: OpenAiCompatibleConfig;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(config: OpenAiCompatibleConfig) {
    this.config = config;
    this.id = `${config.provider}:${config.model}`;
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  async generate(
    prompt: string,
    options: GenerateOptions,
    _ctx: LLMCallContext,
  ): Promise<{ text: string; usage: LLMUsage }> {
    const { content, usage } = await this.call(prompt, options, false);
    return { text: content, usage };
  }

  async estimateCost(prompt: string, options: GenerateOptions): Promise<number> {
    return estimateCostMicroUsd({
      prompt,
      price: this.config.price,
      maxOutputTokens: options.maxOutputTokens ?? 1_024,
    });
  }

  capabilities(): ProviderCapabilities {
    return {
      jsonMode: true,
      toolCalling: false,
      vision: false,
      maxContextTokens: 64_000,
      streaming: false,
    };
  }

  /** Sonde sans coût : `GET /models` n'engage aucun jeton. */
  async healthCheck(): Promise<HealthCheckResult> {
    if (this.requiresKey() && !this.config.apiKey) {
      return { ok: false, error: 'clé API absente' };
    }
    const startedAt = this.config.clock.nowMs();
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
        body: '',
      });
      const latencyMs = this.config.clock.nowMs() - startedAt;
      return response.ok
        ? { ok: true, latencyMs }
        : { ok: false, error: `HTTP ${response.status}`, latencyMs };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  protected requiresKey(): boolean {
    return true;
  }

  protected headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  /**
   * Chaîne de docs/04 §6.2 : appel → JSON → schéma. Si l'un des deux échoue,
   * **un** appel de correction ciblée est tenté avec le message d'erreur exact,
   * puis l'échec est explicite. Deux tentatives, pas dix : au-delà, c'est le
   * prompt qu'il faut corriger.
   */
  async structuredOutput<T>(
    prompt: string,
    schema: ZodType<T>,
    options: GenerateOptions,
    _ctx: LLMCallContext,
  ): Promise<{ data: T; usage: LLMUsage; repaired: boolean }> {
    const first = await this.call(prompt, options, true);
    const attempt = tryParse(first.content, schema);
    if (attempt.ok) {
      return { data: attempt.data, usage: first.usage, repaired: attempt.repaired };
    }

    const correctionPrompt = [
      'Ta réponse précédente n’est pas exploitable.',
      `Erreur : ${attempt.issue}`,
      'Réponds STRICTEMENT avec un unique objet JSON valide, sans texte autour, avec exactement les clés demandées.',
      'Réponse précédente :',
      first.content.slice(0, 4_000),
    ].join('\n');

    const second = await this.call(correctionPrompt, options, true);
    const retried = tryParse(second.content, schema);
    if (!retried.ok) {
      throw new ValidationError(`Sortie structurée invalide après réparation : ${retried.issue}`, {
        code: 'LLM_SCHEMA_MISMATCH',
      });
    }

    return { data: retried.data, usage: mergeUsage(first.usage, second.usage), repaired: true };
  }

  private async call(
    prompt: string,
    options: GenerateOptions,
    jsonMode: boolean,
  ): Promise<{ content: string; usage: LLMUsage }> {
    if (this.requiresKey() && !this.config.apiKey) {
      throw new MissingCredentialError(
        `Aucune clé API configurée pour ${this.config.provider} : renseigner la variable d’environnement correspondante (docs/02 §11).`,
        { code: 'MISSING_CREDENTIAL', details: { provider: this.config.provider } },
      );
    }

    const startedAt = this.config.clock.nowMs();
    const body: Record<string, unknown> = {
      model: options.model ?? this.config.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? this.config.defaultTemperature ?? 0.2,
      max_tokens: options.maxOutputTokens ?? 1_024,
      stream: false,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const signal = options.signal ?? controller.signal;

    let raw: string;
    let status: number;
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal,
      });
      raw = await response.text();
      status = response.status;
    } catch (error) {
      const aborted = controller.signal.aborted;
      throw new TransientError(
        aborted
          ? `Délai dépassé (${this.timeoutMs} ms) auprès de ${this.config.provider}`
          : `Erreur réseau auprès de ${this.config.provider} : ${
              error instanceof Error ? error.message : String(error)
            }`,
        { code: aborted ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_ERROR' },
      );
    } finally {
      clearTimeout(timer);
    }

    if (status < 200 || status >= 300) throw errorForStatus(this.config.provider, status, raw);

    const payload = parseCompletion(raw, this.config.provider);
    const choice = payload.choices?.[0];
    const content = choice?.message?.content ?? '';
    if (choice?.finish_reason === 'content_filter') {
      throw new ForbiddenError('Réponse refusée par le fournisseur (filtre de contenu)', {
        code: 'LLM_REFUSED',
        details: { provider: this.config.provider },
      });
    }
    if (content.trim().length === 0) {
      throw new TransientError(`Réponse vide de ${this.config.provider}`, {
        code: 'LLM_PROVIDER_ERROR',
      });
    }

    const promptTokens = payload.usage?.prompt_tokens ?? estimatePromptTokens(prompt);
    const outputTokens = payload.usage?.completion_tokens ?? estimatePromptTokens(content);
    const cachedTokens = payload.usage?.prompt_cache_hit_tokens ?? 0;
    const costMicroUsd = computeCostMicroUsd(
      { promptTokens, completionTokens: outputTokens, cachedTokens },
      this.config.price,
    );

    return {
      content,
      usage: {
        provider: this.config.price.provider,
        model: options.model ?? this.config.model,
        inputTokens: promptTokens,
        outputTokens,
        cachedTokens,
        costUsd: costMicroUsd / 1_000_000,
        costMicroUsd,
        latencyMs: this.config.clock.nowMs() - startedAt,
      },
    };
  }
}

/**
 * Un statut HTTP est traduit en **catégorie** d'erreur, parce que c'est la
 * catégorie qui décide du comportement (reprise, alerte, message) — jamais le
 * code du fournisseur (docs/02 §12).
 */
export function errorForStatus(provider: string, status: number, raw: string): Error {
  const detail = raw.slice(0, 500);
  if (status === 401 || status === 403) {
    return new MissingCredentialError(
      `Clé refusée par ${provider} (HTTP ${status}). Vérifier la clé API.`,
      { code: 'MISSING_CREDENTIAL', details: { status } },
    );
  }
  if (status === 429) {
    return new TransientError(`Débit dépassé chez ${provider} (HTTP 429)`, {
      code: 'RATE_LIMITED',
      details: { status },
    });
  }
  if (status >= 500) {
    return new TransientError(`Erreur serveur de ${provider} (HTTP ${status}) : ${detail}`, {
      code: 'LLM_PROVIDER_ERROR',
      details: { status },
    });
  }
  if (status === 400 || status === 422) {
    return new ValidationError(`Requête refusée par ${provider} (HTTP ${status}) : ${detail}`, {
      code: 'LLM_REQUEST_INVALID',
      details: { status },
    });
  }
  return new InternalError(`Réponse inattendue de ${provider} (HTTP ${status}) : ${detail}`, {
    code: 'LLM_UNEXPECTED_STATUS',
    details: { status },
  });
}

function parseCompletion(raw: string, provider: string): ChatCompletionResponse {
  try {
    return JSON.parse(raw) as ChatCompletionResponse;
  } catch (error) {
    throw new InternalError(
      `Réponse illisible de ${provider} : ${error instanceof Error ? error.message : String(error)}`,
      { code: 'LLM_RESPONSE_INVALID' },
    );
  }
}

type ParseAttempt<T> =
  { ok: true; data: T; repaired: boolean } | { ok: false; issue: string; repaired: boolean };

function tryParse<T>(raw: string, schema: ZodType<T>): ParseAttempt<T> {
  let parsed: { value: unknown; repaired: boolean };
  try {
    parsed = parseWithRepair(raw);
  } catch (error) {
    return {
      ok: false,
      issue: `JSON illisible (${error instanceof Error ? error.message : String(error)})`,
      repaired: false,
    };
  }

  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(racine)'} ${issue.message}`)
      .join(' ; ');
    return { ok: false, issue: issues, repaired: parsed.repaired };
  }
  return { ok: true, data: result.data, repaired: parsed.repaired };
}

/** Deux appels d'une même réparation coûtent la somme des deux : on ne cache rien. */
function mergeUsage(first: LLMUsage, second: LLMUsage): LLMUsage {
  return {
    provider: second.provider,
    model: second.model,
    inputTokens: first.inputTokens + second.inputTokens,
    outputTokens: first.outputTokens + second.outputTokens,
    cachedTokens: first.cachedTokens + second.cachedTokens,
    costUsd: first.costUsd + second.costUsd,
    costMicroUsd: first.costMicroUsd + second.costMicroUsd,
    latencyMs: first.latencyMs + second.latencyMs,
  };
}
