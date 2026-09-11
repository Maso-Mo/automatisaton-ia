import {
  appliedMigrationCount,
  applyMigrations,
  listTables,
  MIGRATIONS_FOLDER,
  openDatabase,
} from '@aia/database';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Migration ascendante : `0001` s'applique **sur une base déjà peuplée**, sans
 * perte et sans casser les invariants (docs/09 §2 famille 14 : « migration
 * ascendante sur une base peuplée, sans perte »).
 *
 * Pourquoi ce test existe : la migration `0001` reconstruit `project_facts`
 * (SQLite ne sait pas ajouter une contrainte `CHECK` autrement) et traduit
 * l'ancien booléen `verified_by_user` en nouvel état de vérification. Ce que la
 * commande `drizzle-kit generate` produit ne sait pas faire cela tout seul — elle
 * recopie des colonnes qui n'existent pas encore. Sans ce test, la migration
 * échouerait sur la base de l'utilisateur, pas sur une base vide.
 */

let directory: string;
let handle: ReturnType<typeof openDatabase>;

/** Dossier de migrations ne contenant que la première migration. */
function partialMigrationsFolder(base: string): string {
  const folder = join(base, 'migrations-0000');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const first = journal.entries[0];
  if (!first) throw new Error('journal de migrations vide');
  copyFileSync(join(MIGRATIONS_FOLDER, `${first.tag}.sql`), join(folder, `${first.tag}.sql`));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: [first] }),
  );
  return folder;
}

function seedStepOne(handle: ReturnType<typeof openDatabase>): void {
  const sqlite = handle.sqlite;
  sqlite
    .prepare(
      'insert into users (id, display_name, locale, created_at, updated_at) values (?, ?, ?, ?, ?)',
    )
    .run('user-1', 'Propriétaire local', 'fr-FR', 1_000, 1_000);
  sqlite
    .prepare(
      'insert into projects (id, owner_id, name, slug, status, language, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'projet-1',
      'user-1',
      'Projet historique',
      'projet-historique',
      'active',
      'fr',
      1_000,
      1_000,
    );
  sqlite
    .prepare(
      'insert into project_facts (id, project_id, category, statement, source, verified_by_user, importance, used_count, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'fait-verifie',
      'projet-1',
      'chiffre',
      'un fait confirmé',
      'user_edit',
      1,
      4,
      0,
      1_000,
      2_000,
    );
  sqlite
    .prepare(
      'insert into project_facts (id, project_id, category, statement, source, verified_by_user, importance, used_count, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'fait-brut',
      'projet-1',
      'opinion',
      'un fait non confirmé',
      'user_import',
      0,
      2,
      0,
      1_000,
      2_000,
    );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aia-upgrade-'));
  handle = openDatabase({ file: join(directory, 'upgrade.sqlite') });
});

afterEach(() => {
  try {
    handle.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('migration ascendante de la mémoire des projets', () => {
  it('applique 0001 sur une base peuplée sans perdre de donnée', () => {
    const first = applyMigrations(handle, {
      migrationsFolder: partialMigrationsFolder(directory),
    });
    expect(first.applied).toBe(1);
    expect(listTables(handle)).toContain('project_facts');

    seedStepOne(handle);

    const second = applyMigrations(handle);
    expect(second.applied).toBe(1);
    expect(appliedMigrationCount(handle)).toBe(2);

    const rows = handle.sqlite
      .prepare(
        'select id, statement, verification_status, verified_by_user, verified_at from project_facts order by id',
      )
      .all() as Array<{
      id: string;
      statement: string;
      verification_status: string;
      verified_by_user: number;
      verified_at: number | null;
    }>;

    expect(rows).toHaveLength(2);
    const verified = rows.find((row) => row.id === 'fait-verifie');
    const plain = rows.find((row) => row.id === 'fait-brut');

    // L'ancien booléen devient un état, et la date de confirmation est datée
    // avec la meilleure preuve disponible (`updated_at`, faute de mieux).
    expect(verified?.verification_status).toBe('verified');
    expect(verified?.verified_by_user).toBe(1);
    expect(verified?.verified_at).toBe(2_000);
    expect(verified?.statement).toBe('un fait confirmé');

    expect(plain?.verification_status).toBe('user_provided');
    expect(plain?.verified_by_user).toBe(0);
    expect(plain?.verified_at).toBeNull();
    expect(plain?.statement).toBe('un fait non confirmé');

    // Aucune violation d'intégrité après la reconstruction de la table.
    expect(handle.sqlite.prepare('pragma foreign_key_check').all()).toHaveLength(0);

    // Les nouvelles garanties sont en place : index, unicité, déclencheurs.
    const names = (
      handle.sqlite
        .prepare("select name from sqlite_master where type in ('index','trigger')")
        .all() as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(names).toContain('idx_facts_verification');
    expect(names).toContain('uq_facts_supersedes');
    expect(names).toContain('trg_project_facts_no_delete');
    expect(names).toContain('trg_project_facts_verification_requires_human');

    // Le déclencheur protège aussi les données migrées.
    expect(() => handle.sqlite.prepare('delete from project_facts').run()).toThrow(
      /suppression_interdite/,
    );

    // Réappliquer ne fait rien : la migration est idempotente.
    expect(applyMigrations(handle).applied).toBe(0);
  });
});
