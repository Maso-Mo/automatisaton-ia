import { ConflictError, ValidationError, type ProjectStatus } from '@aia/shared';
import { InvalidStateTransitionError } from '../errors';
import type { Project } from './types';

/**
 * Règles du projet lui-même (docs/03 §5.1, docs/10 §4.2).
 *
 * Le projet porte son **identité** : nom, positionnement, objectif, statut. Le
 * détail (motivation, problème traité, stack, architecture…) vit en faits, pas
 * en colonnes — sinon chaque nouvelle question produit une migration.
 */

/**
 * Cycle de vie documenté (docs/03 §5.1). `archived` est terminal : on n'archive
 * pas « pour voir », et un projet archivé ne se rouvre pas en silence.
 */
export const PROJECT_STATUS_TRANSITIONS: Record<ProjectStatus, readonly ProjectStatus[]> = {
  discovery: ['active', 'paused', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

export function canTransitionProjectStatus(from: ProjectStatus, to: ProjectStatus): boolean {
  return from === to || (PROJECT_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export function assertProjectStatusTransition(
  from: ProjectStatus,
  to: ProjectStatus,
  projectId: string,
): void {
  if (canTransitionProjectStatus(from, to)) return;
  throw new InvalidStateTransitionError(from, to, { entity: `projet ${projectId}` });
}

/** Un projet archivé est en lecture seule : c'est le sens même de l'archivage. */
export function assertProjectEditable(project: Project): void {
  if (project.status === 'archived') {
    throw new ValidationError(
      `Le projet « ${project.name} » est archivé : il est en lecture seule`,
      {
        code: 'PROJECT_ARCHIVED',
        details: { projectId: project.id },
      },
    );
  }
}

export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_POSITIONING_MAX_LENGTH = 500;
export const PROJECT_TARGET_GOAL_MAX_LENGTH = 300;

/**
 * Identifiant lisible dérivé du nom (colonne `slug`, unique — docs/03 §5.1).
 * Déterministe : même nom, même slug, donc testable sans base (docs/09 §1.1).
 */
export function slugify(name: string, maxLength = 60): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return base.length > 0 ? base : 'projet';
}

export const SLUG_SUFFIX_LIMIT = 50;

/**
 * Trouve un slug libre : `mon-projet`, puis `mon-projet-2`, `mon-projet-3`…
 * Le contrôle est passé en paramètre (`isTaken`) pour rester pur et testable.
 */
export function uniqueSlug(
  name: string,
  isTaken: (slug: string) => boolean,
  maxLength = 60,
): string {
  const base = slugify(name, maxLength);
  if (!isTaken(base)) return base;

  for (let index = 2; index <= SLUG_SUFFIX_LIMIT; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, maxLength - suffix.length)}${suffix}`;
    if (!isTaken(candidate)) return candidate;
  }

  throw new ConflictError(
    `Impossible de dériver un identifiant lisible unique pour « ${name} » après ${SLUG_SUFFIX_LIMIT} tentatives`,
    { code: 'PROJECT_SLUG_EXHAUSTED', details: { name } },
  );
}

export interface ProjectEditInput {
  name?: string;
  positioning?: string | null;
  targetGoal?: string | null;
  startDate?: number | null;
  timezone?: string | null;
  language?: string;
  status?: ProjectStatus;
}

/** Champs modifiables d'un projet — jamais l'identité ni la date de création. */
export interface ProjectPatch {
  name?: string;
  positioning?: string | null;
  targetGoal?: string | null;
  startDate?: number | null;
  timezone?: string | null;
  language?: string;
  status?: ProjectStatus;
  archivedAt?: number | null;
  updatedAt: number;
}

/**
 * Calcule les colonnes à écrire pour modifier un projet. Pur, comme les règles
 * de faits : la décision se teste sans base de données.
 */
export function planProjectEdit(
  project: Project,
  input: ProjectEditInput,
  now: number,
): ProjectPatch {
  assertProjectEditable(project);

  const name = input.name === undefined ? project.name : input.name.trim();
  if (name.length === 0) {
    throw new ValidationError('Le nom du projet ne peut pas être vide', {
      code: 'PROJECT_NAME_REQUIRED',
    });
  }
  if (name.length > PROJECT_NAME_MAX_LENGTH) {
    throw new ValidationError(
      `Le nom du projet ne dépasse pas ${PROJECT_NAME_MAX_LENGTH} caractères`,
      { code: 'PROJECT_NAME_TOO_LONG' },
    );
  }
  assertOptionalLength(
    input.positioning,
    PROJECT_POSITIONING_MAX_LENGTH,
    'PROJECT_POSITIONING_TOO_LONG',
  );
  assertOptionalLength(
    input.targetGoal,
    PROJECT_TARGET_GOAL_MAX_LENGTH,
    'PROJECT_TARGET_GOAL_TOO_LONG',
  );

  const status = input.status ?? project.status;
  assertProjectStatusTransition(project.status, status, project.id);

  const patch: ProjectPatch = { updatedAt: now };
  if (name !== project.name) patch.name = name;

  if (input.positioning !== undefined) {
    const positioning = normalizeOptional(input.positioning);
    if (positioning !== project.positioning) patch.positioning = positioning;
  }
  if (input.targetGoal !== undefined) {
    const targetGoal = normalizeOptional(input.targetGoal);
    if (targetGoal !== project.targetGoal) patch.targetGoal = targetGoal;
  }
  if (input.startDate !== undefined && input.startDate !== project.startDate) {
    patch.startDate = input.startDate;
  }
  if (input.timezone !== undefined) {
    const timezone = normalizeOptional(input.timezone);
    if (timezone !== project.timezone) patch.timezone = timezone;
  }
  if (input.language !== undefined) {
    const language = input.language.trim();
    if (language.length === 0) {
      throw new ValidationError('La langue du projet ne peut pas être vide', {
        code: 'PROJECT_LANGUAGE_REQUIRED',
      });
    }
    if (language !== project.language) patch.language = language;
  }

  if (status !== project.status) {
    patch.status = status;
    patch.archivedAt = status === 'archived' ? (project.archivedAt ?? now) : null;
  }

  return patch;
}

function normalizeOptional(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function assertOptionalLength(
  value: string | null | undefined,
  maxLength: number,
  code: string,
): void {
  if (value === undefined || value === null) return;
  if (value.length > maxLength) {
    throw new ValidationError(`Texte trop long : ${maxLength} caractères maximum`, {
      code,
      details: { maxLength, received: value.length },
    });
  }
}
