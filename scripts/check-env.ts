import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig, ConfigError, SECRET_ENV_KEYS } from '@aia/config';
import { appliedMigrationCount, openDatabase } from '@aia/database';
import { discoverPromptFiles } from '@aia/ai';

/**
 * Vérification d'environnement (docs/02 §10). Deux catégories, et la distinction
 * est la règle du produit :
 *
 * - **bloquant** : Node, SQLite, configuration valide → le processus s'arrête, avec
 *   la commande à exécuter ;
 * - **déjà dégradé** : FFmpeg, whisper, clés IA absentes → la fonctionnalité
 *   correspondante est indisponible, le reste marche.
 *
 * « Refuser de démarrer pour une dépendance optionnelle est la meilleure façon de
 * faire abandonner un produit personnel » (docs/02 §10).
 */

const MIN_NODE_MAJOR = 20;

interface Line {
  icon: string;
  label: string;
  detail: string;
  blocking: boolean;
}

async function main(): Promise<void> {
  const lines: Line[] = [];
  const nodeMajor = Number(process.versions.node.split('.')[0] ?? '0');

  lines.push({
    icon: nodeMajor >= MIN_NODE_MAJOR ? '✅' : '❌',
    label: 'node',
    detail: `v${process.versions.node}`,
    blocking: nodeMajor < MIN_NODE_MAJOR,
  });

  // better-sqlite3 : module natif unique du produit.
  try {
    const probe = openDatabase({ file: ':memory:', wal: false, foreignKeys: false });
    const version = probe.sqlite.prepare('select sqlite_version() as v').get() as { v: string };
    probe.close();
    lines.push({ icon: '✅', label: 'sqlite', detail: version.v, blocking: false });
  } catch (error) {
    lines.push({
      icon: '❌',
      label: 'sqlite',
      detail: `module natif indisponible (${(error as Error).message}) → lancer « pnpm rebuild better-sqlite3 »`,
      blocking: true,
    });
  }

  for (const binary of ['ffmpeg', 'ffprobe'] as const) {
    const version = spawnSync(binary, ['-version'], { encoding: 'utf8' });
    const ok = version.status === 0;
    lines.push({
      icon: ok ? '✅' : '⚠️ ',
      label: binary,
      detail: ok
        ? (version.stdout.split('\n')[0] ?? '').slice(0, 60)
        : 'absent → pipeline vidéo indisponible (étapes 6 et 7)',
      blocking: false,
    });
  }

  let config: ReturnType<typeof loadConfig> | null = null;
  try {
    config = loadConfig();
    lines.push({
      icon: '✅',
      label: 'configuration',
      detail: `${config.env.APP_ENV} · écoute ${config.env.APP_HOST}:${config.env.APP_PORT}`,
      blocking: false,
    });
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    lines.push({ icon: '❌', label: 'configuration', detail: message, blocking: true });
  }

  if (config) {
    for (const key of SECRET_ENV_KEYS) {
      const present = config.secretPresence[key];
      const blocking = key === 'SESSION_SECRET' || key === 'ENCRYPTION_KEY';
      lines.push({
        icon: present ? '✅' : blocking ? '❌' : '⚠️ ',
        label: key,
        detail: present ? 'présent' : 'absent',
        blocking: !present && blocking,
      });
    }

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

    const whisperBin = spawnSync(config.env.WHISPER_BIN, ['--help'], { encoding: 'utf8' });
    const whisperOk = whisperBin.status === 0;
    lines.push({
      icon: whisperOk ? '✅' : '⚠️ ',
      label: 'whisper',
      detail: whisperOk
        ? config.env.WHISPER_BIN
        : `${config.env.WHISPER_BIN} absent → transcription désactivée (étape 3)`,
      blocking: false,
    });

    const prompts = discoverPromptFiles(config.paths.promptsDir);
    lines.push({
      icon: prompts.length > 0 ? '✅' : '⚠️ ',
      label: 'prompts',
      detail: `${prompts.length} fichier(s) dans ${config.paths.promptsDir}`,
      blocking: false,
    });

    if (config.paths.databaseFile !== ':memory:') {
      const exists = existsSync(config.paths.databaseFile);
      if (exists) {
        const handle = openDatabase({ file: config.paths.databaseFile, wal: config.env.DB_WAL });
        const migrations = appliedMigrationCount(handle);
        handle.close();
        lines.push({
          icon: migrations > 0 ? '✅' : '⚠️ ',
          label: 'base',
          detail: `${migrations} migration(s) appliquée(s) — ${config.paths.databaseFile}`,
          blocking: false,
        });
      } else {
        lines.push({
          icon: '⚠️ ',
          label: 'base',
          detail: `fichier absent → « pnpm db:migrate » le créera (${config.paths.databaseFile})`,
          blocking: false,
        });
      }
    }
  }

  console.log('Vérification de l’environnement — étape 1\n');
  for (const line of lines) {
    console.log(`${line.icon} ${line.label.padEnd(16)} ${line.detail}`);
  }

  const blocking = lines.filter((line) => line.blocking);
  if (blocking.length > 0) {
    console.error(`\n${blocking.length} dépendance(s) bloquante(s) : corriger avant de démarrer.`);
    process.exit(1);
  }
  console.log('\nAucune dépendance bloquante manquante.');
}

void main();
