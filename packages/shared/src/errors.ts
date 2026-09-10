import type { ErrorCategory } from './enums';

/**
 * Une seule hiérarchie d'erreurs, et **une catégorie qui décide mécaniquement du
 * comportement** (retry, affichage, alerte) — docs/02 §12.
 *
 * Emplacement : la hiérarchie de base vit dans `@aia/shared` (et non dans
 * `@aia/core`) parce qu'un paquet d'infrastructure ne dépend jamais du domaine
 * (docs/02 §5) : la file doit pouvoir appliquer la politique de reprise sans
 * importer le domaine. `@aia/core` réexporte cette base et y ajoute ses erreurs
 * métier (`InvalidStateTransitionError`, `ContentNotApprovedError`, …), ce qui
 * préserve la règle « une seule hiérarchie ».
 */

export interface SerializedError {
  name: string;
  category: ErrorCategory;
  code?: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
}

export interface AppErrorOptions {
  code?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, category: ErrorCategory, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.category = category;
    this.code = options.code;
    this.details = options.details;
  }

  toJSON(): SerializedError {
    return serializeError(this);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'validation', options);
  }
}

export class ConfigError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'validation', { code: 'CONFIG_INVALID', ...options });
  }
}

export class MissingCredentialError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'auth', { code: 'MISSING_CREDENTIAL', ...options });
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'forbidden', options);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'not_found', options);
  }
}

export class ConflictError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'conflict', options);
  }
}

export class TransientError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'transient', options);
  }
}

/** Levée **avant** l'appel, jamais après (docs/02 §12). */
export class BudgetExceededError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'budget', { code: 'BUDGET_EXCEEDED', ...options });
  }
}

export class CapabilityError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'capability', options);
  }
}

/** Résultat indéterminé : jamais de reprise automatique. */
export class AmbiguousOutcomeError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'ambiguous', options);
  }
}

/** Le système ne peut pas trancher : une décision humaine est requise. */
export class NeedsHumanDecisionError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'ambiguous', { code: 'NEEDS_HUMAN_DECISION', ...options });
  }
}

export class InternalError extends AppError {
  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, 'internal', options);
  }
}

export interface RetryPolicyEntry {
  /** `yes` = jusqu'à `maxAttempts`, `once` = une seule reprise, `no` = aucune. */
  retry: 'yes' | 'once' | 'no';
  userAction: string;
  alert: boolean;
}

/** Table de décision de docs/02 §12. Elle est appliquée par la file, jamais par un handler. */
export const RETRY_POLICY: Record<ErrorCategory, RetryPolicyEntry> = {
  validation: { retry: 'no', userAction: 'corriger la saisie', alert: false },
  auth: { retry: 'no', userAction: 'reconnecter le compte', alert: true },
  forbidden: { retry: 'no', userAction: '—', alert: true },
  not_found: { retry: 'no', userAction: '—', alert: false },
  conflict: { retry: 'no', userAction: "recharger l'écran", alert: false },
  transient: { retry: 'yes', userAction: 'rien pendant les essais', alert: true },
  budget: { retry: 'no', userAction: 'augmenter le plafond ou attendre', alert: true },
  capability: { retry: 'no', userAction: 'publier manuellement', alert: false },
  ambiguous: { retry: 'no', userAction: 'vérifier la plateforme, décider', alert: true },
  internal: { retry: 'once', userAction: '—', alert: true },
};

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Toute valeur levée devient une erreur typée : un `TypeError` est un bug (`internal`). */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) {
    return new InternalError(error.message, { cause: error });
  }
  return new InternalError(String(error), { cause: error });
}

export function serializeError(error: unknown): SerializedError {
  const appError = toAppError(error);
  const serialized: SerializedError = {
    name: appError.name,
    category: appError.category,
    message: appError.message,
  };
  if (appError.code !== undefined) serialized.code = appError.code;
  if (appError.details !== undefined) serialized.details = appError.details;
  if (appError.stack !== undefined) serialized.stack = appError.stack;
  return serialized;
}
