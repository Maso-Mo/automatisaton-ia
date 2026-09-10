import { createManualClock } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { getSystemHealth, type SystemHealthPorts } from './health';

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);
const TABLES = ['users', 'jobs', 'job_events', 'llm_calls'];

function makePorts(overrides: Partial<SystemHealthPorts> = {}): SystemHealthPorts {
  return {
    app: {
      name: 'automatisation-ia',
      version: '0.1.0',
      env: 'test',
      host: '127.0.0.1',
      port: 4317,
    },
    expectedTables: TABLES,
    startedAtMs: NOW - 5_000,
    clock: createManualClock(NOW),
    database: {
      sqliteVersion: () => '3.45.0',
      tables: () => [...TABLES],
      appliedMigrations: () => 1,
      walEnabled: () => true,
    },
    queue: {
      counts: () => ({ queued: 0, running: 0, completed: 2, failed: 0 }),
      latestHeartbeatAt: () => NOW - 4_000,
      lastCompletedJob: () => ({
        id: 'job-1',
        type: 'noop',
        finishedAt: NOW - 10_000,
        durationMs: 120,
        costMicroUsd: 81,
      }),
    },
    prompts: { summary: () => ({ total: 2, active: 1, lastSyncedAt: NOW - 1_000 }) },
    budget: {
      status: () => ({
        day: { spentMicroUsd: 81, limitMicroUsd: 1_000_000, remainingMicroUsd: 999_919, calls: 1 },
        month: { spentMicroUsd: 81, limitMicroUsd: 5_000_000, ratio: 0.0000162 },
        state: 'ok',
        alerts: [],
      }),
    },
    secrets: {
      presence: () => ({ SESSION_SECRET: true, ENCRYPTION_KEY: true, DEEPSEEK_API_KEY: true }),
      providerDefault: () => 'deepseek',
    },
    ...overrides,
  };
}

describe('diagnostic de l’étape 1 (docs/10 §4.1)', () => {
  it('annonce « ok » quand base, worker, clé IA et budget sont en place', () => {
    const health = getSystemHealth(makePorts());
    expect(health.status).toBe('ok');
    expect(health.checks.map((check) => check.id)).toContain('database');
    expect(health.checks.map((check) => check.id)).toContain('worker');
    expect(health.checks.every((check) => check.status === 'ok')).toBe(true);
    expect(health.budget.todayMicroUsd).toBe(81);
    expect(health.lastCompletedJob?.type).toBe('noop');
    expect(health.uptimeMs).toBe(5_000);
  });

  it('bloque quand la base n’est pas migrée, et dit quoi exécuter', () => {
    const health = getSystemHealth(
      makePorts({
        database: {
          sqliteVersion: () => '3.45.0',
          tables: () => ['users'],
          appliedMigrations: () => 0,
          walEnabled: () => true,
        },
      }),
    );
    expect(health.status).toBe('blocked');
    const check = health.checks.find((entry) => entry.id === 'database');
    expect(check?.status).toBe('error');
    expect(check?.detail).toContain('pnpm db:migrate');
  });

  it('dégrade sans bloquer quand le worker est muet ou la clé IA absente', () => {
    const health = getSystemHealth(
      makePorts({
        queue: {
          counts: () => ({ queued: 3, running: 0 }),
          latestHeartbeatAt: () => null,
          lastCompletedJob: () => null,
        },
        secrets: {
          presence: () => ({ SESSION_SECRET: true, ENCRYPTION_KEY: true, DEEPSEEK_API_KEY: false }),
          providerDefault: () => 'deepseek',
        },
      }),
    );
    expect(health.status).toBe('degraded');
    expect(health.checks.find((entry) => entry.id === 'worker')?.status).toBe('warn');
    expect(health.checks.find((entry) => entry.id === 'llm')?.status).toBe('warn');
    expect(health.checks.find((entry) => entry.id === 'llm')?.detail).toContain('indisponibles');
  });

  it('détecte un worker muet alors qu’un job est marqué en cours', () => {
    const health = getSystemHealth(
      makePorts({
        queue: {
          counts: () => ({ queued: 0, running: 1 }),
          latestHeartbeatAt: () => NOW - 10 * 60_000,
          lastCompletedJob: () => null,
        },
      }),
    );
    expect(health.worker.active).toBe(false);
    expect(health.status).toBe('degraded');
  });

  it('signale un dépassement de budget comme une erreur, pas comme un avertissement', () => {
    const health = getSystemHealth(
      makePorts({
        budget: {
          status: () => ({
            day: {
              spentMicroUsd: 1_000_000,
              limitMicroUsd: 1_000_000,
              remainingMicroUsd: 0,
              calls: 9,
            },
            month: { spentMicroUsd: 5_000_000, limitMicroUsd: 5_000_000, ratio: 1 },
            state: 'hard_stop',
            alerts: ['Plafond journalier atteint'],
          }),
        },
      }),
    );
    expect(health.status).toBe('blocked');
    expect(health.checks.find((entry) => entry.id === 'budget')?.status).toBe('error');
    expect(health.budget.alerts).toHaveLength(1);
  });
});
