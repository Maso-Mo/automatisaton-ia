import { BudgetExceededError, formatMicroUsd } from '@aia/shared';

/**
 * Le veto de budget, appliqué **avant** l'appel, jamais après :
 *
 * > « Contrôler après coup n'est pas contrôler, c'est constater » (docs/11 §2.7).
 *
 * `estimateCost()` fait partie du contrat `LLMProvider` précisément pour cela
 * (docs/02 §9.1, docs/08 §8.3). La fonction est pure : la partie qui lit la base
 * est dans `spend.ts`.
 */

export interface BudgetCheckInput {
  estimatedMicroUsd: number;
  remainingMicroUsd: number;
  /** Plafond en dur = refus ; plafond souple = avertissement seulement (docs/08 §8.2). */
  hardStop?: boolean;
  /** Période concernée, pour un message qui nomme la cause. */
  periodLabel?: string;
}

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkBudget(input: BudgetCheckInput): BudgetCheckResult {
  const hardStop = input.hardStop ?? true;
  if (input.estimatedMicroUsd <= input.remainingMicroUsd) {
    return { allowed: true };
  }

  const period = input.periodLabel ?? 'journalier';
  const reason =
    `Budget ${period} insuffisant. Il reste ${formatMicroUsd(input.remainingMicroUsd)} ; ` +
    `cet appel est estimé à ${formatMicroUsd(input.estimatedMicroUsd)}.`;

  return hardStop ? { allowed: false, reason } : { allowed: true, reason };
}

/** Lève `BudgetExceededError` : c'est la seule façon dont un appel est refusé. */
export function assertWithinBudget(input: BudgetCheckInput): void {
  const result = checkBudget(input);
  if (result.allowed) return;
  throw new BudgetExceededError(result.reason ?? 'Budget insuffisant', {
    details: {
      estimatedMicroUsd: input.estimatedMicroUsd,
      remainingMicroUsd: input.remainingMicroUsd,
    },
  });
}

/** État d'un job retenu par le budget : il reste `queued`, il n'est pas annulé. */
export interface JobHoldReason {
  held: boolean;
  reason?: string;
}

export function holdReasonForBudget(result: BudgetCheckResult): JobHoldReason {
  return result.allowed
    ? { held: false }
    : { held: true, ...(result.reason === undefined ? {} : { reason: result.reason }) };
}
