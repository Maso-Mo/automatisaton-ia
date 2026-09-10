import {
  AmbiguousOutcomeError,
  BudgetExceededError,
  ConflictError,
  MissingCredentialError,
  TransientError,
  ValidationError,
} from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { decideRetry, isRetryAllowed } from './retry-policy';

const context = { attempt: 1, maxAttempts: 3, idempotent: true };

describe('politique de reprise appliquée par la file (docs/02 §12)', () => {
  it('réessaie les erreurs transitoires jusqu’à épuisement des tentatives', () => {
    expect(decideRetry(new TransientError('502'), context).retry).toBe(true);
    expect(decideRetry(new TransientError('502'), { ...context, attempt: 2 }).retry).toBe(true);
    expect(decideRetry(new TransientError('502'), { ...context, attempt: 3 }).retry).toBe(false);
  });

  it('réessaie une seule fois une erreur interne (probablement un bug)', () => {
    expect(decideRetry(new TypeError('x is not a function'), context).retry).toBe(true);
    expect(
      decideRetry(new TypeError('x is not a function'), { ...context, attempt: 2 }).retry,
    ).toBe(false);
  });

  it('ne réessaie jamais un résultat ambigu — la règle la plus importante', () => {
    const decision = decideRetry(new AmbiguousOutcomeError('timeout après envoi'), context);
    expect(decision.retry).toBe(false);
    expect(decision.requiresHumanDecision).toBe(true);
    expect(isRetryAllowed('ambiguous')).toBe(false);
  });

  it('ne réessaie pas les erreurs de validation, d’authentification ou de conflit', () => {
    expect(decideRetry(new ValidationError('champ manquant'), context).retry).toBe(false);
    expect(decideRetry(new MissingCredentialError('clé absente'), context).retry).toBe(false);
    expect(decideRetry(new ConflictError('double approbation'), context).retry).toBe(false);
  });

  it('traite un dépassement de budget comme une retenue, pas comme un échec à réessayer', () => {
    const decision = decideRetry(new BudgetExceededError('plafond du jour atteint'), context);
    expect(decision.retry).toBe(false);
    expect(decision.category).toBe('budget');
  });

  it('n’expose pas plus de tentatives que le maximum déclaré', () => {
    const decision = decideRetry(new TransientError('429'), {
      attempt: 3,
      maxAttempts: 3,
      idempotent: true,
    });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toContain('tentatives épuisées');
  });
});
