import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidv7, createSystemClock, encodeJson } from '@aia/shared';
import {
  REQUIRED_TABLE_NAMES,
  applyMigrations,
  insertJob,
  insertLlmCall,
  listTables,
  missingTables,
  openDatabase,
  setSetting,
  type DatabaseHandle,
} from '@aia/database';

/**
 * Vérification des migrations (docs/03 §16.3 : « chaque migration est exécutée en
 * CI sur une copie de base peuplée de données de test »).
 *
 * Trois contrôles, dans cet ordre :
 * 1. base **vide** → appliquer toutes les migrations → les tables attendues existent ;
 * 2. base **peuplée** → réappliquer → rien de perdu, rien de cassé ;
 * 3. réapplication → **0 migration** appliquée (idempotence).
 */

function withTempDatabase<T>(fn: (handle: DatabaseHandle, file: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'aia-migrations-'));
  const file = join(directory, 'check.sqlite');
  const handle = openDatabase({ file });
  try {
    return fn(handle, file);
  } finally {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function seed(handle: DatabaseHandle): void {
  const now = createSystemClock().nowMs();
  const ownerId = uuidv7(now);

  handle.sqlite
    .prepare(
      'insert into users (id, display_name, locale, created_at, updated_at) values (?, ?, ?, ?, ?)',
    )
    .run(ownerId, 'Vérification des migrations', 'fr-FR', now, now);

  handle.sqlite
    .prepare(
      'insert into projects (id, owner_id, name, slug, status, language, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(uuidv7(now), ownerId, 'Projet de test', 'projet-de-test', 'discovery', 'fr', now, now);

  const projectId = handle.sqlite.prepare('select id from projects limit 1').get() as {
    id: string;
  };

  setSetting(handle, 'timezone', 'Europe/Paris', 'string', now);

  insertJob(handle, {
    id: uuidv7(now),
    type: 'noop',
    priority: 9,
    inputJson: encodeJson({ message: 'jeu de données de vérification' }),
    dedupeKey: null,
    idempotent: true,
    requiresNetwork: false,
    scheduledFor: now,
    availableAt: now,
    maxAttempts: 3,
    projectId: projectId.id,
    now,
  });

  insertLlmCall(handle, {
    id: uuidv7(now),
    agent: 'system',
    task: 'cost_probe',
    provider: 'deepseek',
    model: 'deepseek-chat',
    requestJson: encodeJson({ prompt: 'vérification' }),
    costMicroUsd: 81,
    status: 'success',
    now,
  });
}

function countRows(handle: DatabaseHandle, table: string): number {
  const row = handle.sqlite.prepare(`select count(*) as total from ${table}`).get() as {
    total: number;
  };
  return row.total;
}

function main(): void {
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '✅' : '❌'} ${label} — ${detail}`);
    if (!ok) failures += 1;
  };

  withTempDatabase((handle) => {
    const first = applyMigrations(handle);
    const tables = new Set(listTables(handle));
    const missing = missingTables(handle, REQUIRED_TABLE_NAMES);
    check(
      'base vide → migrations',
      missing.length === 0,
      missing.length > 0
        ? `${missing.length} table(s) manquante(s) : ${missing.join(', ')}`
        : `${first.applied} migration(s) appliquée(s), ${tables.size} tables, les ${REQUIRED_TABLE_NAMES.length} attendues présentes`,
    );

    seed(handle);
    const before = {
      users: countRows(handle, 'users'),
      projects: countRows(handle, 'projects'),
      jobs: countRows(handle, 'jobs'),
      llm_calls: countRows(handle, 'llm_calls'),
      app_settings: countRows(handle, 'app_settings'),
    };

    const second = applyMigrations(handle);
    check(
      'réapplication sur base peuplée',
      second.applied === 0,
      `${second.applied} migration appliquée`,
    );

    const after = {
      users: countRows(handle, 'users'),
      projects: countRows(handle, 'projects'),
      jobs: countRows(handle, 'jobs'),
      llm_calls: countRows(handle, 'llm_calls'),
      app_settings: countRows(handle, 'app_settings'),
    };
    check(
      'aucune donnée perdue',
      JSON.stringify(before) === JSON.stringify(after),
      JSON.stringify(after),
    );

    // Le mode WAL doit survivre à la réouverture : c'est ce qui protège le worker.
    const journal = handle.sqlite.prepare('pragma journal_mode').get() as { journal_mode: string };
    check('mode WAL actif', journal.journal_mode.toLowerCase() === 'wal', journal.journal_mode);
  });

  if (failures > 0) {
    console.error(`\n${failures} contrôle(s) en échec.`);
    process.exit(1);
  }
  console.log('\nMigrations vérifiées sur base vide et sur base peuplée.');
}

main();
