import { ValidationError } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from '../errors';
import {
  FACT_STATEMENT_MAX_LENGTH,
  assertFactContent,
  assertFactStatusTransition,
  assertSourceAllowsInitialStatus,
  canTransitionFactStatus,
  defaultFactStatusFor,
  deriveVerifiedByUser,
  isActiveFact,
  isAiOrigin,
  isTrustedFact,
  planFactEdit,
  planFactSupersession,
  planFactVerification,
} from './facts';
import type { ProjectFact } from './types';

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

function makeFact(overrides: Partial<ProjectFact> = {}): ProjectFact {
  return {
    id: 'fact-1',
    projectId: 'projet-1',
    category: 'note',
    statement: 'un fait',
    detail: null,
    source: 'user_input',
    sourceMessageId: null,
    verificationStatus: 'user_provided',
    verificationNote: null,
    verifiedAt: null,
    verifiedByUser: false,
    importance: 3,
    usedCount: 0,
    lastUsedAt: null,
    supersedesFactId: null,
    supersededByFactId: null,
    supersededAt: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    deletedAt: null,
    ...overrides,
  };
}

describe('états de vérification d’un fait (docs/10 §4.2)', () => {
  it('distingue les six états et refuse une transition inconnue', () => {
    expect(canTransitionFactStatus('user_provided', 'verified')).toBe(true);
    expect(canTransitionFactStatus('verified', 'superseded')).toBe(true);
    // Un fait remplacé ne redevient pas vivant : l'historique reste linéaire.
    expect(canTransitionFactStatus('superseded', 'verified')).toBe(false);
    expect(() => assertFactStatusTransition('superseded', 'verified', { factId: 'f1' })).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('laisse un même état se réécrire sans erreur (idempotence)', () => {
    expect(() => assertFactStatusTransition('verified', 'verified')).not.toThrow();
  });

  it('dérive `verified_by_user` de l’état, jamais l’inverse', () => {
    expect(deriveVerifiedByUser('verified')).toBe(true);
    for (const status of [
      'proposed',
      'user_provided',
      'uncertain',
      'obsolete',
      'superseded',
    ] as const) {
      expect(deriveVerifiedByUser(status)).toBe(false);
    }
  });

  it('ne considère comme injectable que le fait confirmé, et comme vivant ni l’obsolète ni le remplacé', () => {
    expect(isTrustedFact({ verificationStatus: 'verified' })).toBe(true);
    expect(isTrustedFact({ verificationStatus: 'user_provided' })).toBe(false);
    expect(isActiveFact({ verificationStatus: 'obsolete' })).toBe(false);
    expect(isActiveFact({ verificationStatus: 'superseded' })).toBe(false);
    expect(isActiveFact({ verificationStatus: 'uncertain' })).toBe(true);
  });
});

describe('l’IA n’est jamais une source suffisante', () => {
  it('fait naître un fait d’origine IA en « proposed »', () => {
    expect(isAiOrigin('ai_proposal')).toBe(true);
    expect(isAiOrigin('conversation')).toBe(true);
    expect(isAiOrigin('user_input')).toBe(false);
    expect(defaultFactStatusFor('ai_proposal')).toBe('proposed');
    expect(defaultFactStatusFor('user_input')).toBe('user_provided');
  });

  it('confirmer un fait extrait est un acte humain daté', () => {
    const fact = makeFact({ verificationStatus: 'proposed', source: 'ai_proposal' });
    const patch = planFactVerification(fact, 'verified', NOW);
    expect(patch.verifiedByUser).toBe(true);
    expect(patch.verifiedAt).toBe(NOW);
    expect(patch.verificationStatus).toBe('verified');
  });

  it('refuse de créer un fait d’origine IA déjà confirmé', () => {
    // `assertSourceAllowsInitialStatus` est la garde du domaine : la confirmation
    // ne peut pas être une valeur initiale, seulement une transition.
    expect(() => assertSourceAllowsInitialStatus('ai_proposal', 'verified')).toThrow(
      ValidationError,
    );
    expect(() => assertSourceAllowsInitialStatus('conversation', 'user_provided')).toThrow(
      ValidationError,
    );
    expect(() => assertSourceAllowsInitialStatus('ai_proposal', 'proposed')).not.toThrow();
    expect(() => assertSourceAllowsInitialStatus('user_input', 'verified')).not.toThrow();
  });
});

describe('contenu d’un fait', () => {
  it('refuse un énoncé vide ou trop long, une importance hors 1–5', () => {
    expect(() => assertFactContent({ category: 'note', statement: '   ' })).toThrow(
      ValidationError,
    );
    expect(() =>
      assertFactContent({ category: 'note', statement: 'x'.repeat(FACT_STATEMENT_MAX_LENGTH + 1) }),
    ).toThrow(/ne dépasse pas/);
    expect(() => assertFactContent({ category: 'note', statement: 'ok', importance: 0 })).toThrow(
      ValidationError,
    );
    expect(() => assertFactContent({ category: 'note', statement: 'ok', importance: 6 })).toThrow(
      ValidationError,
    );
  });

  it('exige une adresse pour la catégorie « url »', () => {
    expect(() => assertFactContent({ category: 'url', statement: 'pas une adresse' })).toThrow(
      ValidationError,
    );
    expect(() =>
      assertFactContent({ category: 'url', statement: 'dépôt', detail: 'https://example.org/a' }),
    ).not.toThrow();
  });
});

describe('plans d’écriture', () => {
  it('ne touche pas l’état de vérification lors d’une correction de contenu', () => {
    const fact = makeFact({ verificationStatus: 'verified', verifiedAt: NOW - 5_000 });
    const patch = planFactEdit(fact, { statement: 'énoncé corrigé', importance: 5 }, NOW);
    expect(patch.statement).toBe('énoncé corrigé');
    expect(patch.importance).toBe(5);
    expect(patch.verificationStatus).toBeUndefined();
    expect(patch.updatedAt).toBe(NOW);
  });

  it('oublie la date de confirmation quand le fait n’est plus confirmé', () => {
    const fact = makeFact({ verificationStatus: 'verified', verifiedAt: NOW - 5_000 });
    const patch = planFactVerification(fact, 'uncertain', NOW, 'chiffre à revérifier');
    expect(patch.verificationStatus).toBe('uncertain');
    expect(patch.verifiedAt).toBeNull();
    expect(patch.verifiedByUser).toBe(false);
    expect(patch.verificationNote).toBe('chiffre à revérifier');
  });

  it('conserve la date de confirmation d’origine si elle existe déjà', () => {
    const fact = makeFact({ verificationStatus: 'uncertain', verifiedAt: NOW - 10_000 });
    const patch = planFactVerification(fact, 'verified', NOW);
    expect(patch.verifiedAt).toBe(NOW - 10_000);
  });

  it('remplace un fait au lieu de le supprimer, en pointant le successeur', () => {
    const fact = makeFact({ verificationStatus: 'verified', verifiedAt: NOW - 1_000 });
    const patch = planFactSupersession(fact, 'fact-2', NOW);
    expect(patch.verificationStatus).toBe('superseded');
    expect(patch.supersededByFactId).toBe('fact-2');
    expect(patch.supersededAt).toBe(NOW);
    expect(patch.verifiedAt).toBeNull();
  });

  it('refuse de remplacer un fait déjà remplacé', () => {
    const fact = makeFact({ verificationStatus: 'superseded', supersededByFactId: 'fact-3' });
    expect(() => planFactSupersession(fact, 'fact-4', NOW)).toThrow(InvalidStateTransitionError);
  });
});
