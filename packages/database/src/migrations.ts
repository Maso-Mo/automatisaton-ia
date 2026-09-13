import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { DatabaseHandle } from './client';

/**
 * Migrations : Drizzle Kit, SQL versionné dans `packages/database/migrations/`
 * (docs/03 §16.3). Sens unique, toujours en avant.
 *
 * « Une migration ne doit jamais dépendre du déploiement du code suivant » :
 * la base se crée donc depuis zéro avec la seule commande `pnpm db:migrate`.
 */

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export interface MigrationReport {
  applied: number;
  total: number;
}

/** Applique les migrations non appliquées. Idempotent. */
export function applyMigrations(
  handle: DatabaseHandle,
  /** Dossier de migrations alternatif : sert au test de migration ascendante. */
  options: { migrationsFolder?: string } = {},
): MigrationReport {
  const before = appliedMigrationCount(handle);
  migrate(handle.db, { migrationsFolder: options.migrationsFolder ?? MIGRATIONS_FOLDER });
  const after = appliedMigrationCount(handle);
  return { applied: after - before, total: after };
}

/** Nombre de migrations enregistrées comme appliquées par Drizzle. */
export function appliedMigrationCount(handle: DatabaseHandle): number {
  const table = handle.sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!table) return 0;
  const row = handle.sqlite.prepare('select count(*) as count from __drizzle_migrations').get() as
    { count: number } | undefined;
  return row?.count ?? 0;
}

/** Horodatage de la dernière migration appliquée (ms epoch), s'il existe. */
export function lastMigrationAt(handle: DatabaseHandle): number | null {
  const table = handle.sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!table) return null;
  const row = handle.sqlite
    .prepare(
      'select created_at as createdAt from __drizzle_migrations order by created_at desc limit 1',
    )
    .get() as { createdAt: number | string } | undefined;
  if (!row) return null;
  return typeof row.createdAt === 'number' ? row.createdAt : Number(row.createdAt);
}

/**
 * Tables **manquantes** parmi celles attendues, dans l'ordre de la liste.
 *
 * Préféré à `isMigrated` partout où le message d'erreur compte : refuser de
 * démarrer en nommant `conversations` est actionnable, « schéma incomplet » ne
 * l'est pas.
 */
export function missingTables(
  handle: DatabaseHandle,
  expectedTables: readonly string[],
): readonly string[] {
  const present = new Set(
    (
      handle.sqlite.prepare("select name from sqlite_master where type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name),
  );
  return expectedTables.filter((table) => !present.has(table));
}

/** Vrai si le schéma attendu est en place (l'API refuse de servir sinon). */
export function isMigrated(handle: DatabaseHandle, expectedTables: readonly string[]): boolean {
  return missingTables(handle, expectedTables).length === 0;
}
