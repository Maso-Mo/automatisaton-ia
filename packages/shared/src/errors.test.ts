import { describe, expect, it } from 'vitest';
import { ERROR_CATEGORIES } from './enums';
import {
  AppError,
  BudgetExceededError,
  MissingCredentialError,
  RETRY_POLICY,
  TransientError,
  isAppError,
  serializeError,
  toAppError,
} from './errors';

describe('modèle d’erreurs (docs/02 §12)', () => {
  it('donne une politique de reprise à chaque catégorie, sans trou', () => {
    const categories = Object.keys(RETRY_POLICY).sort();
    expect(categories).toEqual([...ERROR_CATEGORIES].sort());
  });

  it('applique exactement la table de décision du document', () => {
    expect(RETRY_POLICY.transient.retry).toBe('yes');
    expect(RETRY_POLICY.internal.retry).toBe('once');
    // Règle absolue : jamais de reprise automatique sur un résultat ambigu.
    expect(RETRY_POLICY.ambiguous.retry).toBe('no');
    expect(RETRY_POLICY.budget.retry).toBe('no');
    expect(RETRY_POLICY.budget.alert).toBe(true);
    expect(RETRY_POLICY.validation.alert).toBe(false);
  });

  it('porte sa catégorie et accepte un code et des détails', () => {
    const error = new BudgetExceededError('Budget journalier insuffisant', {
      details: { estimatedMicroUsd: 21_000, remainingMicroUsd: 8_000 },
    });
    expect(error.category).toBe('budget');
    expect(error.code).toBe('BUDGET_EXCEEDED');
    expect(error.details).toEqual({ estimatedMicroUsd: 21_000, remainingMicroUsd: 8_000 });
    expect(error.name).toBe('BudgetExceededError');
  });

  it('convertit toute valeur levée en erreur typée', () => {
    const plain = new TypeError('x is not a function');
    expect(toAppError(plain).category).toBe('internal');
    expect(toAppError('boom').category).toBe('internal');
    const transient = new TransientError('réseau');
    expect(toAppError(transient)).toBe(transient);
    expect(isAppError(transient)).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
  });

  it('sérialise sans perdre la catégorie', () => {
    const serialized = serializeError(new MissingCredentialError('Clé IA absente'));
    expect(serialized.category).toBe('auth');
    expect(serialized.code).toBe('MISSING_CREDENTIAL');
    expect(serialized.message).toBe('Clé IA absente');
    expect(typeof serialized.stack).toBe('string');
  });

  it('conserve la cause d’origine', () => {
    const cause = new Error('connexion refusée');
    const wrapped = new AppError('appel impossible', 'transient', { cause });
    expect(wrapped.cause).toBe(cause);
  });
});
