import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appliedMigrationCount,
  applyMigrations,
  backupDatabase,
  inspectDatabaseFile,
  listTables,
  MIGRATIONS_FOLDER,
  missingTables,
  openDatabase,
  REQUIRED_TABLE_NAMES,
  STEP_ELEVEN_TABLE_NAMES,
  type DatabaseHandle,
} from '@aia/database';

/**
 * Sauvegarde, restauration et migration ascendante (étape 12 §7–§9).
 *
 * Deux affirmations sont testées, et aucune ne peut l'être « à l'œil » :
 *
 * 1. **une sauvegarde d'une base vivante est cohérente** (`VACUUM INTO`, jamais
 *    une copie de fichier) et **vérifiable** (empreinte SHA-256, intégrité) ;
 * 2. **une sauvegarde ancienne se restaure puis remonte le schéma** : c'est le
 *    critère de sortie de l'étape 12 — « l'application redémarre sur une base
 *    restaurée sans intervention manuelle ».
 */

let directory: string;
let handle: DatabaseHandle;

/** Dossier temporaire contenant les migrations jusqu'à l'index demandé inclus. */
function partialMigrationsFolder(base: string, lastIndex: number): string {
  const folder = join(base, `migrations-through-${String(lastIndex).padStart(4, '0')}`);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ tag: string }> };
  const selected = journal.entries.slice(0, lastIndex + 1);
  if (selected.length !== lastIndex + 1) throw new Error('journal de migrations incomplet');
  for (const entry of selected) {
    copyFileSync(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: selected }),
  );
  return folder;
}

/** Peuple la base : un utilisateur, un projet, un fait — de quoi prouver une restauration. */
function seed(db: DatabaseHandle): void {
  db.sqlite
    .prepare(
      'insert into users (id, display_name, locale, created_at, updated_at) values (?, ?, ?, ?, ?)',
    )
    .run('user-1', 'Propriétaire local', 'fr-FR', 1_000, 1_000);
  db.sqlite
    .prepare(
      'insert into projects (id, owner_id, name, slug, status, language, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'projet-1',
      'user-1',
      'Projet sauvegardé',
      'projet-sauvegarde',
      'active',
      'fr',
      1_000,
      1_000,
    );
  db.sqlite
    .prepare(
      'insert into project_facts (id, project_id, category, statement, source, importance, used_count, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('fait-1', 'projet-1', 'chiffre', 'un fait à retrouver', 'user_edit', 4, 0, 1_000, 2_000);
}

function projectCount(db: DatabaseHandle): number {
  const row = db.sqlite.prepare('select count(*) as count from projects').get() as {
    count: number;
  };
  return row.count;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aia-backup-'));
  handle = openDatabase({ file: join(directory, 'app.db') });
  applyMigrations(handle);
  seed(handle);
});

afterEach(() => {
  try {
    handle.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('sauvegarde et restauration de la base', () => {
  it('produit un snapshot cohérent d’une base vivante, sans la verrouiller', async () => {
    const target = join(directory, 'backups', 'db', '20260310-120000', 'app.db');
    const result = await backupDatabase(handle, { targetFile: target });

    expect(existsSync(target)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.migrations).toBe(appliedMigrationCount(handle));
    expect(result.sqliteVersion).toMatch(/^\d+\.\d+/);

    // La base d'origine continue de fonctionner : une sauvegarde ne fige rien.
    handle.sqlite
      .prepare(
        'insert into projects (id, owner_id, name, slug, status, language, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'projet-2',
        'user-1',
        'Après sauvegarde',
        'apres-sauvegarde',
        'active',
        'fr',
        2_000,
        2_000,
      );
    expect(projectCount(handle)).toBe(2);

    // La copie, elle, contient l'état du moment : un seul projet.
    const copy = openDatabase({ file: target });
    try {
      expect(projectCount(copy)).toBe(1);
    } finally {
      copy.close();
    }
  });

  it('relit une sauvegarde et refuse ce qui n’en est plus une', async () => {
    const target = join(directory, 'backups', 'db', '20260310-120000', 'app.db');
    const result = await backupDatabase(handle, { targetFile: target });

    const inspection = await inspectDatabaseFile(target);
    expect(inspection.integrity).toBe('ok');
    // L'empreinte est la preuve : c'est elle que compare la restauration.
    expect(inspection.checksum).toBe(result.checksum);
    expect(inspection.migrations).toBe(result.migrations);

    await expect(inspectDatabaseFile(join(directory, 'absent.db'))).rejects.toThrow(/introuvable/);

    // Fichier tronqué : la lecture échoue ou l'intégrité n'est plus bonne. Dans
    // les deux cas, la restauration refuse — c'est le contrat.
    const truncated = join(directory, 'tronque.db');
    writeFileSync(truncated, readFileSync(target).subarray(0, 512));
    const attempt = await inspectDatabaseFile(truncated).catch(() => null);
    expect(attempt === null || attempt.integrity !== 'ok').toBe(true);
  });
});

describe('restauration d’une sauvegarde ancienne et migration ascendante', () => {
  it('restaure une sauvegarde de l’étape 8 puis remonte le schéma jusqu’à aujourd’hui', async () => {
    // 1. Une base telle qu'elle existait à l'étape 8 (8 migrations sur 11).
    const old = openDatabase({ file: join(directory, 'etape8.db') });
    const migrated = applyMigrations(old, {
      migrationsFolder: partialMigrationsFolder(directory, 7),
    });
    expect(migrated.applied).toBe(8);
    // Ce que l'étape 11 a ajouté n'existe pas encore : sans cela, le test ne
    // prouverait pas une migration ascendante.
    expect(missingTables(old, STEP_ELEVEN_TABLE_NAMES).length).toBeGreaterThan(0);
    seed(old);
    const backup = await backupDatabase(old, {
      targetFile: join(directory, 'backups', 'db', '20260101-090000', 'app.db'),
    });
    old.close();
    expect(backup.migrations).toBe(8);

    // 2. Restauration : la copie remplace le fichier de base…
    const restoredFile = join(directory, 'restaure.db');
    copyFileSync(backup.file, restoredFile);
    const restored = openDatabase({ file: restoredFile });
    try {
      // … puis les migrations reprennent, sans intervention manuelle.
      const report = applyMigrations(restored);
      expect(report.applied).toBe(11 - 8);
      expect(appliedMigrationCount(restored)).toBe(11);
      expect(missingTables(restored, REQUIRED_TABLE_NAMES)).toEqual([]);
      expect(listTables(restored)).toContain('metric_snapshots');
      // Les données d'avant la mise à jour sont toujours là.
      expect(projectCount(restored)).toBe(1);
    } finally {
      restored.close();
    }
  });

  it('ne remplace jamais la base sans `--yes`, et refuse une sauvegarde altérée', async () => {
    const root = join(directory, 'backups');
    const label = '20260310-120000';
    const backupDir = join(root, 'db', label);
    const backupFile = join(backupDir, 'app.db');

    // Sauvegarde produite en processus, avec le même manifeste que `pnpm backup`.
    const result = await backupDatabase(handle, { targetFile: backupFile });
    writeFileSync(
      join(backupDir, 'metadata.json'),
      JSON.stringify({
        kind: 'db',
        createdAt: result.createdAt,
        label,
        file: 'app.db',
        sizeBytes: result.sizeBytes,
        checksum: result.checksum,
        migrations: result.migrations,
      }),
    );

    const target = join(directory, 'app.db');
    const before = readFileSync(target);
    const env = {
      ...process.env,
      DATABASE_URL: `file:${target}`,
      BACKUP_DIR: root,
      MEDIA_ROOT: join(directory, 'media'),
    };

    // Prévisualisation : rien n'est modifié, et le script dit comment appliquer.
    const preview = spawnSync('pnpm', ['exec', 'tsx', 'scripts/restore.ts'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });
    expect(preview.status, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('Relancer avec --yes pour appliquer.');
    expect(readFileSync(target).equals(before)).toBe(true);

    // Sauvegarde altérée (un octet de plus) : `--yes` ne suffit pas — l'empreinte
    // ne correspond plus, et la cible reste intacte.
    writeFileSync(backupFile, Buffer.concat([readFileSync(backupFile), Buffer.from([0x00])]));
    const forced = spawnSync('pnpm', ['exec', 'tsx', 'scripts/restore.ts', '--yes'], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
    });
    expect(`${forced.stdout}${forced.stderr}`).toMatch(
      /empreinte incohérente|sauvegarde illisible/,
    );
    expect(forced.status).toBe(1);
    expect(readFileSync(target).equals(before)).toBe(true);
  });
});
