import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ConfigError, loadConfig } from '@aia/config';
import {
  appliedMigrationCount,
  applyMigrations,
  backupDatabase,
  inspectDatabaseFile,
  openDatabase,
} from '@aia/database';
import { verifyStorageManifest, type StorageManifest } from '@aia/media';

/**
 * Restauration (étape 12 §9).
 *
 * Trois règles, dans cet ordre :
 *
 * 1. **Rien n'est écrasé sans preuve.** La sauvegarde est d'abord validée :
 *    `integrity_check`, présence du fichier, et **empreinte SHA-256** identique à
 *    celle du manifeste. Une sauvegarde non vérifiée n'est pas une sauvegarde.
 * 2. **L'état courant est conservé avant d'être remplacé.** Sauf `--no-safety`,
 *    la base actuelle est elle-même sauvegardée juste avant : une restauration
 *    n'est jamais un aller sans retour.
 * 3. **La restauration destructive exige `--yes`.** Sans lui, le script se
 *    contente de décrire ce qu'il ferait et ne touche à rien.
 *
 * Usage :
 *   pnpm restore                      # dernière sauvegarde, prévisualisation
 *   pnpm restore -- --label=20260101-090000 --yes
 *   pnpm restore -- --media --yes     # restaure aussi les médias
 */

interface Options {
  label: string | null;
  yes: boolean;
  withMedia: boolean;
  noSafety: boolean;
  dir: string | null;
}

function parseArgs(argv: readonly string[]): Options {
  const value = (prefix: string): string | null => {
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  return {
    label: value('--label='),
    yes: argv.includes('--yes'),
    withMedia: argv.includes('--media'),
    noSafety: argv.includes('--no-safety'),
    dir: value('--dir='),
  };
}

/** Dernière sauvegarde de base, par ordre alphabétique d'horodatage (déjà triable). */
function findLatestBackup(root: string, label: string | null): string | null {
  const dbRoot = join(root, 'db');
  if (!existsSync(dbRoot)) return null;
  if (label) {
    const explicit = join(dbRoot, label);
    return existsSync(explicit) ? explicit : null;
  }
  const labels = readdirSync(dbRoot)
    .filter((name) => existsSync(join(dbRoot, name, 'app.db')))
    .sort();
  const latest = labels.at(-1);
  return latest ? join(dbRoot, latest) : null;
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

  const root = options.dir ?? config.paths.backupDir;
  const backupDir = findLatestBackup(root, options.label);
  if (!backupDir) {
    console.error(`❌ aucune sauvegarde trouvée dans ${join(root, 'db')}`);
    process.exit(1);
  }

  const label = basename(backupDir);
  const metadata = JSON.parse(readFileSync(join(backupDir, 'metadata.json'), 'utf8')) as {
    checksum: string;
    migrations: number;
  };
  const backupFile = join(backupDir, 'app.db');

  console.log(`\nRestauration depuis ${backupDir}\n`);

  // 1. Validation stricte.
  let inspection;
  try {
    inspection = await inspectDatabaseFile(backupFile);
  } catch (error) {
    // Une sauvegarde illisible (tronquée, corrompue) n'est pas une sauvegarde :
    // on le dit en une ligne, et on ne touche à rien.
    console.error(`❌ sauvegarde illisible : ${(error as Error).message}`);
    process.exit(1);
  }
  if (inspection.integrity !== 'ok') {
    console.error(`❌ integrity_check = ${inspection.integrity}`);
    process.exit(1);
  }
  if (inspection.checksum !== metadata.checksum) {
    console.error(
      `❌ empreinte incohérente : attendu ${metadata.checksum.slice(0, 12)}…, obtenu ${inspection.checksum.slice(0, 12)}…`,
    );
    process.exit(1);
  }
  console.log(
    `✅ sauvegarde valide — intégrité ok, sha256 ${inspection.checksum.slice(0, 12)}…, ${inspection.migrations} migration(s)`,
  );

  const mediaBackupDir = join(root, 'media', label);
  const manifestPath = join(mediaBackupDir, 'manifest.json');
  const hasMedia = options.withMedia && existsSync(manifestPath);

  if (!options.yes) {
    console.log('\nPrévisualisation (aucune modification) :');
    console.log(`  • base     : ${backupFile}`);
    console.log(`             → ${config.paths.databaseFile}`);
    if (options.withMedia) {
      console.log(
        hasMedia
          ? `  • médias   : ${join(mediaBackupDir, 'files')} → ${config.paths.mediaRoot}`
          : '  • médias   : manifeste absent, médias non restaurés',
      );
    }
    console.log(
      options.noSafety
        ? '  • sécurité : DÉSACTIVÉE (--no-safety)'
        : '  • sécurité : la base actuelle sera sauvegardée avant remplacement',
    );
    console.log('\nRelancer avec --yes pour appliquer.');
    return;
  }

  // 2. Sauvegarde de sécurité de l'état courant.
  if (!options.noSafety && existsSync(config.paths.databaseFile)) {
    const safetyDir = join(root, 'db', `pre-restore-${Date.now()}`);
    mkdirSync(safetyDir, { recursive: true });
    const handle = openDatabase({ file: config.paths.databaseFile, wal: config.env.DB_WAL });
    try {
      const safety = await backupDatabase(handle, { targetFile: join(safetyDir, 'app.db') });
      console.log(
        `✅ état courant conservé : ${safetyDir} (sha256 ${safety.checksum.slice(0, 12)}…)`,
      );
    } finally {
      handle.close();
    }
  }

  // 3. Remplacement de la base (aucun handle ne doit être ouvert sur la cible).
  mkdirSync(dirname(config.paths.databaseFile), { recursive: true });
  cpSync(backupFile, config.paths.databaseFile);
  // Les fichiers WAL/SHM de l'ancienne base ne doivent pas survivre au remplacement.
  rmSync(`${config.paths.databaseFile}-wal`, { force: true });
  rmSync(`${config.paths.databaseFile}-shm`, { force: true });
  console.log(`✅ base restaurée → ${config.paths.databaseFile}`);

  // 4. Vérification du schéma : on remonte les migrations jusqu'à la version courante.
  const handle = openDatabase({ file: config.paths.databaseFile, wal: config.env.DB_WAL });
  try {
    const before = appliedMigrationCount(handle);
    const report = applyMigrations(handle);
    const total = appliedMigrationCount(handle);
    console.log(
      report.applied > 0
        ? `✅ schéma mis à jour : ${report.applied} migration(s) appliquée(s) (${total} au total, ${before} avant)`
        : `✅ schéma déjà à jour (${total} migration(s))`,
    );
  } finally {
    handle.close();
  }

  // 5. Médias, si demandés.
  if (options.withMedia) {
    if (!hasMedia) {
      console.log('ℹ️  médias non restaurés (manifeste absent)');
    } else {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as StorageManifest & {
        copied: boolean;
      };
      const filesDir = join(mediaBackupDir, 'files');
      if (manifest.copied && existsSync(filesDir)) {
        mkdirSync(config.paths.mediaRoot, { recursive: true });
        cpSync(filesDir, config.paths.mediaRoot, { recursive: true });
        const verification = await verifyStorageManifest(config.paths.mediaRoot, manifest);
        console.log(
          verification.ok
            ? `✅ médias restaurés et vérifiés (${verification.verified} fichier(s))`
            : `⚠️  médias restaurés mais ${verification.missing.length + verification.mismatched.length} écart(s)`,
        );
      } else {
        console.log('ℹ️  manifeste sans fichiers copiés : relancer la sauvegarde avec --media');
      }
    }
  }

  console.log('\n✅ Restauration terminée. Redémarrer avec « pnpm app:start ».');
}

await main();
