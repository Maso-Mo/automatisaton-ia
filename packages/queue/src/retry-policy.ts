import { RETRY_POLICY, serializeError, toAppError } from '@aia/shared';

/**
 * « Règle absolue : un handler **ne décide pas** de la politique de retry. Il
 * lève une erreur typée ; la queue décide » (docs/02 §12).
 *
 * C'est ici que cette décision est prise, à partir de la **catégorie** de
 * l'erreur — jamais de son type concret, jamais de son message.
 */

export interface RetryDecision {
  retry: boolean;
  reason: string;
  category: ReturnType<typeof toAppError>['category'];
  /** Catégorie `ambiguous` : aucune reprise ne doit avoir lieu, même forcée. */
  requiresHumanDecision: boolean;
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  /** Un job non idempotent ne se rejoue pas s'il a pu produire un effet de bord. */
  idempotent: boolean;
}

export function decideRetry(error: unknown, context: RetryContext): RetryDecision {
  const appError = toAppError(error);
  const policy = RETRY_POLICY[appError.category];
  const base = {
    category: appError.category,
    requiresHumanDecision: appError.category === 'ambiguous',
  };

  if (appError.category === 'ambiguous') {
    return {
      ...base,
      retry: false,
      reason: `résultat indéterminé (${serializeError(appError).name}) : décision humaine requise`,
    };
  }

  if (policy.retry === 'no') {
    return { ...base, retry: false, reason: `catégorie ${appError.category} : pas de reprise` };
  }

  if (policy.retry === 'once') {
    return context.attempt <= 1
      ? { ...base, retry: true, reason: `catégorie ${appError.category} : une seule reprise` }
      : { ...base, retry: false, reason: `catégorie ${appError.category} : reprise déjà tentée` };
  }

  if (context.attempt >= context.maxAttempts) {
    return {
      ...base,
      retry: false,
      reason: `tentatives épuisées (${context.attempt}/${context.maxAttempts})`,
    };
  }

  return {
    ...base,
    retry: true,
    reason: `catégorie ${appError.category} : reprise ${context.attempt + 1}/${context.maxAttempts}`,
  };
}

/** Une reprise forcée reste soumise à l'interdit sur les résultats ambigus. */
export function isRetryAllowed(category: ReturnType<typeof toAppError>['category']): boolean {
  return category !== 'ambiguous';
}
