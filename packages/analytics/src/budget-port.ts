import { z } from 'zod';
import { periodStartMs, type Clock } from '@aia/shared';
import { getSetting, resolveTimeZone, type DatabaseHandle } from '@aia/database';
import { budgetStatus, type BudgetLimits, type BudgetStatus } from './spend';

/**
 * Port de budget : la seule fonction que la génération appelle **avant** chaque
 * appel payant (docs/08 §8.1). Il retourne le budget restant de la période la
 * plus contrainte, jamais un booléen seul — le message d'erreur doit pouvoir
 * dire « il reste 0,008 $ ; cet appel est estimé à 0,021 $ ».
 */

export interface BudgetPortOptions {
  handle: DatabaseHandle;
  clock: Clock;
  limits: BudgetLimits;
  /** `true` = refus en dur ; `false` = avertissement (docs/08 §8.2). */
  hardStop?: boolean;
  /** Fuseau forcé (tests) ; par défaut `app_settings.timezone`, sinon le système. */
  timeZone?: string;
}

export interface BudgetSnapshot {
  remainingMicroUsd: number;
  hardStop: boolean;
  periodLabel: string;
  status: BudgetStatus;
}

export interface BudgetPort {
  snapshot(): BudgetSnapshot;
  status(): BudgetStatus;
  timeZone(): string;
}

/**
 * Les plafonds viennent de `.env` à l'étape 1 (le panneau de réglages et la table
 * `budget_limits` arrivent aux étapes 4 et 8) ; `app_settings.daily_budget_usd`
 * est déjà respecté s'il existe.
 */
export function createBudgetPort(options: BudgetPortOptions): BudgetPort {
  const timeZone = (): string => options.timeZone ?? resolveTimeZone(options.handle);
  const hardStop = options.hardStop ?? true;

  const effectiveLimits = (): BudgetLimits => {
    const stored = getSetting(options.handle, 'daily_budget_usd', z.number().positive());
    return stored ? { ...options.limits, dailyUsd: stored.value } : options.limits;
  };

  const status = (): BudgetStatus =>
    budgetStatus(options.handle, {
      nowMs: options.clock.nowMs(),
      timeZone: timeZone(),
      limits: effectiveLimits(),
    });

  return {
    status,
    timeZone,
    snapshot: () => {
      const current = status();
      const day = current.day;
      const month = current.month;
      const binding = day.ratio >= month.ratio ? day : month;
      return {
        remainingMicroUsd:
          current.state === 'hard_stop'
            ? 0
            : Math.min(day.remainingMicroUsd, month.remainingMicroUsd),
        hardStop,
        periodLabel: binding.period === 'day' ? 'journalier' : 'mensuel',
        status: current,
      };
    },
  };
}

/** Bornes d'une période, exposées pour l'affichage du tableau de bord. */
export function periodBounds(
  period: 'day' | 'week' | 'month',
  clock: Clock,
  timeZone: string,
): { startMs: number; dateKey: string } {
  const startMs = periodStartMs(period, clock.nowMs(), timeZone);
  return { startMs, dateKey: new Date(startMs).toISOString() };
}
