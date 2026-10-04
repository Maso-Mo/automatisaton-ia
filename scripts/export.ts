import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, loadConfig } from '@aia/config';
import {
  appliedMigrationCount,
  listTables,
  openDatabase,
  type DatabaseHandle,
} from '@aia/database';

/**
 * Export utilisateur (étape 12 §34).
 *
 * Objectif : pouvoir **sortir ses données** sans dépendre du produit — projets,
 * contenus, calendrier, analytics, veille, et la configuration non secrète. Ce
 * n'est pas un dump SQL complet : c'est un format lisible (JSON) qu'un humain
 * peut relire dans dix ans.
 *
 * La règle de sécurité est ici, et elle est structurelle : **une colonne dont le
 * nom ressemble à un secret n'est jamais exportée** (`access_token_encrypted`,
 * `client_secret`, `refresh_token`, `api_key`…). Le filtre ne dépend donc pas de
 * la vigilance de qui ajoute une colonne : il l'attrape par défaut.
 *
 * Usage :
 *   pnpm export              # exports/<horodatage>/export.json
 *   pnpm export -- --out=./mon-export.json
 */

/** Tables exportées : les données de l'utilisateur, pas les journaux techniques. */
const EXPORT_TABLES = [
  'projects',
  'project_goals',
  'project_facts',
  'style_profiles',
  'audience_profiles',
  'conversations',
  'messages',
  'conversation_summaries',
  'master_briefs',
  'content_items',
  'content_versions',
  'content_review_notes',
  'publications',
  'calendar_slots',
  'news_sources',
  'news_items',
  'metric_snapshots',
  'performance_patterns',
] as const;

/** Un nom de colonne qui évoque un secret n'est jamais exporté. */
const SENSITIVE_COLUMN = /(token|secret|password|credential|api_key|private)/i;

function columnsOf(handle: DatabaseHandle, table: string): string[] {
  const rows = handle.sqlite.prepare(`pragma table_info(${JSON.stringify(table)})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function exportTable(handle: DatabaseHandle, table: string): Record<string, unknown>[] {
  const rows = handle.sqlite.prepare(`select * from ${JSON.stringify(table)}`).all() as Array<
    Record<string, unknown>
  >;
  const sensitive = columnsOf(handle, table).filter((name) => SENSITIVE_COLUMN.test(name));
  if (sensitive.length === 0) return rows;
  return rows.map((row) => {
    const copy = { ...row };
    for (const column of sensitive) delete copy[column];
    return copy;
  });
}

function parseArgs(argv: readonly string[]): { out: string | null } {
  const found = argv.find((arg) => arg.startsWith('--out='));
  return { out: found ? found.slice('--out='.length) : null };
}

function timestampLabel(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }

  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });

  const present = new Set(listTables(handle));
  const tables: Record<string, Record<string, unknown>[]> = {};
  const exported: string[] = [];
  const skipped: string[] = [];
  try {
    for (const table of EXPORT_TABLES) {
      if (!present.has(table)) {
        skipped.push(table);
        continue;
      }
      tables[table] = exportTable(handle, table);
      exported.push(`${table} (${tables[table].length})`);
    }

    const payload = {
      meta: {
        product: 'automatisation-ia',
        version: '0.1.0',
        exportedAt: new Date().toISOString(),
        migrations: appliedMigrationCount(handle),
        sqliteVersion: (
          handle.sqlite.prepare('select sqlite_version() as v').get() as { v: string }
        ).v,
        note: 'Les colonnes de type jeton/secret sont volontairement exclues de cet export.',
      },
      // Configuration **non secrète** uniquement (aucune clé, aucun jeton).
      config: {
        APP_ENV: config.env.APP_ENV,
        STORAGE_DRIVER: config.env.STORAGE_DRIVER,
        LLM_DEFAULT_PROVIDER: config.env.LLM_DEFAULT_PROVIDER,
        MONTHLY_BUDGET_USD: config.env.MONTHLY_BUDGET_USD,
        DAILY_BUDGET_USD: config.env.DAILY_BUDGET_USD,
        METRICS_COLLECT_INTERVAL_HOURS: config.env.METRICS_COLLECT_INTERVAL_HOURS,
        secretPresence: config.secretPresence,
      },
      tables,
    };

    const target = options.out ?? join('exports', timestampLabel(new Date()), 'export.json');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(payload, null, 2));
    console.log(`✅ export écrit : ${target}`);
    console.log(`   tables : ${exported.join(', ')}`);
    if (skipped.length > 0) console.log(`   ignorées (absentes) : ${skipped.join(', ')}`);
    console.log('   secrets : aucune colonne de type jeton/secret n’est incluse');
  } finally {
    handle.close();
  }
}

main();
