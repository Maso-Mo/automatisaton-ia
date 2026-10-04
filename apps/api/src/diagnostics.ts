import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statfsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Config } from '@aia/config';

/**
 * Diagnostics d'exploitation (étape 12 §14).
 *
 * L'écran « Système » répond à des questions qu'un exploitant se pose vraiment :
 * *reste-t-il de la place ? quand a-t-on sauvegardé pour la dernière fois ?
 * quels services sont configurés ?* — **jamais** la valeur d'un secret, seulement
 * sa présence (docs/07 §4.3).
 *
 * Rien ici n'est indispensable au domaine : c'est de l'observation, isolée dans
 * un module sans dépendance, pour que l'API reste le seul endroit qui lit le
 * disque.
 */

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
}

export interface BackupSummary {
  label: string;
  createdAt: number;
  sizeBytes: number;
  migrations: number;
  checksum: string;
}

export interface ServiceStatus {
  id: string;
  label: string;
  configured: boolean;
  detail: string;
  optional: boolean;
}

export interface Diagnostics {
  generatedAt: number;
  disk: DiskUsage[];
  lastBackup: BackupSummary | null;
  backupCount: number;
  failedJobs: number;
  services: ServiceStatus[];
}

function diskUsage(path: string): DiskUsage | null {
  try {
    const stats = statfsSync(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bavail * stats.bsize;
    return {
      path,
      totalBytes,
      freeBytes,
      usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0,
    };
  } catch {
    return null;
  }
}

function binaryPresent(bin: string, args: string[]): boolean {
  const result = spawnSync(bin, args, { encoding: 'utf8' });
  return result.status === 0;
}

/** Dernière sauvegarde de base, par ordre alphabétique d'horodatage. */
export function readLatestBackup(backupRoot: string): {
  latest: BackupSummary | null;
  count: number;
} {
  const dbRoot = join(backupRoot, 'db');
  if (!existsSync(dbRoot)) return { latest: null, count: 0 };
  const labels = readdirSync(dbRoot)
    .filter((name) => existsSync(join(dbRoot, name, 'metadata.json')))
    .sort();
  const count = labels.length;
  const last = labels.at(-1);
  if (!last) return { latest: null, count };
  try {
    const metadata = JSON.parse(readFileSync(join(dbRoot, last, 'metadata.json'), 'utf8')) as {
      createdAt?: number;
      sizeBytes?: number;
      migrations?: number;
      checksum?: string;
    };
    return {
      latest: {
        label: last,
        createdAt: metadata.createdAt ?? 0,
        sizeBytes: metadata.sizeBytes ?? 0,
        migrations: metadata.migrations ?? 0,
        checksum: (metadata.checksum ?? '').slice(0, 12),
      },
      count,
    };
  } catch {
    return { latest: null, count };
  }
}

export function computeDiagnostics(options: {
  config: Config;
  failedJobs: number;
  nowMs: number;
}): Diagnostics {
  const { config } = options;
  const disk = [
    diskUsage(config.paths.root),
    diskUsage(config.paths.mediaRoot),
    diskUsage(config.paths.backupDir),
  ].filter((value): value is DiskUsage => value !== null);

  const backup = readLatestBackup(config.paths.backupDir);

  const whisperModel = isAbsolute(config.env.WHISPER_MODEL_PATH)
    ? config.env.WHISPER_MODEL_PATH
    : resolve(config.paths.root, config.env.WHISPER_MODEL_PATH);
  const whisper =
    binaryPresent(config.env.WHISPER_BIN, ['--help']) ||
    binaryPresent(config.env.WHISPER_BIN, ['-h']);

  const services: ServiceStatus[] = [
    {
      id: 'ffmpeg',
      label: 'FFmpeg / ffprobe',
      configured:
        binaryPresent(config.env.FFMPEG_BIN, ['-version']) &&
        binaryPresent(config.env.FFPROBE_BIN, ['-version']),
      detail: 'pipeline vidéo (étapes 6 et 7)',
      optional: true,
    },
    {
      id: 'whisper',
      label: 'Whisper (transcription locale)',
      configured: whisper && existsSync(whisperModel),
      detail: `binaire ${config.env.WHISPER_BIN} + modèle ${config.env.WHISPER_MODEL_PATH}`,
      optional: true,
    },
    {
      id: 'llm',
      label: 'Fournisseur IA',
      configured: config.secretPresence.DEEPSEEK_API_KEY,
      detail: `fournisseur par défaut : ${config.env.LLM_DEFAULT_PROVIDER}`,
      optional: true,
    },
    {
      id: 'linkedin',
      label: 'LinkedIn',
      configured: config.secretPresence.LINKEDIN_CLIENT_SECRET,
      detail: 'publication par API — sinon paquet manuel (niveau C)',
      optional: true,
    },
    {
      id: 'reddit',
      label: 'Reddit',
      configured: config.secretPresence.REDDIT_CLIENT_SECRET,
      detail: 'publication par API — sinon paquet manuel (niveau C)',
      optional: true,
    },
    {
      id: 'tiktok',
      label: 'TikTok',
      configured: config.secretPresence.TIKTOK_CLIENT_SECRET,
      detail: 'publication par API — sinon paquet manuel (niveau C)',
      optional: true,
    },
    {
      id: 'auth',
      label: 'Protection d’accès (AUTH_TOKEN)',
      configured: config.secretPresence.AUTH_TOKEN,
      detail: config.secretPresence.AUTH_TOKEN
        ? 'active : en-tête requis hors /health et /ready'
        : 'inactive : accès local non protégé (défaut sûr en localhost)',
      optional: true,
    },
  ];

  return {
    generatedAt: options.nowMs,
    disk,
    lastBackup: backup.latest,
    backupCount: backup.count,
    failedJobs: options.failedJobs,
    services,
  };
}
