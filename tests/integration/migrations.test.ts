import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  STEP_ONE_TABLE_NAMES,
  appliedMigrationCount,
  applyMigrations,
  listTables,
} from '@aia/database';
import { decodeJson, uuidv7 } from '@aia/shared';
import { createTestContext, TEST_NOW, type TestContext } from '../support/harness';

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
});

afterEach(() => {
  context.cleanup();
});

describe('migrations et contraintes de la base (docs/03 §15)', () => {
  it('crée les 13 tables de l’étape 1 depuis une base vide', () => {
    const tables = listTables(context.handle);
    for (const expected of STEP_ONE_TABLE_NAMES) {
      expect(tables, `table attendue : ${expected}`).toContain(expected);
    }
    expect(appliedMigrationCount(context.handle)).toBeGreaterThan(0);
  });

  it('est idempotent : réappliquer n’applique rien', () => {
    const before = appliedMigrationCount(context.handle);
    const report = applyMigrations(context.handle);
    expect(report.applied).toBe(0);
    expect(appliedMigrationCount(context.handle)).toBe(before);
  });

  it('interdit deux fournisseurs IA par défaut (index partiel)', () => {
    const now = TEST_NOW;
    const insert = context.handle.sqlite.prepare(
      'insert into llm_providers_config (id, provider, is_default, enabled, key_version, created_at, updated_at) values (?, ?, 1, 1, 1, ?, ?)',
    );
    insert.run(uuidv7(now), 'deepseek', now, now);
    expect(() => insert.run(uuidv7(now), 'openai', now, now)).toThrow(/UNIQUE/i);
  });

  it('interdit deux jobs en attente avec la même clé logique, mais l’autorise après clôture', () => {
    const insert = context.handle.sqlite.prepare(
      "insert into jobs (id, type, status, priority, input_json, scheduled_for, available_at, attempt, max_attempts, dedupe_key, idempotent, requires_network, progress, cost_micro_usd, created_at, updated_at) values (?, 'noop', ?, 5, '{}', ?, ?, 0, 3, ?, 1, 0, 0, 0, ?, ?)",
    );
    const dedupe = 'diagnostic:noop';
    insert.run(uuidv7(TEST_NOW), 'queued', TEST_NOW, TEST_NOW, dedupe, TEST_NOW, TEST_NOW);
    expect(() =>
      insert.run(uuidv7(TEST_NOW), 'queued', TEST_NOW, TEST_NOW, dedupe, TEST_NOW, TEST_NOW),
    ).toThrow(/UNIQUE/i);

    // Un job terminé libère la clé : le prochain clic doit créer un nouveau job.
    insert.run(uuidv7(TEST_NOW), 'completed', TEST_NOW, TEST_NOW, dedupe, TEST_NOW, TEST_NOW);
  });

  it('garantit une séquence strictement croissante par job', () => {
    const jobId = uuidv7(TEST_NOW);
    context.handle.sqlite
      .prepare(
        "insert into jobs (id, type, status, priority, input_json, scheduled_for, available_at, attempt, max_attempts, idempotent, requires_network, progress, cost_micro_usd, created_at, updated_at) values (?, 'noop', 'queued', 5, '{}', ?, ?, 0, 3, 1, 0, 0, 0, ?, ?)",
      )
      .run(jobId, TEST_NOW, TEST_NOW, TEST_NOW, TEST_NOW);

    const insertEvent = context.handle.sqlite.prepare(
      "insert into job_events (id, job_id, sequence, level, message, created_at) values (?, ?, ?, 'info', ?, ?)",
    );
    insertEvent.run(uuidv7(TEST_NOW), jobId, 1, 'début', TEST_NOW);
    expect(() => insertEvent.run(uuidv7(TEST_NOW), jobId, 1, 'doublon', TEST_NOW)).toThrow(
      /UNIQUE/i,
    );
  });

  it('refuse une clé étrangère inconnue quand les clés étrangères sont actives', () => {
    const insert = context.handle.sqlite.prepare(
      "insert into project_goals (id, project_id, label, metric, period, status, created_at, updated_at) values (?, ?, 'objectif', 'cadence', 'month', 'active', ?, ?)",
    );
    expect(() => insert.run(uuidv7(TEST_NOW), 'project-inexistant', TEST_NOW, TEST_NOW)).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('refuse une valeur de JSON qui ne respecte pas son schéma Zod', () => {
    const schema = z.object({ importance: z.number().int().min(1).max(5) });
    const decoded = decodeJson(schema, '{"importance": 9}', 'facts_json');
    expect(decoded.ok).toBe(false);
  });

  it('génère des identifiants triés temporellement (UUID v7)', () => {
    const ids = [uuidv7(TEST_NOW), uuidv7(TEST_NOW + 1), uuidv7(TEST_NOW + 2)];
    expect([...ids].sort()).toEqual(ids);
  });
});
