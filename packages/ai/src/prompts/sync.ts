import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DatabaseHandle } from '@aia/database';
import {
  activePromptVersion,
  deactivateOtherVersions,
  findByHash,
  insertPromptVersion,
  promptSummary,
} from '@aia/database';
import { ValidationError, uuidv7, type Clock } from '@aia/shared';
import type { AppLogger } from '@aia/observability';

/**
 * Prompts : des **fichiers du dépôt**, synchronisés en base au démarrage
 * (docs/02 §5, docs/03 §14.4). Deux propriétés en découlent :
 *
 * - versionnés par git, relus en diff, modifiables sans migration ;
 * - un `llm_call` référence le **hash exact** du prompt utilisé.
 *
 * « Synchronisation au démarrage, jamais en cours de job » : un prompt modifié ne
 * doit pas s'appliquer à mi-parcours d'une génération.
 */

export interface PromptDefinition {
  agent: string;
  task: string;
  versionLabel: string | null;
  notes: string | null;
  body: string;
  /** Chemin relatif en POSIX, tel qu'il est stocké dans `prompt_versions.file_path`. */
  filePath: string;
  contentHash: string;
}

export interface PromptSyncReport {
  scanned: number;
  inserted: number;
  unchanged: number;
  deactivated: number;
  active: number;
}

/** Commit courant du dépôt : la provenance d'un prompt doit être lisible (docs/03 §14.4). */
export function readGitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function hashPromptContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Lit l'en-tête d'un prompt :
 *
 * ```text
 * ---
 * agent: system
 * task: cost_probe
 * version: v1
 * notes: sonde de coût utilisée par le job noop
 * ---
 * ```
 */
export function parsePromptFile(relativePath: string, content: string): PromptDefinition | null {
  if (!content.startsWith('---')) return null;

  const end = content.indexOf('\n---', 3);
  if (end === -1) {
    throw new ValidationError(`En-tête de prompt non fermé (--- manquant) : ${relativePath}`, {
      code: 'PROMPT_HEADER_INVALID',
    });
  }

  const header = content.slice(3, end);
  const body = content.slice(content.indexOf('\n', end + 1) + 1).trim();
  const meta = new Map<string, string>();

  for (const line of header.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    meta.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1).trim());
  }

  const agent = meta.get('agent');
  const task = meta.get('task');
  if (!agent || !task) {
    throw new ValidationError(
      `Prompt sans « agent » ou « task » dans son en-tête : ${relativePath}`,
      { code: 'PROMPT_META_MISSING' },
    );
  }

  return {
    agent,
    task,
    versionLabel: meta.get('version') ?? null,
    notes: meta.get('notes') ?? null,
    body,
    filePath: relativePath,
    contentHash: hashPromptContent(content),
  };
}

/** Liste récursivement les prompts Markdown, hors README. */
export function discoverPromptFiles(promptsDir: string): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.endsWith('.md')) continue;
      if (entry.toLowerCase() === 'readme.md') continue;
      found.push(relative(promptsDir, absolute).split(sep).join('/'));
    }
  };

  walk(promptsDir);
  return found;
}

/** Contenu du prompt, en-tête retiré : c'est ce que reçoit le modèle. */
export function readPromptBody(promptsDir: string, filePath: string): string {
  return expandPromptIncludes(promptsDir, filePath, readRawBody(promptsDir, filePath));
}

/**
 * Les prompts partagés s'incluent **explicitement** (docs/04 §6.1) :
 *
 * ```text
 * @include _shared/rules-honesty.md
 * ```
 *
 * Pourquoi une inclusion textuelle et non une variable : la règle reste lisible
 * **dans** le fichier qui l'applique, et un `diff` montre le texte exact envoyé au
 * modèle. Un prompt qui change de sens sans que le fichier change serait un piège.
 */
export const PROMPT_INCLUDE_PATTERN = /^[ \t]*@include[ \t]+(\S+)[ \t]*$/gm;

export function expandPromptIncludes(
  promptsDir: string,
  filePath: string,
  body: string,
  seen: readonly string[] = [],
): string {
  return body.replace(PROMPT_INCLUDE_PATTERN, (_match: string, includePath: string) => {
    const target = normalizeIncludePath(includePath);
    if (seen.includes(target)) {
      throw new ValidationError(
        `Inclusion circulaire de prompt : ${[...seen, target].join(' → ')}`,
        { code: 'PROMPT_INCLUDE_CYCLE', details: { filePath, target } },
      );
    }
    const included = readRawBody(promptsDir, target);
    return expandPromptIncludes(promptsDir, target, included, [...seen, target]);
  });
}

/** Un chemin d'inclusion est **relatif** aux prompts : jamais absolu, jamais `..`. */
function normalizeIncludePath(includePath: string): string {
  const normalized = includePath.replace(/^\.\//, '').split(sep).join('/');
  if (normalized.startsWith('/') || normalized.includes('..')) {
    throw new ValidationError(
      `Inclusion de prompt invalide : ${includePath} (chemin relatif attendu, sans « .. »)`,
      { code: 'PROMPT_INCLUDE_INVALID', details: { includePath } },
    );
  }
  return normalized;
}

/** Corps brut d'un fichier : l'en-tête éventuel est retiré, le reste est intact. */
function readRawBody(promptsDir: string, filePath: string): string {
  const content = readFileSync(join(promptsDir, filePath), 'utf8');
  const parsed = parsePromptFile(filePath, content);
  return parsed ? parsed.body : content.trim();
}

export interface SyncPromptsParams {
  handle: DatabaseHandle;
  promptsDir: string;
  clock: Clock;
  logger: AppLogger;
  gitCommit?: string | null;
}

/**
 * Synchronise les fichiers de `prompts/` avec `prompt_versions`.
 * Idempotent : relancer la synchronisation ne crée aucun doublon (l'unicité est
 * portée par `uq_prompt_hash (agent, task, content_hash)`).
 */
export function syncPrompts(params: SyncPromptsParams): PromptSyncReport {
  const files = discoverPromptFiles(params.promptsDir);
  const now = params.clock.nowMs();
  let inserted = 0;
  let unchanged = 0;
  let deactivated = 0;

  for (const filePath of files) {
    const content = readFileSync(join(params.promptsDir, filePath), 'utf8');
    const definition = parsePromptFile(filePath, content);
    if (!definition) {
      params.logger.debug({ filePath }, 'fichier ignoré : pas d’en-tête de prompt');
      continue;
    }

    const existing = findByHash(
      params.handle,
      definition.agent,
      definition.task,
      definition.contentHash,
    );

    if (existing) {
      unchanged += 1;
      continue;
    }

    const row = insertPromptVersion(params.handle, {
      id: uuidv7(now),
      agent: definition.agent,
      task: definition.task,
      filePath: definition.filePath,
      contentHash: definition.contentHash,
      versionLabel: definition.versionLabel,
      notes: definition.notes,
      gitCommit: params.gitCommit ?? null,
      now,
    });

    deactivated += deactivateOtherVersions(
      params.handle,
      definition.agent,
      definition.task,
      row.id,
    );
    inserted += 1;
  }

  const summary = promptSummary(params.handle);
  const report: PromptSyncReport = {
    scanned: files.length,
    inserted,
    unchanged,
    deactivated,
    active: summary.active,
  };

  params.logger.info(report, 'prompts synchronisés');
  return report;
}

/** Version active d'un prompt, avec son corps : utilisée par les handlers. */
export function loadActivePrompt(
  handle: DatabaseHandle,
  promptsDir: string,
  agent: string,
  task: string,
): { promptVersionId: string; body: string; filePath: string } | undefined {
  const row = activePromptVersion(handle, agent, task);
  if (!row) return undefined;
  return {
    promptVersionId: row.id,
    body: readPromptBody(promptsDir, row.file_path),
    filePath: row.file_path,
  };
}
