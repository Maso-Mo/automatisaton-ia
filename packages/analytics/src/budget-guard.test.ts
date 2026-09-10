import { BudgetExceededError, formatMicroUsd } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { checkBudget, assertWithinBudget } from './budget-guard';
import { stateFromRatio } from './spend';

describe('veto de budget, avant l’appel (docs/08 §8)', () => {
  it('autorise un appel qui tient dans le budget restant', () => {
    const result = checkBudget({ estimatedMicroUsd: 8_000, remainingMicroUsd: 20_000 });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('refuse avant de payer, avec un message qui donne les deux montants', () => {
    const result = checkBudget({ estimatedMicroUsd: 21_000, remainingMicroUsd: 8_000 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(formatMicroUsd(8_000));
    expect(result.reason).toContain(formatMicroUsd(21_000));
    expect(result.reason).toContain('insuffisant');
  });

  it('lève BudgetExceededError : rien n’est envoyé', () => {
    expect(() =>
      assertWithinBudget({ estimatedMicroUsd: 21_000, remainingMicroUsd: 8_000 }),
    ).toThrow(BudgetExceededError);
    try {
      assertWithinBudget({ estimatedMicroUsd: 21_000, remainingMicroUsd: 8_000 });
    } catch (error) {
      const typed = error as BudgetExceededError;
      expect(typed.category).toBe('budget');
      expect(typed.code).toBe('BUDGET_EXCEEDED');
      expect(typed.details).toEqual({
        estimatedMicroUsd: 21_000,
        remainingMicroUsd: 8_000,
      });
    }
  });

  it('avertit sans bloquer quand le plafond est souple', () => {
    const result = checkBudget({
      estimatedMicroUsd: 21_000,
      remainingMicroUsd: 8_000,
      hardStop: false,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('nomme la période concernée dans le message', () => {
    const result = checkBudget({
      estimatedMicroUsd: 5,
      remainingMicroUsd: 1,
      periodLabel: 'mensuel',
    });
    expect(result.reason).toContain('mensuel');
  });

  it('positionne le mode économie selon les seuils documentés (docs/08 §9.2)', () => {
    expect(stateFromRatio(0.2)).toBe('ok');
    expect(stateFromRatio(0.8)).toBe('vigilance');
    expect(stateFromRatio(0.95)).toBe('economy');
    expect(stateFromRatio(1)).toBe('hard_stop');
    expect(stateFromRatio(1.4)).toBe('hard_stop');
  });
});
