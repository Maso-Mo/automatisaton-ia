import { AppError } from '@aia/shared';

/**
 * Une seule hiérarchie d'erreurs pour tout le produit (docs/02 §12).
 *
 * La base vit dans `@aia/shared` pour qu'un paquet d'infrastructure (la file, un
 * connecteur) puisse lever une erreur typée **sans dépendre du domaine**
 * (docs/02 §5). Ce fichier est la porte d'entrée du domaine : il réexporte la
 * base et ajoute les erreurs purement métier.
 */

export {
  AmbiguousOutcomeError,
  AppError,
  BudgetExceededError,
  CapabilityError,
  ConfigError,
  ConflictError,
  ForbiddenError,
  InternalError,
  MissingCredentialError,
  NeedsHumanDecisionError,
  NotFoundError,
  RETRY_POLICY,
  TransientError,
  ValidationError,
  isAppError,
  serializeError,
  toAppError,
} from '@aia/shared';

export type { ErrorCategory, RetryPolicyEntry, SerializedError } from '@aia/shared';

/** Une transition d'état interdite : c'est un conflit, jamais une reprise. */
export class InvalidStateTransitionError extends AppError {
  constructor(from: string, to: string, options: { entity?: string } = {}) {
    super(
      `Transition interdite${options.entity ? ` (${options.entity})` : ''} : ${from} → ${to}`,
      'conflict',
      { code: 'INVALID_STATE_TRANSITION', details: { from, to, entity: options.entity } },
    );
  }
}

/**
 * C'est l'invariant n°1 du produit, implémenté **dans le domaine** : aucun bug
 * d'API ni de connecteur ne peut publier un brouillon (docs/02 §4).
 */
export class ContentNotApprovedError extends AppError {
  constructor(contentVersionId: string) {
    super(
      `Publication refusée : la version ${contentVersionId} n’est pas approuvée par l’utilisateur`,
      'forbidden',
      { code: 'CONTENT_NOT_APPROVED', details: { contentVersionId } },
    );
  }
}

/** Une entrée du domaine incohérente avec l'état réel du projet. */
export class ProjectNotReadyError extends AppError {
  constructor(projectId: string, missing: readonly string[]) {
    super(
      `Le projet ${projectId} n’est pas prêt : ${missing.join(', ')} manquant(s)`,
      'validation',
      { code: 'PROJECT_NOT_READY', details: { projectId, missing } },
    );
  }
}
