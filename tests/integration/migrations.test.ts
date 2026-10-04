import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  REQUIRED_TABLE_NAMES,
  STEP_ONE_TABLE_NAMES,
  STEP_THREE_TABLE_NAMES,
  STEP_FOUR_TABLE_NAMES,
  STEP_FIVE_TABLE_NAMES,
  STEP_SEVEN_TABLE_NAMES,
  STEP_SIX_TABLE_NAMES,
  STEP_EIGHT_TABLE_NAMES,
  STEP_NINE_TABLE_NAMES,
  appliedMigrationCount,
  applyMigrations,
  isMigrated,
  listTables,
  missingTables,
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
  it('crée toutes les tables attendues depuis une base vide', () => {
    const tables = listTables(context.handle);
    for (const expected of REQUIRED_TABLE_NAMES) {
      expect(tables, `table attendue : ${expected}`).toContain(expected);
    }
    // La liste vérifiée par l'amorçage doit couvrir **toutes** les étapes : une
    // table oubliée ici serait une base acceptée au démarrage puis cassée à la
    // première requête.
    expect(REQUIRED_TABLE_NAMES).toEqual([
      ...STEP_ONE_TABLE_NAMES,
      ...STEP_THREE_TABLE_NAMES,
      // Les deux tables éditoriales de l'étape 3 (sujets et angles) : elles
      // arrivent avec la migration 0003, mais elles appartiennent à l'étape 3.
      'content_subjects',
      'subject_angles',
      ...STEP_FOUR_TABLE_NAMES,
      ...STEP_FIVE_TABLE_NAMES,
      ...STEP_SIX_TABLE_NAMES,
      ...STEP_SEVEN_TABLE_NAMES,
      // Étape 8 : les plafonds de dépense et les trois réceptacles des mesures
      // futures (docs/10 §4.8). Trois d'entre elles n'ont pas encore de pipeline —
      // c'est justement pour ça qu'elles sont citées ici.
      ...STEP_EIGHT_TABLE_NAMES,
      // Étape 9 : intention calendrier et propositions, séparées de l'état
      // distant (`publications`) et de l'exécution (`jobs`).
      ...STEP_NINE_TABLE_NAMES,
    ]);
    expect(STEP_THREE_TABLE_NAMES).toEqual([
      'conversations',
      'messages',
      'conversation_summaries',
      'master_briefs',
    ]);
    // Les huit tables de l'étape 4 (docs/10 §4.4) : les cinq du contenu et de la
    // vidéo, et les trois de l'observabilité. Les citer explicitement est le but
    // du test — `video_renders`, `errors`, `system_health` et `notifications`
    // n'ont encore aucun code qui les interroge à ce stade, et c'est
    // précisément quand une table n'est pas encore utilisée qu'elle peut
    // disparaître d'une migration sans que personne ne le voie.
    expect(STEP_FOUR_TABLE_NAMES).toEqual([
      'content_items',
      'content_versions',
      'content_claims',
      'content_review_notes',
      'video_renders',
      'errors',
      'system_health',
      'notifications',
    ]);
    expect(STEP_FIVE_TABLE_NAMES).toEqual([
      'project_platforms',
      'platform_accounts',
      'publications',
      'publication_attempts',
      'manual_packages',
    ]);
    // Les trois tables de l'étape 6 (docs/10 §4.6) : l'audio téléversé, sa
    // transcription locale, et le lien entre un message envoyé et son audio.
    // `message_attachments` est ce qui rend un audio **introuvable à supprimer**
    // une fois envoyé — la preuve de ce qui a été dit.
    expect(STEP_SIX_TABLE_NAMES).toEqual(['media_assets', 'transcripts', 'message_attachments']);
    // Les deux tables de l'étape 7 (docs/03 §13) : la veille, **schéma seulement**.
    // Le pipeline arrive à l'étape 10 ; ce qui est vérifié ici, c'est que le modèle
    // de données existe vraiment — c'est le seul écart assumé du plan (docs/10 §4.7).
    expect(STEP_SEVEN_TABLE_NAMES).toEqual(['news_sources', 'news_items']);
    expect(STEP_NINE_TABLE_NAMES).toEqual(['calendar_slots', 'calendar_change_proposals']);
    expect(appliedMigrationCount(context.handle)).toBeGreaterThan(0);
  });

  it('nomme les tables manquantes au lieu de dire « schéma incomplet »', () => {
    expect(missingTables(context.handle, REQUIRED_TABLE_NAMES)).toEqual([]);
    expect(isMigrated(context.handle, REQUIRED_TABLE_NAMES)).toBe(true);

    context.handle.sqlite.exec('drop table conversation_summaries');

    expect(missingTables(context.handle, REQUIRED_TABLE_NAMES)).toEqual(['conversation_summaries']);
    expect(isMigrated(context.handle, REQUIRED_TABLE_NAMES)).toBe(false);
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
