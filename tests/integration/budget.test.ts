import { afterEach, describe, expect, it } from 'vitest';
import { createBudgetPort, budgetStatus } from '@aia/analytics';
import { insertLlmCall } from '@aia/database';
import { MS_PER_DAY, uuidv7 } from '@aia/shared';
import { createTestContext, TEST_NOW, type TestContext } from '../support/harness';

/**
 * Suivi de budget : la seule mesure dont l'absence mettrait l'utilisateur en
 * danger (docs/09 §4.3). Tous les montants sont en micro-dollars entiers.
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function seedCall(microUsd: number, createdAt: number, task = 'cost_probe'): void {
  if (!context) throw new Error('contexte absent');
  insertLlmCall(context.handle, {
    id: uuidv7(createdAt),
    agent: 'system',
    task,
    provider: 'deepseek',
    model: 'deepseek-chat',
    requestJson: '{}',
    costMicroUsd: microUsd,
    status: 'success',
    now: createdAt,
  });
}

describe('agrégation des dépenses et veto de budget (docs/08 §7, §8)', () => {
  it('additionne le jour et le mois sans confondre les périodes', () => {
    context = createTestContext();
    seedCall(81_400, TEST_NOW - 3_600_000); // aujourd'hui
    seedCall(10_000, TEST_NOW - 2 * MS_PER_DAY); // il y a deux jours, même mois
    seedCall(999_999, Date.UTC(2026, 1, 15, 12, 0, 0)); // mois précédent

    const status = budgetStatus(context.handle, {
      nowMs: TEST_NOW,
      timeZone: 'UTC',
      limits: { dailyUsd: 1, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
    });

    expect(status.day.spentMicroUsd).toBe(81_400);
    expect(status.day.calls).toBe(1);
    expect(status.month.spentMicroUsd).toBe(91_400);
    expect(status.state).toBe('ok');
    expect(status.alerts).toHaveLength(0);
  });

  it('bascule en mode économie à 80 % du budget mensuel', () => {
    context = createTestContext();
    seedCall(4_000_000, TEST_NOW - 1_000); // 4 $ sur 5 $ = 80 %

    const status = budgetStatus(context.handle, {
      nowMs: TEST_NOW,
      timeZone: 'UTC',
      limits: { dailyUsd: 10, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
    });

    expect(status.state).toBe('vigilance');
    expect(status.alerts.join(' ')).toContain('Budget mensuel');
  });

  it('arrête tout à 100 % du plafond journalier, avec un message explicite', () => {
    context = createTestContext();
    seedCall(1_000_000, TEST_NOW - 1_000);

    const status = budgetStatus(context.handle, {
      nowMs: TEST_NOW,
      timeZone: 'UTC',
      limits: { dailyUsd: 1, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
    });

    expect(status.state).toBe('hard_stop');
    expect(status.day.remainingMicroUsd).toBe(0);
    expect(status.alerts.join(' ')).toMatch(/Plafond journalier atteint/);
  });

  it('expose le budget restant le plus contraignant des deux périodes', () => {
    context = createTestContext();
    seedCall(900_000, TEST_NOW - 1_000); // 0,90 $ aujourd'hui

    const budget = createBudgetPort({
      handle: context.handle,
      clock: context.clock,
      timeZone: 'UTC',
      limits: { dailyUsd: 1, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
    });
    const snapshot = budget.snapshot();

    expect(snapshot.remainingMicroUsd).toBe(100_000);
    expect(snapshot.periodLabel).toBe('journalier');
    expect(snapshot.hardStop).toBe(true);
    expect(budget.timeZone()).toBe('UTC');
  });

  it('tient compte de `app_settings.daily_budget_usd` quand il est défini', () => {
    context = createTestContext();
    context.handle.sqlite
      .prepare(
        "insert into app_settings (key, value_json, value_type, updated_at) values ('daily_budget_usd', '0.5', 'number', ?)",
      )
      .run(TEST_NOW);

    const budget = createBudgetPort({
      handle: context.handle,
      clock: context.clock,
      timeZone: 'UTC',
      limits: { dailyUsd: 100, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
    });

    expect(budget.status().day.limitMicroUsd).toBe(500_000);
    expect(budget.timeZone()).toBe('UTC');
  });
});
