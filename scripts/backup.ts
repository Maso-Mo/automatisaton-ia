import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigError, ensureLocalDirectories, loadConfig } from '@aia/config';
import { backupDatabase, openDatabase } from '@aia/database';
import { buildStorageManifest } from '@aia/media';

/**
 * Sauvegarde locale (étape 12 §7–§8, décision D5).
 *
 * **Base et médias sont sauvegardés séparément.** Ce n'est pas une préférence
 * esthétique : ils changent à des rythmes différents (la base à chaque action, les
 * médias rarement), ils pèsent des ordres de grandeur différents, et une
 * sauvegarde de base doit rester **fréquente et petite**. Chacun a donc son
 * dossier, partageant un même horodatage pour la corrélation.
 *
 * ```text
 * backups/
 *   db/<horodatage>/app.db           # snapshot cohérent (VACUUM INTO)
 *   db/<horodatage>/metadata.json    # taille, empreinte, version de schéma
 *   media/<horodatage>/manifest.json # chaque fichier + empreinte
 *   media/<horodatage>/files/…       # copie réelle (avec --media)
 * ```
 *
 * Usage :
 *   pnpm backup            # base + manifeste des médias
 *   pnpm backup --media    # copie aussi les fichiers médias
 */

interface Options {
  withMedia: boolean;
  dir: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const dirArg = argv.find((arg) => arg.startsWith('--dir='));
  return {
    withMedia: argv.includes('--media'),
    dir: dirArg ? dirArg.slice('--dir='.length) : null,
  };
}

function timestampLabel(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }

  ensureLocalDirectories(config);
  const root = options.dir ?? config.paths.backupDir;
  const label = timestampLabel(new Date());
  const dbDir = join(root, 'db', label);
  const mediaDir = join(root, 'media', label);
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });

  // --- Base : snapshot cohérent, jamais une copie de fichier vivant.
  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });
  let dbResult;
  try {
    dbResult = await backupDatabase(handle, { targetFile: join(dbDir, 'app.db') });
  } finally {
    handle.close();
  }
  writeFileSync(
    join(dbDir, 'metadata.json'),
    JSON.stringify(
      {
        kind: 'db',
        createdAt: dbResult.createdAt,
        label,
        source: config.paths.databaseFile,
        file: 'app.db',
        sizeBytes: dbResult.sizeBytes,
        checksum: dbResult.checksum,
        migrations: dbResult.migrations,
        lastMigrationAt: dbResult.lastMigrationAt,
        sqliteVersion: dbResult.sqliteVersion,
        appEnv: config.env.APP_ENV,
      },
      null,
      2,
    ),
  );
  console.log(
    `✅ base sauvegardée : ${join(dbDir, 'app.db')} (${kb(dbResult.sizeBytes)}, ${dbResult.migrations} migration(s), sha256 ${dbResult.checksum.slice(0, 12)}…)`,
  );

  // --- Médias : manifeste (et, sur demande, la copie des fichiers).
  const manifest = await buildStorageManifest(config.paths.mediaRoot);
  writeFileSync(
    join(mediaDir, 'manifest.json'),
    JSON.stringify({ ...manifest, label, copied: options.withMedia }, null, 2),
  );
  console.log(
    `✅ manifeste médias : ${manifest.fileCount} fichier(s), ${kb(manifest.totalBytes)} — ${join(mediaDir, 'manifest.json')}`,
  );

  if (options.withMedia && existsSync(config.paths.mediaRoot)) {
    const destination = join(mediaDir, 'files');
    mkdirSync(destination, { recursive: true });
    for (const entry of manifest.entries) {
      const source = join(config.paths.mediaRoot, entry.key);
      const target = join(destination, entry.key);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target);
    }
    console.log(`✅ médias copiés : ${manifest.fileCount} fichier(s) → ${destination}`);
  } else if (options.withMedia) {
    console.log('ℹ️  dossier médias vide : rien à copier');
  } else {
    console.log(
      'ℹ️  fichiers médias non copiés (relancer avec --media pour une sauvegarde complète)',
    );
  }
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} Ko`;
}

await main();
