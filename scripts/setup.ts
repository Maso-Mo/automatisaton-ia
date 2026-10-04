import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ConfigError, ensureLocalDirectories, findWorkspaceRoot, loadConfig } from '@aia/config';
import { appliedMigrationCount, applyMigrations, openDatabase } from '@aia/database';

/**
 * Installation sur une machine neuve (étape 12 §4).
 *
 * Séquence visée : `pnpm install` → `cp .env.example .env` → `pnpm setup` →
 * `pnpm app:start`. `setup` fait les trois choses qu'un humain ferait à la main,
 * et **rien de plus** :
 *
 * 1. créer les dossiers (données, médias, sauvegardes) ;
 * 2. appliquer les migrations (base créée depuis zéro) ;
 * 3. vérifier les permissions d'écriture et signaler les dépendances optionnelles.
 *
 * Ce qu'il ne fait **pas**, volontairement : inventer des secrets de fournisseur.
 * Les deux seules clés générées sont les clés cryptographiques locales
 * (`SESSION_SECRET`, `ENCRYPTION_KEY`) — des valeurs aléatoires de la machine, sans
 * aucun lien avec un compte. Un `.env` déjà présent n'est **jamais** écrasé : une
 * clé de fournisseur effacée par mégarde ne se récupère pas.
 */

function generatedKey(): string {
  return randomBytes(32).toString('hex');
}

function ensureEnvFile(root: string): { created: boolean; path: string } {
  const path = join(root, '.env');
  if (existsSync(path)) return { created: false, path };

  const examplePath = join(root, '.env.example');
  const content = readFileSync(examplePath, 'utf8')
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${generatedKey()}`)
    .replace(/^ENCRYPTION_KEY=.*$/m, `ENCRYPTION_KEY=${generatedKey()}`);
  // `0o600` : le fichier contient des secrets, il n'a rien à faire lisible par tous.
  writeFileSync(path, content, { mode: 0o600 });
  return { created: true, path };
}

function writeProbe(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true });
    const probe = join(directory, `.aia-setup-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function main(): void {
  const root = findWorkspaceRoot();
  console.log(`\nInstallation — racine ${root}\n`);

  const env = ensureEnvFile(root);
  console.log(
    env.created
      ? `✅ .env créé depuis .env.example (clés cryptographiques générées localement, permissions 600)`
      : `ℹ️  .env déjà présent : conservé tel quel (aucune clé écrasée)`,
  );

  let config;
  try {
    config = loadConfig({ rootDir: root });
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    console.error(
      '\nLe fichier .env existe mais est incomplet. Compléter SESSION_SECRET et ENCRYPTION_KEY :\n  openssl rand -hex 32',
    );
    process.exit(1);
  }

  ensureLocalDirectories(config);
  mkdirSync(config.paths.backupDir, { recursive: true });
  console.log('✅ dossiers créés (données, médias, sauvegardes)');

  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });
  const report = applyMigrations(handle);
  const total = appliedMigrationCount(handle);
  handle.close();
  console.log(
    `✅ base ${config.paths.databaseFile} — ${report.applied} migration(s) appliquée(s), ${total} au total`,
  );

  for (const [label, directory] of [
    ['médias', config.paths.mediaRoot],
    ['données', config.paths.dataDir],
    ['sauvegardes', config.paths.backupDir],
  ] as const) {
    const writable = writeProbe(directory);
    console.log(`${writable ? '✅' : '❌'} écriture ${label} (${directory})`);
    if (!writable) process.exitCode = 1;
  }

  // Dépendances optionnelles : on les **signale**, on ne bloque pas (docs/02 §10).
  const optional = [
    ['ffmpeg', 'pipeline vidéo (étapes 6 et 7)'],
    ['whisper-cli', 'transcription locale (étape 3)'],
  ] as const;
  for (const [binary, usage] of optional) {
    const ok = spawnSync(binary, ['-version'], { encoding: 'utf8' }).status === 0;
    if (!ok) console.log(`⚠️  ${binary} absent → ${usage} indisponible (non bloquant)`);
  }

  for (const key of ['DEEPSEEK_API_KEY', 'LINKEDIN_CLIENT_SECRET'] as const) {
    if (!config.secretPresence[key]) {
      console.log(`⚠️  ${key} absent → fonctionnalité correspondante « non configurée »`);
    }
  }

  console.log('\n✅ Installation terminée. Lancer « pnpm app:start ».');
}

main();
