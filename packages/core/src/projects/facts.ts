import { ValidationError, type FactSource, type FactVerificationStatus } from '@aia/shared';
import { InvalidStateTransitionError } from '../errors';
import type { ProjectFact, ProjectFactPatch } from './types';

/**
 * Règles de la mémoire d'un projet (docs/03 §6.1, docs/10 §4.2).
 *
 * Deux idées gouvernent ce fichier :
 *
 * 1. **Un fait a un état de vérification explicite**, pas un booléen. Les états
 *    ont des transitions nommées : ce qui est interdit est impossible à écrire,
 *    pas seulement déconseillé (`InvalidStateTransitionError`).
 * 2. **L'IA n'est jamais une source suffisante.** Un fait d'origine `ai_proposal`
 *    ou `conversation` naît en `proposed`, et ne devient `verified` que par un
 *    acte humain explicite et daté (`verified_at`).
 */

/** Sources qui ne valent rien sans validation : l'IA propose, l'utilisateur dispose. */
export function isAiOrigin(source: FactSource): boolean {
  return source === 'ai_proposal' || source === 'conversation';
}

/** État initial d'un fait, déduit de son origine — jamais choisi par l'appelant. */
export function defaultFactStatusFor(source: FactSource): FactVerificationStatus {
  return isAiOrigin(source) ? 'proposed' : 'user_provided';
}

/**
 * Transitions autorisées. `superseded` est terminal : un fait remplacé ne
 * redevient pas vivant (l'historique reste linéaire et lisible).
 */
export const FACT_STATUS_TRANSITIONS: Record<
  FactVerificationStatus,
  readonly FactVerificationStatus[]
> = {
  proposed: ['user_provided', 'verified', 'uncertain', 'obsolete', 'superseded'],
  user_provided: ['verified', 'uncertain', 'obsolete', 'superseded'],
  uncertain: ['user_provided', 'verified', 'obsolete', 'superseded'],
  verified: ['user_provided', 'uncertain', 'obsolete', 'superseded'],
  obsolete: ['user_provided', 'verified', 'uncertain', 'superseded'],
  superseded: [],
};

export function canTransitionFactStatus(
  from: FactVerificationStatus,
  to: FactVerificationStatus,
): boolean {
  return from === to || (FACT_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export function assertFactStatusTransition(
  from: FactVerificationStatus,
  to: FactVerificationStatus,
  options: { factId?: string } = {},
): void {
  if (canTransitionFactStatus(from, to)) return;
  throw new InvalidStateTransitionError(from, to, {
    entity: options.factId ? `fait ${options.factId}` : 'fait du projet',
  });
}

/** La colonne booléenne documentée (docs/03 §6.1) dérive de l'état, jamais l'inverse. */
export function deriveVerifiedByUser(status: FactVerificationStatus): boolean {
  return status === 'verified';
}

/** Seuls les faits confirmés entrent dans un prompt (docs/03 §6.1). */
export function isTrustedFact(fact: Pick<ProjectFact, 'verificationStatus'>): boolean {
  return fact.verificationStatus === 'verified';
}

/** Un fait vivant : ni obsolète, ni remplacé. */
export function isActiveFact(fact: Pick<ProjectFact, 'verificationStatus'>): boolean {
  return fact.verificationStatus !== 'obsolete' && fact.verificationStatus !== 'superseded';
}

export interface FactContent {
  category: ProjectFact['category'];
  statement: string;
  detail?: string | null;
  importance?: number;
}

/** Bornes documentées : énoncé court, importance de 1 à 5 (docs/03 §6.1). */
export const FACT_STATEMENT_MAX_LENGTH = 500;
export const FACT_DETAIL_MAX_LENGTH = 4_000;

/** Une catégorie `url` doit contenir une adresse, sinon elle ne sert à rien. */
export function assertFactContent(content: FactContent): void {
  const statement = content.statement.trim();
  if (statement.length === 0) {
    throw new ValidationError('Un fait doit porter un énoncé non vide', {
      code: 'FACT_STATEMENT_REQUIRED',
    });
  }
  if (statement.length > FACT_STATEMENT_MAX_LENGTH) {
    throw new ValidationError(
      `Un fait ne dépasse pas ${FACT_STATEMENT_MAX_LENGTH} caractères (reçu : ${statement.length})`,
      { code: 'FACT_STATEMENT_TOO_LONG' },
    );
  }
  const detail = content.detail ?? null;
  if (detail !== null && detail.length > FACT_DETAIL_MAX_LENGTH) {
    throw new ValidationError(
      `Le détail d'un fait ne dépasse pas ${FACT_DETAIL_MAX_LENGTH} caractères`,
      { code: 'FACT_DETAIL_TOO_LONG' },
    );
  }
  const importance = content.importance ?? 3;
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new ValidationError(`L'importance d'un fait va de 1 à 5 (reçu : ${importance})`, {
      code: 'FACT_IMPORTANCE_OUT_OF_RANGE',
      details: { importance },
    });
  }
  if (content.category === 'url' && !isHttpUrl(detail ?? statement)) {
    throw new ValidationError('Un fait de catégorie « url » doit contenir une adresse http(s)', {
      code: 'FACT_URL_INVALID',
    });
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Interdit qu'un fait d'origine IA naisse « confirmé » : la confirmation est un
 * geste humain, donc une **transition** (`verifyFact`), pas une valeur initiale.
 */
export function assertSourceAllowsInitialStatus(
  source: FactSource,
  status: FactVerificationStatus,
): void {
  if (!isAiOrigin(source)) return;
  if (status === defaultFactStatusFor(source)) return;
  throw new ValidationError(
    `Un fait d’origine « ${source} » naît « proposed » : la confirmation est un acte explicite de l’utilisateur`,
    { code: 'AI_PROPOSAL_REQUIRES_HUMAN_VALIDATION', details: { source, status } },
  );
}

/** Un fait confirmé porte toujours la date de l'acte humain qui l'a confirmé. */
export function assertVerificationIsHumanAct(
  status: FactVerificationStatus,
  verifiedAt: number | null,
): void {
  if (status === 'verified' && verifiedAt === null) {
    throw new ValidationError('Un fait confirmé doit porter une date de confirmation', {
      code: 'FACT_VERIFICATION_REQUIRES_VERIFIED_AT',
    });
  }
}

export interface FactEditInput extends Partial<FactContent> {
  /** Note lisible : pourquoi le fait est incertain, obsolète ou remplacé. */
  verificationNote?: string | null;
}

/**
 * Calcule les colonnes à écrire pour modifier le **contenu** d'un fait. Pur :
 * aucun accès à la base, donc testable sans infrastructure (docs/09 §1).
 *
 * L'état de vérification n'est jamais modifié ici : changer d'état passe par
 * `planFactVerification`, qui valide la transition.
 */
export function planFactEdit(
  fact: ProjectFact,
  input: FactEditInput,
  now: number,
): ProjectFactPatch {
  const next: FactContent = {
    category: input.category ?? fact.category,
    statement: input.statement ?? fact.statement,
    detail: input.detail === undefined ? fact.detail : input.detail,
    importance: input.importance ?? fact.importance,
  };
  assertFactContent(next);

  const patch: ProjectFactPatch = { updatedAt: now };
  if (next.category !== fact.category) patch.category = next.category;
  if (next.statement !== fact.statement) patch.statement = next.statement;
  if (next.detail !== fact.detail) patch.detail = next.detail;
  if (next.importance !== fact.importance) patch.importance = next.importance;
  if (input.verificationNote !== undefined && input.verificationNote !== fact.verificationNote) {
    patch.verificationNote = input.verificationNote;
  }
  return patch;
}

/**
 * Calcule les colonnes à écrire pour changer l'**état de vérification**.
 * `verified` exige une date : l'acte est daté, donc traçable.
 */
export function planFactVerification(
  fact: ProjectFact,
  status: FactVerificationStatus,
  now: number,
  note: string | null = null,
): ProjectFactPatch {
  assertFactStatusTransition(fact.verificationStatus, status, { factId: fact.id });

  const verifiedAt = status === 'verified' ? (fact.verifiedAt ?? now) : null;
  assertVerificationIsHumanAct(status, verifiedAt);

  return {
    verificationStatus: status,
    verifiedAt,
    verifiedByUser: deriveVerifiedByUser(status),
    verificationNote: note,
    updatedAt: now,
  };
}

/**
 * Remplacement (jamais une suppression) : l'ancien fait devient `superseded` et
 * garde son énoncé, le nouveau le référence. L'historique complet reste lisible.
 */
export function planFactSupersession(
  previous: ProjectFact,
  replacementFactId: string,
  now: number,
): ProjectFactPatch {
  // Un fait déjà remplacé ne se remplace pas une seconde fois : la chaîne
  // d'historique resterait linéaire en apparence et fausse en réalité.
  if (previous.verificationStatus === 'superseded') {
    throw new InvalidStateTransitionError('superseded', 'superseded', {
      entity: `fait ${previous.id}`,
    });
  }
  assertFactStatusTransition(previous.verificationStatus, 'superseded', { factId: previous.id });

  return {
    verificationStatus: 'superseded',
    verifiedByUser: false,
    verifiedAt: null,
    supersededByFactId: replacementFactId,
    supersededAt: now,
    updatedAt: now,
  };
}
