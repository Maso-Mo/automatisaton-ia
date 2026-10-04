import {
  MS_PER_DAY,
  MS_PER_WEEK,
  formatMicroUsd,
  periodStartMs,
  usdToMicro,
  type BudgetPeriod,
} from '@aia/shared';
import {
  createBudgetLimitStore,
  spendMicroUsdSince,
  type BudgetLimitRecord,
  type DatabaseHandle,
} from '@aia/database';
import type { BudgetLimits } from './spend';

/**
 * Le **frein de budget** de l'étape 8 : les plafonds de `budget_limits`
 * (docs/03 §4.4, docs/08 §8.1) lus **avant** l'action, et non après.
 *
 * Trois choses distinguent ce module du simple seuil d'environnement :
 *
 * 1. **la portée** — un plafond global n'empêche pas un projet d'absorber tout
 *    le budget. `scope = 'project'` et `scope = 'task'` sont ce qui rend la
 *    contrainte utile sur un produit personnel : « la publication n'a droit
 *    qu'à 0,50 $/jour » ;
 * 2. **la période** — jour, semaine, mois. La base peut porter un plafond
 *    hebdomadaire là où `.env` n'en connaît qu'un mensuel ;
 * 3. **le veto**, pas le constat — `evaluateBudgetBrake()` répond « retenu » ou
 *    « autorisé » **avant** l'appel, avec la raison écrite pour l'utilisateur.
 *
 * La règle de sûreté de docs/11 §2.7 est tenue ici : un dépassement **retient**
 * l'action (elle reste `queued`, avec sa raison) au lieu de la détruire — le
 * travail repart le lendemain avec un budget neuf, au lieu d'être perdu.
 */

/** Nom de la tâche sous laquelle la publication est comptée (`budget_limits.scope_ref`). */
export const PUBLICATION_TASK = 'publication';

export interface ScopedBudgetLimits {
  /** Plafonds issus de `.env` (`MONTHLY_BUDGET_USD`, `DAILY_BUDGET_USD`). */
  env: BudgetLimits;
  /** Plafonds issus de `budget_limits`, par portée et par période. */
  stored: BudgetLimitRecord[];
}

export function loadScopedBudgetLimits(
  handle: DatabaseHandle,
  env: BudgetLimits,
): ScopedBudgetLimits {
  return {
    env,
    stored: createBudgetLimitStore(handle, () => 0).list(),
  };
}

/**
 * Le plafond **applicable** pour un couple (portée, référence, période) : la
 * ligne de `budget_limits` si elle existe, sinon la valeur d'environnement.
 *
 * Le retour est `null` quand **rien** ne s'applique : c'est le cas d'un plafond
 * par projet sur un projet qui n'en a pas déclaré — l'absence de plafond n'est
 * pas un plafond à zéro, et c'est la nuance qui ferait bloquer tout le produit.
 */
export function effectiveLimit(input: {
  limits: ScopedBudgetLimits;
  scope: 'global' | 'project' | 'task';
  scopeRef: string;
  period: BudgetPeriod;
}): { limitMicroUsd: number; hardStop: boolean; origin: 'stored' | 'env' } | null {
  const stored = input.limits.stored.find(
    (row) =>
      row.scope === input.scope && row.scopeRef === input.scopeRef && row.period === input.period,
  );
  if (stored) {
    return {
      limitMicroUsd: stored.limitMicroUsd,
      hardStop: stored.hardStop,
      origin: 'stored',
    };
  }
  if (input.scope !== 'global') return null;
  if (input.period === 'day') {
    return { limitMicroUsd: usdToMicro(input.limits.env.dailyUsd), hardStop: true, origin: 'env' };
  }
  if (input.period === 'month') {
    return {
      limitMicroUsd: usdToMicro(input.limits.env.monthlyUsd),
      hardStop: true,
      origin: 'env',
    };
  }
  // Le plafond **hebdomadaire** n'existe pas dans `.env` : le budget de référence
  // du cahier des charges est mensuel. S'il doit être hebdomadaire, il s'écrit
  // dans `budget_limits` — et alors la ligne devient la référence visible.
  return null;
}

export interface BudgetBrakeInput {
  handle: DatabaseHandle;
  limits: ScopedBudgetLimits;
  nowMs: number;
  timeZone: string;
  projectId?: string | null;
  /** Tâche concernée (`budget_limits.scope_ref`), par exemple `publication`. */
  task?: string | null;
  /** Coût estimé de l'action visée, en micro-dollars. `0` pour une action gratuite. */
  estimatedMicroUsd: number;
}

export interface BudgetBrake {
  /** `true` : l'action ne doit pas avoir lieu maintenant (elle est retenue). */
  held: boolean;
  /** `true` : elle est autorisée. Un dépassement souple (`hard_stop = 0`) autorise en avertissant. */
  allowed: boolean;
  /** Message écrit pour l'utilisateur, avec les chiffres (docs/06 §3.2, docs/08 §8.3). */
  reason?: string;
  scope?: 'global' | 'project' | 'task';
  period?: BudgetPeriod;
  spentMicroUsd?: number;
  limitMicroUsd?: number;
  remainingMicroUsd?: number;
  /** Nombre de contraintes examinées : sert au diagnostic, jamais à la décision. */
  evaluated: number;
}

/**
 * Le veto, évalué **avant** l'action. Toutes les contraintes applicables sont
 * examinées (global jour/semaine/mois, projet, tâche) et la **plus
 * contraignante** décide : c'est le seul ordre qui protège l'utilisateur, parce
 * qu'un plafond de tâche respecté ne rachète pas un budget mensuel dépassé.
 *
 * Un plafond souple (`hard_stop = 0`) **n'empêche pas** : il documente. Le
 * message est alors rendu quand même, parce que « on continue, et voici de
 * combien on dépasse » est une information utile (docs/08 §8.2).
 */
export function evaluateBudgetBrake(input: BudgetBrakeInput): BudgetBrake {
  const candidates: Array<{
    scope: 'global' | 'project' | 'task';
    scopeRef: string;
    period: BudgetPeriod;
    limitMicroUsd: number;
    hardStop: boolean;
  }> = [];

  for (const period of ['day', 'week', 'month'] as const) {
    const global = effectiveLimit({
      limits: input.limits,
      scope: 'global',
      scopeRef: '',
      period,
    });
    if (global) candidates.push({ scope: 'global', scopeRef: '', period, ...global });
  }
  if (input.projectId) {
    for (const period of ['day', 'week', 'month'] as const) {
      const project = effectiveLimit({
        limits: input.limits,
        scope: 'project',
        scopeRef: input.projectId,
        period,
      });
      if (project) {
        candidates.push({ scope: 'project', scopeRef: input.projectId, period, ...project });
      }
    }
  }
  if (input.task) {
    for (const period of ['day', 'week', 'month'] as const) {
      const task = effectiveLimit({
        limits: input.limits,
        scope: 'task',
        scopeRef: input.task,
        period,
      });
      if (task) candidates.push({ scope: 'task', scopeRef: input.task, period, ...task });
    }
  }

  let blocked: BudgetBrake | null = null;
  let warning: BudgetBrake | null = null;

  for (const candidate of candidates) {
    // Chaque période est lue **depuis son propre début** : la dépense
    // d'aujourd'hui ne consomme pas deux fois le plafond de la semaine.
    const since = periodStartMs(candidate.period, input.nowMs, input.timeZone);
    const spentMicroUsd = spendMicroUsdSince(input.handle, since);
    const projected = spentMicroUsd + Math.max(0, input.estimatedMicroUsd);
    if (projected <= candidate.limitMicroUsd) continue;

    const remainingMicroUsd = Math.max(0, candidate.limitMicroUsd - spentMicroUsd);
    const scopeLabel =
      candidate.scope === 'global'
        ? 'global'
        : candidate.scope === 'project'
          ? 'du projet'
          : `de la tâche « ${candidate.scopeRef} »`;
    const reason =
      `Budget ${scopeLabel} ${PERIOD_WORDS[candidate.period]} insuffisant : ` +
      `${formatMicroUsd(spentMicroUsd)} dépensés sur ${formatMicroUsd(candidate.limitMicroUsd)}. ` +
      `L’action est retenue (il reste ${formatMicroUsd(remainingMicroUsd)}).`;

    const entry: BudgetBrake = {
      held: candidate.hardStop,
      allowed: !candidate.hardStop,
      reason,
      scope: candidate.scope,
      period: candidate.period,
      spentMicroUsd,
      limitMicroUsd: candidate.limitMicroUsd,
      remainingMicroUsd,
      evaluated: candidates.length,
    };
    if (entry.held) {
      blocked = entry;
      break;
    }
    warning ??= entry;
  }

  const decided = blocked ?? warning;
  if (decided) return decided;
  return { held: false, allowed: true, evaluated: candidates.length };
}

const PERIOD_WORDS: Record<BudgetPeriod, string> = {
  day: 'journalier',
  week: 'hebdomadaire',
  month: 'mensuel',
};

/**
 * Durée **nominale** d'une période, pour la prévision uniquement.
 *
 * La semaine et le mois ne font pas exactement 7 × 24 h et 30 × 24 h dans un
 * fuseau qui change d'heure : une prévision est une extrapolation (docs/08
 * §10.1), et l'annoncer à l'heure près serait une fausse précision. Le calcul
 * **du plafond**, lui, reste calendaire (`periodStartMs`, fuseau de
 * l'utilisateur) : c'est la seule chose qui doit être exacte.
 */
export function nominalPeriodMs(period: BudgetPeriod): number {
  switch (period) {
    case 'day':
      return MS_PER_DAY;
    case 'week':
      return MS_PER_WEEK;
    case 'month':
      return 30 * MS_PER_DAY;
  }
}

export interface SpendForecast {
  period: BudgetPeriod;
  /** Début de la période courante (bornes calendaires, fuseau utilisateur). */
  startMs: number;
  endMs: number;
  elapsedRatio: number;
  spentMicroUsd: number;
  /** Extrapolation linéaire du rythme observé — jamais une promesse. */
  projectedMicroUsd: number;
  limitMicroUsd: number;
  /** La prévision dépasse-t-elle le plafond ? C'est l'alerte, pas le montant. */
  overLimit: boolean;
}

/**
 * « Prévision fin de semaine ≈ 2,10 $ (rythme actuel) » (docs/08 §10.1).
 *
 * Un total sans projection n'indique pas s'il y a un problème ; une projection
 * linéaire suffit à alerter, et elle est **honnête** : elle est nommée comme une
 * extrapolation du rythme observé, pas comme une mesure. Avant la première
 * seconde écoulée, elle vaut la dépense réelle — on ne divise pas par zéro.
 */
export function forecastSpend(input: {
  handle: DatabaseHandle;
  period: BudgetPeriod;
  nowMs: number;
  timeZone: string;
  limitMicroUsd: number;
}): SpendForecast {
  const startMs = periodStartMs(input.period, input.nowMs, input.timeZone);
  const endMs = startMs + nominalPeriodMs(input.period);
  const elapsedRatio = Math.min(1, Math.max(0, (input.nowMs - startMs) / (endMs - startMs)));
  const spentMicroUsd = spendMicroUsdSince(input.handle, startMs);
  const projectedMicroUsd =
    elapsedRatio <= 0 ? spentMicroUsd : Math.round(spentMicroUsd / elapsedRatio);
  return {
    period: input.period,
    startMs,
    endMs,
    elapsedRatio,
    spentMicroUsd,
    projectedMicroUsd,
    limitMicroUsd: input.limitMicroUsd,
    overLimit: projectedMicroUsd > input.limitMicroUsd,
  };
}
