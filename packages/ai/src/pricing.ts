/**
 * Prix des modèles et calcul du coût (docs/08 §7.3).
 *
 * Le contenu de la table est **volontairement marqué à vérifier** : « Ne pas
 * coder un tarif de mémoire » (docs/08 §7.3). Les valeurs ci-dessous sont des
 * ordres de grandeur de départ, avec leur date d'effet, pour que l'étape 1
 * puisse calculer un coût réel dès le premier job.
 *
 * Écart assumé vis-à-vis de docs/08 §7.3 : le document prévoit que ces prix
 * vivent dans `llm_providers_config`. Cette table n'a pas encore de colonnes de
 * prix à l'étape 1 (docs/03 §4.3) ; elle les recevra à l'étape 3, quand
 * l'orchestrateur aura un fournisseur réel à configurer. En attendant, les prix
 * sont une constante **datée et unique**, testée unitairement.
 */

import { usdToMicro } from '@aia/shared';

export interface ModelPrice {
  provider: string;
  model: string;
  /** Prix d'un million de jetons d'entrée, en dollars. */
  inputPerMillionUsd: number;
  /** Prix d'un million de jetons d'entrée servi depuis le cache. */
  cachedInputPerMillionUsd: number;
  /** Prix d'un million de jetons de sortie, en dollars. */
  outputPerMillionUsd: number;
  /** Date d'effet (ISO), pour pouvoir recalculer un coût historique. */
  effectiveFrom: string;
  /** Faux tant que le tarif n'a pas été confirmé à la source. */
  verified: boolean;
}

/** ⚠️ À VÉRIFIER avant tout usage réel (docs/08 §7.3, docs/README). */
export const PRICE_TABLE: readonly ModelPrice[] = [
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    inputPerMillionUsd: 0.27,
    cachedInputPerMillionUsd: 0.07,
    outputPerMillionUsd: 1.1,
    effectiveFrom: '2025-01-01',
    verified: false,
  },
  {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    inputPerMillionUsd: 0.55,
    cachedInputPerMillionUsd: 0.14,
    outputPerMillionUsd: 2.19,
    effectiveFrom: '2025-01-01',
    verified: false,
  },
  {
    provider: 'local',
    model: 'local-small',
    inputPerMillionUsd: 0,
    cachedInputPerMillionUsd: 0,
    outputPerMillionUsd: 0,
    effectiveFrom: '2025-01-01',
    verified: true,
  },
];

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/**
 * Coût en **micro-dollars entiers** (docs/08 §7.3) :
 *
 * ```text
 * cost_micro_usd = round(
 *     (prompt_tokens - cached_tokens) * input_price_per_million
 *   + cached_tokens                    * cached_price_per_million
 *   + completion_tokens                * output_price_per_million
 * )
 * ```
 *
 * Puisque les prix sont exprimés par million de jetons, `prix × jetons` donne
 * directement des micro-dollars : le facteur million s'annule. L'écriture reste
 * explicite pour que la formule du document soit vérifiable ligne à ligne.
 */
export function computeCostMicroUsd(usage: TokenUsage, price: ModelPrice): number {
  const billableInput = Math.max(0, usage.promptTokens - usage.cachedTokens);
  const usd =
    (billableInput * price.inputPerMillionUsd) / 1_000_000 +
    (usage.cachedTokens * price.cachedInputPerMillionUsd) / 1_000_000 +
    (usage.completionTokens * price.outputPerMillionUsd) / 1_000_000;
  return usdToMicro(usd);
}

export function findPrice(provider: string, model: string): ModelPrice {
  const exact = PRICE_TABLE.find((price) => price.provider === provider && price.model === model);
  if (exact) return exact;
  const providerFallback = PRICE_TABLE.find((price) => price.provider === provider);
  if (providerFallback) return providerFallback;
  throw new Error(
    `Aucun tarif connu pour ${provider}/${model}. Ajouter une entrée datée dans PRICE_TABLE (docs/08 §7.3).`,
  );
}

/**
 * Estimation grossière du nombre de jetons d'entrée : ~4 caractères par jeton.
 * C'est suffisant pour un veto de budget, jamais pour de la facturation — la
 * facturation utilise les jetons réellement renvoyés par le fournisseur.
 */
export function estimatePromptTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface EstimateCostInput {
  prompt: string;
  price: ModelPrice;
  maxOutputTokens?: number;
}

export function estimateCostMicroUsd(input: EstimateCostInput): number {
  return computeCostMicroUsd(
    {
      promptTokens: estimatePromptTokens(input.prompt),
      cachedTokens: 0,
      completionTokens: input.maxOutputTokens ?? 0,
    },
    input.price,
  );
}
