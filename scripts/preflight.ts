import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { ConfigError, loadConfig, SECRET_ENV_KEYS, type Config } from '@aia/config';
import {
  appliedMigrationCount,
  MIGRATIONS_FOLDER,
  openDatabase,
  sqliteVersion,
} from '@aia/database';

/**
 * Préflight de démarrage (étape 12 §3).
 *
 * Il répond à une seule question : *puis-je démarrer maintenant, et sinon
 * qu'est-ce qui manque ?* Il ne remplace pas `check-env` (qui décrit), il **gate**
 * `app:start` : ce script sort en erreur si une dépendance **bloquante** manque,
 * et se contente d'avertir pour tout ce qui est optionnel.
 *
 * La règle du produit tient en une phrase et vaut pour chaque ligne ci-dessous :
 * **un service optionnel absent dégrade une fonction, il n'empêche jamais de
 * démarrer** (docs/02 §10). Whisper en est l'exemple type : sans lui, l'interface
 * indique que la transcription locale n'est pas configurée, et le reste marche.
 */

const MIN_NODE_MAJOR = 20;

interface Line {
  icon: string;
  label: string;
  detail: string;
  blocking: boolean;
}

function probeBinary(bin: string, args: string[]): boolean {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  return result.status === 0;
}

function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.once('listening', () => server.close(() => resolvePromise(true)));
    server.listen(port, host);
  });
}

function writeProbe(directory: string): boolean {
  try {
    mkdirSync(directory, { recursive: true });
    const probe = join(directory, `.aia-write-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function expectedMigrationCount(): number {
  try {
    return readdirSync(MIGRATIONS_FOLDER).filter(
      (name) => name.endsWith('.sql') && !name.startsWith('meta'),
    ).length;
  } catch {
    return 0;
  }
}

function checkSecrets(config: Config, lines: Line[]): void {
  for (const key of SECRET_ENV_KEYS) {
    const present = config.secretPresence[key];
    const blocking = key === 'SESSION_SECRET' || key === 'ENCRYPTION_KEY';
    if (!present && !blocking) continue; // les secrets optionnels ne sont pas listés ici
    lines.push({
      icon: present ? '✅' : '❌',
      label: key,
      detail: present ? 'présent' : 'absent — générer avec « openssl rand -hex 32 »',
      blocking: !present && blocking,
    });
  }
}

async function checkDatabase(config: Config, lines: Line[]): Promise<void> {
  if (config.paths.databaseFile === ':memory:') return;
  if (!existsSync(config.paths.databaseFile)) {
    lines.push({
      icon: '⚠️ ',
      label: 'base',
      detail: 'fichier absent → « pnpm setup » ou « pnpm db:migrate » le créeront',
      blocking: false,
    });
    return;
  }
  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });
  const applied = appliedMigrationCount(handle);
  handle.close();
  const expected = expectedMigrationCount();
  const upToDate = applied >= expected;
  lines.push({
    icon: upToDate ? '✅' : '⚠️ ',
    label: 'migrations',
    detail: upToDate
      ? `${applied} appliquée(s)`
      : `${applied}/${expected} — « pnpm db:migrate » mettra à jour`,
    blocking: false,
  });
}

function checkDirectories(config: Config, lines: Line[]): void {
  for (const [label, directory] of [
    ['médias', config.paths.mediaRoot],
    ['données', config.paths.dataDir],
    ['sauvegardes', config.paths.backupDir],
  ] as const) {
    const writable = writeProbe(directory);
    lines.push({
      icon: writable ? '✅' : '❌',
      label: `écriture ${label}`,
      detail: writable ? directory : `non inscriptible : ${directory}`,
      blocking: !writable,
    });
  }
}

async function checkPorts(config: Config, lines: Line[]): Promise<void> {
  if (config.env.APP_ENV === 'test') return;
  for (const [label, port] of [
    ['port API', config.env.APP_PORT],
    ['port web (Vite)', 5173],
  ] as const) {
    const free = await portIsFree('127.0.0.1', port);
    lines.push({
      icon: free ? '✅' : '⚠️ ',
      label,
      detail: free ? `libre (${port})` : `occupé (${port}) — un processus écoute déjà`,
      blocking: false,
    });
  }
}

function checkOptionalTools(config: Config, lines: Line[]): void {
  const whisperBin = config.env.WHISPER_BIN;
  const whisperModel = isAbsolute(config.env.WHISPER_MODEL_PATH)
    ? config.env.WHISPER_MODEL_PATH
    : resolve(config.paths.root, config.env.WHISPER_MODEL_PATH);
  const whisperBinOk = probeBinary(whisperBin, ['--help']) || probeBinary(whisperBin, ['-h']);
  const whisperModelOk = existsSync(whisperModel);
  const whisperReady = whisperBinOk && whisperModelOk;
  lines.push({
    icon: whisperReady ? '✅' : '⚠️ ',
    label: 'whisper',
    detail: whisperReady
      ? `${whisperBin} + modèle`
      : `transcription locale NON configurée (${whisperBinOk ? 'binaire ok' : 'binaire absent'}, ${whisperModelOk ? 'modèle ok' : 'modèle absent'}) → démarre quand même`,
    blocking: false,
  });

  const hasLlmKey = Object.entries(config.secretPresence).some(
    ([key, present]) => key.endsWith('_API_KEY') && present,
  );
  if (!hasLlmKey) {
    lines.push({
      icon: '⚠️ ',
      label: 'clé IA',
      detail: 'aucune clé de fournisseur → génération indisponible, avertissement à l’écran',
      blocking: false,
    });
  }
}

async function main(): Promise<void> {
  const lines: Line[] = [];

  // 1. Node
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');
  lines.push({
    icon: nodeMajor >= MIN_NODE_MAJOR ? '✅' : '❌',
    label: 'node',
    detail: `v${process.versions.node}`,
    blocking: nodeMajor < MIN_NODE_MAJOR,
  });

  // 2. pnpm
  const pnpmOk = probeBinary('pnpm', ['--version']);
  lines.push({
    icon: pnpmOk ? '✅' : '❌',
    label: 'pnpm',
    detail: pnpmOk ? 'disponible' : 'absent — installer pnpm (corepack enable)',
    blocking: !pnpmOk,
  });

  // 3. better-sqlite3 (module natif unique)
  try {
    const probe = openDatabase({ file: ':memory:', wal: false, foreignKeys: false });
    const version = sqliteVersion(probe);
    probe.close();
    lines.push({ icon: '✅', label: 'sqlite', detail: version, blocking: false });
  } catch (error) {
    lines.push({
      icon: '❌',
      label: 'sqlite',
      detail: `module natif indisponible (${(error as Error).message}) — « pnpm rebuild better-sqlite3 »`,
      blocking: true,
    });
  }

  // 4. FFmpeg (optionnel)
  for (const binary of ['ffmpeg', 'ffprobe'] as const) {
    const ok = probeBinary(binary, ['-version']);
    lines.push({
      icon: ok ? '✅' : '⚠️ ',
      label: binary,
      detail: ok ? 'disponible' : 'absent → pipeline vidéo indisponible (étapes 6 et 7)',
      blocking: false,
    });
  }

  // 5. Configuration
  let config: Config | null = null;
  try {
    config = loadConfig();
    lines.push({
      icon: '✅',
      label: 'configuration',
      detail: `${config.env.APP_ENV} · écoute ${config.env.APP_HOST}:${config.env.APP_PORT}`,
      blocking: false,
    });
  } catch (error) {
    lines.push({
      icon: '❌',
      label: 'configuration',
      detail: error instanceof ConfigError ? (error.message.split('\n')[0] ?? '') : String(error),
      blocking: true,
    });
  }

  if (config) {
    checkSecrets(config, lines);
    await checkDatabase(config, lines);
    checkDirectories(config, lines);
    await checkPorts(config, lines);
    checkOptionalTools(config, lines);
  }

  const blocking = lines.filter((line) => line.blocking);
  console.log('\nPréflight de démarrage\n');
  for (const line of lines) {
    console.log(`${line.icon} ${line.label.padEnd(18)} ${line.detail}`);
  }

  if (blocking.length > 0) {
    console.error(
      `\n❌ ${blocking.length} dépendance(s) bloquante(s) : corriger avant de démarrer.`,
    );
    process.exit(1);
  }
  console.log('\n✅ Aucune dépendance bloquante : « pnpm app:start » peut démarrer.');
}

void main();
