import {
  BUDGET_PERIODS,
  microToUsd,
  periodStartMs,
  usdToMicro,
  type BudgetPeriod,
} from '@aia/shared';
import {
  countLlmCallsSince,
  spendMicroUsdSince,
  tokenTotalsSince,
  type DatabaseHandle,
  type TokenTotals,
} from '@aia/database';

/**
 * Agrégations de dépense à l'étape 1 : le **seul indicateur financier à voir en
 * permanence** (docs/08 §5.4). Les analytics produit (métriques de plateformes,
 * apprentissages) arrivent à l'étape 11 ; ce paquet ne fait ici que du suivi de
 * coût, avec une seule source : `llm_calls`.
 */

export type BudgetState = 'ok' | 'vigilance' | 'economy' | 'hard_stop';

export interface SpendWindow {
  period: BudgetPeriod;
  startMs: number;
  spentMicroUsd: number;
  limitMicroUsd: number;
  remainingMicroUsd: number;
  /** Part consommée du plafond, entre 0 et 1+ (jamais arrondie pour l'affichage). */
  ratio: number;
  calls: number;
}

export interface BudgetStatus {
  day: SpendWindow;
  month: SpendWindow;
  tokens: TokenTotals & { limit: number; ratio: number };
  state: BudgetState;
  /** Messages prêts à afficher, jamais des codes d'erreur (docs/08 §6.3). */
  alerts: string[];
}

export interface BudgetLimits {
  /** `app_settings.daily_budget_usd`. */
  dailyUsd: number;
  /** Budget de référence du cahier des charges : 5 $/mois. */
  monthlyUsd: number;
  dailyTokenLimit: number;
}

export interface BudgetStatusInput {
  nowMs: number;
  /** Fuseau de l'utilisateur, stocké dans `app_settings.timezone` (docs/03 §2.2). */
  timeZone: string;
  limits: BudgetLimits;
}

/** Seuils du mode économie (docs/08 §9.2). */
export const BUDGET_THRESHOLDS = {
  vigilance: 0.8,
  economy: 0.95,
  hardStop: 1,
} as const;

function windowFor(
  handle: DatabaseHandle,
  period: BudgetPeriod,
  input: BudgetStatusInput,
  limitUsd: number,
): SpendWindow {
  const startMs = periodStartMs(period === 'week' ? 'week' : period, input.nowMs, input.timeZone);
  const spentMicroUsd = spendMicroUsdSince(handle, startMs);
  const limitMicroUsd = usdToMicro(limitUsd);
  return {
    period,
    startMs,
    spentMicroUsd,
    limitMicroUsd,
    remainingMicroUsd: Math.max(0, limitMicroUsd - spentMicroUsd),
    ratio: limitMicroUsd === 0 ? 0 : spentMicroUsd / limitMicroUsd,
    calls: countLlmCallsSince(handle, startMs),
  };
}

export function stateFromRatio(ratio: number): BudgetState {
  if (ratio >= BUDGET_THRESHOLDS.hardStop) return 'hard_stop';
  if (ratio >= BUDGET_THRESHOLDS.economy) return 'economy';
  if (ratio >= BUDGET_THRESHOLDS.vigilance) return 'vigilance';
  return 'ok';
}

/**
 * Le solde du budget, en une requête par période. L'état retenu est le **plus
 * contraignant** des deux (jour et mois) : c'est celui qui protège l'utilisateur.
 */
export function budgetStatus(handle: DatabaseHandle, input: BudgetStatusInput): BudgetStatus {
  const day = windowFor(handle, 'day', input, input.limits.dailyUsd);
  const month = windowFor(handle, 'month', input, input.limits.monthlyUsd);
  const tokens = tokenTotalsSince(handle, month.startMs);

  const state = stateFromRatio(Math.max(day.ratio, month.ratio));
  const alerts: string[] = [];

  if (day.ratio >= BUDGET_THRESHOLDS.hardStop) {
    alerts.push(
      `Plafond journalier atteint (${formatUsd(day.spentMicroUsd)} sur ${input.limits.dailyUsd.toFixed(2)} $). Les jobs consommateurs restent en attente.`,
    );
  } else if (day.ratio >= BUDGET_THRESHOLDS.vigilance) {
    alerts.push(
      `Budget journalier consommé à ${Math.round(day.ratio * 100)} % (${formatUsd(day.spentMicroUsd)}).`,
    );
  }

  if (month.ratio >= BUDGET_THRESHOLDS.vigilance) {
    alerts.push(
      `Budget mensuel consommé à ${Math.round(month.ratio * 100)} %${month.ratio >= BUDGET_THRESHOLDS.economy ? ' : passage en mode économie' : ''}.`,
    );
  }

  const tokenRatio =
    input.limits.dailyTokenLimit === 0 ? 0 : tokens.totalTokens / input.limits.dailyTokenLimit;
  if (tokenRatio >= BUDGET_THRESHOLDS.vigilance) {
    alerts.push(
      `Jetons du mois : ${tokens.totalTokens} sur un plafond journalier de ${input.limits.dailyTokenLimit}.`,
    );
  }

  return {
    day,
    month,
    tokens: { ...tokens, limit: input.limits.dailyTokenLimit, ratio: tokenRatio },
    state,
    alerts,
  };
}

export function formatUsd(microUsd: number): string {
  return `$${microToUsd(microUsd).toFixed(4)}`;
}

/** Libellés affichables des périodes budgétaires. */
export const BUDGET_PERIOD_LABELS: Record<BudgetPeriod, string> = {
  day: 'aujourd’hui',
  week: 'cette semaine',
  month: 'ce mois-ci',
};

export { BUDGET_PERIODS };
