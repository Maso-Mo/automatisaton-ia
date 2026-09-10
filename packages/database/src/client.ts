import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

/**
 * Client SQLite : **le seul endroit du dépôt** qui touche `better-sqlite3` et
 * `drizzle-orm/sqlite-core` (docs/02 §4). Aucun autre paquet n'importe Drizzle
 * directement — c'est ce qui rend la migration vers PostgreSQL mécanique.
 *
 * Trois réglages sont non négociables (docs/03 §17.3) :
 * - **WAL** : un lecteur ne bloque jamais un écrivain ;
 * - **busy_timeout 5 s** : au lieu d'échouer sur `SQLITE_BUSY` ;
 * - **clés étrangères activées** : SQLite les ignore par défaut.
 */

export type DatabaseClient = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  readonly db: DatabaseClient;
  readonly sqlite: Database.Database;
  readonly file: string;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Chemin absolu du fichier, ou `:memory:` pour un test très court. */
  file: string;
  wal?: boolean;
  busyTimeoutMs?: number;
  foreignKeys?: boolean;
}

export function openDatabase(options: OpenDatabaseOptions): DatabaseHandle {
  const sqlite = new Database(options.file);
  const wal = options.wal ?? true;

  if (wal && options.file !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
  if (options.foreignKeys ?? true) {
    sqlite.pragma('foreign_keys = ON');
  }
  // WAL rend les écritures séquentielles : `NORMAL` suffit et reste durable.
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema });

  return {
    db,
    sqlite,
    file: options.file,
    close: () => {
      sqlite.close();
    },
  };
}

export function sqliteVersion(handle: DatabaseHandle): string {
  const row = handle.sqlite.prepare('select sqlite_version() as version').get() as
    { version: string } | undefined;
  return row?.version ?? 'inconnue';
}

export function isWalEnabled(handle: DatabaseHandle): boolean {
  const row = handle.sqlite.prepare('pragma journal_mode').get() as
    { journal_mode: string } | undefined;
  return (row?.journal_mode ?? '').toLowerCase() === 'wal';
}

/** Tables réellement présentes, triées (diagnostic et tests de migration). */
export function listTables(handle: DatabaseHandle): string[] {
  const rows = handle.sqlite
    .prepare(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Requête scalaire utilitaire, pour les dépôts qui agrègent un coût ou un compte. */
export function scalarNumber(handle: DatabaseHandle, query: string): number {
  const row = handle.sqlite.prepare(query).get() as Record<string, unknown> | undefined;
  const first = row ? Object.values(row)[0] : 0;
  return typeof first === 'number' ? first : 0;
}

export { schema, sql };
