import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { DatabaseHandle } from './client';

/**
 * Sauvegarde cohérente d'une base SQLite **vivante** (étape 12 §7–§8).
 *
 * Le point qui compte est écrit ici, une fois : **on ne copie pas naïvement un
 * fichier SQLite actif**. En mode WAL, une copie `cp` peut être déchirée — une
 * transaction validée au moment de la copie peut manquer, ou pire, la copie peut
 * référencer une page non encore écrité. La seule méthode sûre côté SQLite est
 * `VACUUM INTO` : il produit un fichier **cohérent** (transactionally consistent)
 * sans verrouiller durablement la base, et rend une base compactée.
 *
 * On aurait pu écrire un `page_count`/`journal` maison ; `VACUUM INTO` est la
 * méthode officielle, documentée, et vérifiable par `PRAGMA integrity_check`.
 */

export interface DatabaseBackupOptions {
  /** Fichier cible de la sauvegarde. **Doit ne pas exister** (SQLite le refuse). */
  targetFile: string;
}

export interface DatabaseBackupResult {
  file: string;
  sizeBytes: number;
  /** Empreinte SHA-256 du fichier produit, base de la vérification au restore. */
  checksum: string;
  /** Nombre de migrations appliquées dans la copie. */
  migrations: number;
  lastMigrationAt: number | null;
  sqliteVersion: string;
  createdAt: number;
}

/** Empreinte SHA-256 d'un fichier, **en flux** (une base peut peser des Go). */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolvePromise());
  });
  return hash.digest('hex');
}

function integrityOf(sqlite: Database.Database): string {
  const rows = sqlite.prepare('pragma integrity_check').all() as Array<Record<string, unknown>>;
  return rows.map((row) => String(Object.values(row)[0])).join('; ');
}

function migrationInfo(sqlite: Database.Database): {
  migrations: number;
  lastMigrationAt: number | null;
} {
  const table = sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!table) return { migrations: 0, lastMigrationAt: null };
  const count = sqlite.prepare('select count(*) as count from __drizzle_migrations').get() as {
    count: number;
  };
  const last = sqlite
    .prepare(
      'select created_at as createdAt from __drizzle_migrations order by created_at desc limit 1',
    )
    .get() as { createdAt: number | string } | undefined;
  return {
    migrations: count.count,
    lastMigrationAt: last ? Number(last.createdAt) : null,
  };
}

/**
 * Produit une sauvegarde cohérente de la base ouverte.
 *
 * Le fichier cible est supprimé s'il existe déjà : relancer `pnpm backup` sur le
 * même horodatage doit être idempotent, pas échouer sur un `VACUUM INTO` refusé.
 */
export async function backupDatabase(
  handle: DatabaseHandle,
  options: DatabaseBackupOptions,
): Promise<DatabaseBackupResult> {
  const target = options.targetFile;
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    // SQLite refuse d'écrire dans un fichier existant : on le remplace.
    const { rmSync } = await import('node:fs');
    rmSync(target, { force: true });
  }

  // `VACUUM INTO` accepte une valeur liée : le chemin n'est jamais concaténé.
  handle.sqlite.prepare('vacuum into ?').run(target);

  const probe = new Database(target, { readonly: true });
  try {
    const integrity = integrityOf(probe);
    if (integrity !== 'ok') {
      throw new Error(`sauvegarde incohérente (integrity_check = ${integrity})`);
    }
    const info = migrationInfo(probe);
    const version = probe.prepare('select sqlite_version() as v').get() as { v: string };
    return {
      file: target,
      sizeBytes: statSync(target).size,
      checksum: await sha256OfFile(target),
      migrations: info.migrations,
      lastMigrationAt: info.lastMigrationAt,
      sqliteVersion: version.v,
      createdAt: Date.now(),
    };
  } finally {
    probe.close();
  }
}

export interface DatabaseFileInspection {
  file: string;
  integrity: string;
  sizeBytes: number;
  checksum: string;
  migrations: number;
  sqliteVersion: string;
}

/** Inspecte un fichier de base **sans** le modifier (validation d'une sauvegarde). */
export async function inspectDatabaseFile(file: string): Promise<DatabaseFileInspection> {
  if (!existsSync(file)) {
    throw new Error(`fichier introuvable : ${file}`);
  }
  const probe = new Database(file, { readonly: true });
  try {
    const version = probe.prepare('select sqlite_version() as v').get() as { v: string };
    return {
      file,
      integrity: integrityOf(probe),
      sizeBytes: statSync(file).size,
      checksum: await sha256OfFile(file),
      migrations: migrationInfo(probe).migrations,
      sqliteVersion: version.v,
    };
  } finally {
    probe.close();
  }
}
