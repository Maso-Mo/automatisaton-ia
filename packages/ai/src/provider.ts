import type { ZodType } from 'zod';

/**
 * Contrat `LLMProvider` — figé **avant** l'implémentation (docs/02 §9.1).
 * C'est l'une des trois seules abstractions du produit, et la plus structurante.
 *
 * Règles non négociables :
 * 1. Le domaine appelle `structuredOutput` dans 95 % des cas ; `generate` est
 *    réservé à la conversation affichée à l'utilisateur.
 * 2. Chaque appel est enregistré dans `llm_calls` : un appel non journalisé est
 *    un bug (garanti par `withRecording`).
 * 3. `estimateCost` est appelé **avant** l'appel réel : au-delà du budget, le
 *    provider refuse avant de dépenser.
 *
 * À l'étape 1, seul le provider scripté (déterministe) est implémenté : les
 * fournisseurs réels (DeepSeek, OpenRouter, Ollama…) arrivent à l'étape 3 avec
 * l'orchestrateur, qui est la première fonctionnalité à en avoir besoin.
 */

export interface GenerateOptions {
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Contrainte de budget : le provider refuse si l'estimation dépasse. */
  maxCostUsd?: number;
  /** Cache : clé logique pour réutiliser une réponse déjà payée. */
  cacheKey?: string;
  signal?: AbortSignal;
}

export interface LLMCallContext {
  agent: string; // 'interviewer' | 'strategist' | 'platform_writer' | …
  task: string; // 'master_brief' | 'linkedin_post' | 'cost_probe' | …
  projectId?: string;
  subjectId?: string;
  contentId?: string;
  /** Rattaché par la file : c'est ce qui relie un coût à un job. */
  jobId?: string;
  /** Version de prompt utilisée, pour la traçabilité des résultats. */
  promptVersionId?: string;
}

export interface LLMUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Montant en dollars, arrondi à l'affichage. Le stockage est en micro-dollars. */
  costUsd: number;
  /** Entier stocké en base : jamais un flottant (docs/03 §2.4). */
  costMicroUsd: number;
  latencyMs: number;
}

export interface ProviderCapabilities {
  jsonMode: boolean;
  toolCalling: boolean;
  vision: boolean;
  maxContextTokens: number;
  streaming: boolean;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

export interface LLMProvider {
  readonly id: string;

  /** Texte libre. Uniquement pour de la conversation affichée à l'utilisateur. */
  generate(
    prompt: string,
    options: GenerateOptions,
    ctx: LLMCallContext,
  ): Promise<{ text: string; usage: LLMUsage }>;

  /** Sortie structurée. À utiliser pour TOUT ce que du code doit consommer. */
  structuredOutput<T>(
    prompt: string,
    schema: ZodType<T>,
    options: GenerateOptions,
    ctx: LLMCallContext,
  ): Promise<{ data: T; usage: LLMUsage; repaired: boolean }>;

  /** Estimation AVANT appel, pour respecter les plafonds. */
  estimateCost(prompt: string, options: GenerateOptions): Promise<number>;

  /** Ce que le modèle sait faire : JSON mode, outils, contexte, vision. */
  capabilities(): ProviderCapabilities;

  healthCheck(): Promise<HealthCheckResult>;
}

/** Statuts d'un appel enregistré dans `llm_calls.status` (docs/03 §14.3). */
export const LLM_CALL_STATUSES = [
  'success',
  'error',
  'timeout',
  'rate_limited',
  'refused',
] as const;

export type LlmCallStatus = (typeof LLM_CALL_STATUSES)[number];
