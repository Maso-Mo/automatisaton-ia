import {
  NotFoundError,
  ValidationError,
  type FactCategory,
  type FactSource,
  type FactVerificationStatus,
  type ProjectStatus,
} from '@aia/shared';
import {
  assertFactContent,
  assertSourceAllowsInitialStatus,
  assertVerificationIsHumanAct,
  defaultFactStatusFor,
  deriveVerifiedByUser,
  planFactEdit,
  planFactSupersession,
  planFactVerification,
  type FactEditInput,
} from './facts';
import {
  assertProjectEditable,
  planProjectEdit,
  uniqueSlug,
  type ProjectEditInput,
} from './projects';
import {
  buildProjectContext,
  type ContextSelectionOptions,
  type ProjectContext,
} from './selection';
import type {
  FactFilter,
  Project,
  ProjectFact,
  ProjectFilter,
  ProjectMemoryPorts,
  ProjectMemoryStore,
} from './types';

/**
 * Cas d'usage de la mémoire de projet (docs/10 §4.2). Le domaine **décide**, la
 * base stocke : ce fichier ne connaît ni SQL ni HTTP, et reçoit ses ports
 * (`ProjectMemoryPorts`). C'est ce qui permettra de tester chaque règle sur une
 * base réelle **et** de remplacer SQLite sans réécrire une seule décision.
 *
 * Aucune fonction de ce fichier ne supprime : la mémoire longue ne se supprime
 * pas (docs/03 §2.6, §16.1). Un fait s'invalide ou se remplace.
 */

export interface CreateProjectInput {
  name: string;
  positioning?: string | null;
  targetGoal?: string | null;
  language?: string;
  timezone?: string | null;
  startDate?: number | null;
  /** Première description : enregistrée en **fait** (catégorie `description`). */
  description?: string | null;
}

export interface AddFactInput {
  category: FactCategory;
  statement: string;
  detail?: string | null;
  importance?: number;
  /** Par défaut `user_input` : la saisie directe de l'utilisateur. */
  source?: FactSource;
  verificationStatus?: FactVerificationStatus;
  verificationNote?: string | null;
}

export interface ReplaceFactInput extends AddFactInput {
  /** Note expliquant le remplacement, conservée sur l'ancien fait. */
  note?: string | null;
}

export interface ProjectFactSummary {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  /** Faits confirmés : les seuls injectables dans un prompt (docs/03 §6.1). */
  trusted: number;
}

export function summarizeProjectFacts(facts: readonly ProjectFact[]): ProjectFactSummary {
  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  let trusted = 0;

  for (const fact of facts) {
    byStatus[fact.verificationStatus] = (byStatus[fact.verificationStatus] ?? 0) + 1;
    byCategory[fact.category] = (byCategory[fact.category] ?? 0) + 1;
    if (fact.verificationStatus === 'verified') trusted += 1;
  }

  return { total: facts.length, byStatus, byCategory, trusted };
}

function storePorts(ports: ProjectMemoryPorts): ProjectMemoryStore {
  return ports.store;
}
function requireProject(ports: ProjectMemoryPorts, projectId: string): Project {
  const project = storePorts(ports).projects.byId(projectId);
  if (!project) {
    throw new NotFoundError(`Projet introuvable : ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }
  return project;
}

/** Un fait d'un autre projet n'existe pas : l'erreur ne révèle rien (docs/02 §12). */
function requireFact(ports: ProjectMemoryPorts, projectId: string, factId: string): ProjectFact {
  const fact = storePorts(ports).facts.byId(factId);
  if (!fact || fact.projectId !== projectId) {
    throw new NotFoundError(`Fait introuvable dans ce projet : ${factId}`, {
      code: 'FACT_NOT_FOUND',
      details: { projectId, factId },
    });
  }
  return fact;
}

function buildFact(
  ports: ProjectMemoryPorts,
  projectId: string,
  input: AddFactInput,
  extra: { supersedesFactId?: string | null } = {},
): ProjectFact {
  const now = ports.clock.nowMs();
  const category = input.category;
  const statement = input.statement.trim();
  const detail = input.detail ?? null;
  const importance = input.importance ?? 3;
  assertFactContent({ category, statement, detail, importance });

  const source: FactSource = input.source ?? 'user_input';
  const verificationStatus = input.verificationStatus ?? defaultFactStatusFor(source);
  assertSourceAllowsInitialStatus(source, verificationStatus);

  const verifiedAt = verificationStatus === 'verified' ? now : null;
  assertVerificationIsHumanAct(verificationStatus, verifiedAt);

  return {
    id: ports.newId(),
    projectId,
    category,
    statement,
    detail,
    source,
    sourceMessageId: null,
    verificationStatus,
    verificationNote: input.verificationNote ?? null,
    verifiedAt,
    verifiedByUser: deriveVerifiedByUser(verificationStatus),
    importance,
    usedCount: 0,

    lastUsedAt: null,
    supersedesFactId: extra.supersedesFactId ?? null,
    supersededByFactId: null,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

// --- Projets ---------------------------------------------------------------

export function createProject(ports: ProjectMemoryPorts, input: CreateProjectInput): Project {
  const store = storePorts(ports);
  const now = ports.clock.nowMs();
  const name = input.name.trim();
  if (name.length === 0) {
    throw new ValidationError('Le nom du projet est obligatoire', {
      code: 'PROJECT_NAME_REQUIRED',
    });
  }

  const slug = uniqueSlug(name, (candidate) => store.projects.bySlug(candidate) !== undefined);
  const project: Project = {
    id: ports.newId(),
    ownerId: store.owner.currentId(),
    name,
    slug,
    positioning: input.positioning ?? null,
    status: 'discovery', // cycle de vie documenté : un projet neuf est en découverte
    targetGoal: input.targetGoal ?? null,
    startDate: input.startDate ?? now,
    timezone: input.timezone ?? null,
    language: input.language ?? 'fr',
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };

  const description = input.description?.trim();
  return store.transaction(() => {
    store.projects.insert(project);
    if (description) {
      store.facts.insert(
        buildFact(ports, project.id, {
          category: 'description',
          statement: description,
          source: 'user_input',
        }),
      );
    }
    return project;
  });
}

export function getProject(ports: ProjectMemoryPorts, projectId: string): Project {
  return requireProject(ports, projectId);
}

export function listProjects(ports: ProjectMemoryPorts, filter: ProjectFilter = {}): Project[] {
  return storePorts(ports).projects.list(filter);
}

export function updateProject(
  ports: ProjectMemoryPorts,
  projectId: string,
  edit: ProjectEditInput,
): Project {
  const store = storePorts(ports);
  const project = requireProject(ports, projectId);
  const patch = planProjectEdit(project, edit, ports.clock.nowMs());
  store.projects.patch(project.id, patch);
  return { ...project, ...patch };
}

/**
 * Archivage : un état, jamais une suppression. Le projet et toute sa mémoire
 * restent lisibles (`archived_at` est renseigné, rien n'est effacé).
 */
export function archiveProject(ports: ProjectMemoryPorts, projectId: string): Project {
  return updateProject(ports, projectId, { status: 'archived' });
}

export function setProjectStatus(
  ports: ProjectMemoryPorts,
  projectId: string,
  status: ProjectStatus,
): Project {
  return updateProject(ports, projectId, { status });
}

// --- Faits -----------------------------------------------------------------

export function addFact(
  ports: ProjectMemoryPorts,
  projectId: string,
  input: AddFactInput,
): ProjectFact {
  const store = storePorts(ports);
  const project = requireProject(ports, projectId);
  assertProjectEditable(project);

  const fact = buildFact(ports, projectId, input);
  store.facts.insert(fact);
  return fact;
}

export function getFact(ports: ProjectMemoryPorts, projectId: string, factId: string): ProjectFact {
  requireProject(ports, projectId);
  return requireFact(ports, projectId, factId);
}

export function listProjectFacts(
  ports: ProjectMemoryPorts,
  projectId: string,
  filter: Omit<FactFilter, 'projectId'> = {},
): ProjectFact[] {
  requireProject(ports, projectId);
  return storePorts(ports).facts.list({ projectId, ...filter });
}

/** Modification du contenu d'un fait. L'état de vérification ne bouge pas ici. */
export function updateFact(
  ports: ProjectMemoryPorts,
  projectId: string,
  factId: string,
  edit: FactEditInput,
): ProjectFact {
  const store = storePorts(ports);
  const project = requireProject(ports, projectId);
  assertProjectEditable(project);
  const fact = requireFact(ports, projectId, factId);

  const patch = planFactEdit(fact, edit, ports.clock.nowMs());
  store.facts.patch(fact.id, patch);
  return { ...fact, ...patch };
}

/**
 * Changement d'état de vérification : `verified`, `user_provided`, `uncertain`,
 * `obsolete`. La transition doit exister (`FACT_STATUS_TRANSITIONS`) — un fait
 * remplacé ne redevient jamais vivant.
 */
export function setFactVerification(
  ports: ProjectMemoryPorts,
  projectId: string,
  factId: string,
  status: FactVerificationStatus,
  note: string | null = null,
): ProjectFact {
  const store = storePorts(ports);
  const project = requireProject(ports, projectId);
  assertProjectEditable(project);
  const fact = requireFact(ports, projectId, factId);

  if (status === 'superseded') {
    throw new ValidationError(
      'Un fait se remplace par un nouveau fait : utiliser la route de remplacement',
      { code: 'FACT_SUPERSEDE_REQUIRES_REPLACEMENT', details: { factId } },
    );
  }

  const patch = planFactVerification(fact, status, ports.clock.nowMs(), note);
  store.facts.patch(fact.id, patch);
  return { ...fact, ...patch };
}

/** Raccourci du geste le plus fréquent : « ce fait est confirmé par moi ». */
export function verifyFact(
  ports: ProjectMemoryPorts,
  projectId: string,
  factId: string,
  note: string | null = null,
): ProjectFact {
  return setFactVerification(ports, projectId, factId, 'verified', note);
}

/**
 * Remplacement : le nouveau fait **référence** l'ancien, qui reste lisible en
 * état `superseded`. Les deux écritures sont dans la même transaction, sinon un
 * incident laisserait un fait orphelin — c'est exactement ce que l'historique
 * doit rendre impossible (docs/03 §16.1).
 */
export function replaceFact(
  ports: ProjectMemoryPorts,
  projectId: string,
  factId: string,
  input: ReplaceFactInput,
): { superseded: ProjectFact; replacement: ProjectFact } {
  const store = storePorts(ports);
  const project = requireProject(ports, projectId);
  assertProjectEditable(project);
  const previous = requireFact(ports, projectId, factId);

  const replacement = buildFact(ports, projectId, input, { supersedesFactId: previous.id });
  const supersededPatch = planFactSupersession(previous, replacement.id, ports.clock.nowMs());
  const note = input.note ?? `Remplacé par le fait ${replacement.id}`;

  return store.transaction(() => {
    store.facts.insert(replacement);
    store.facts.patch(previous.id, { ...supersededPatch, verificationNote: note });
    return {
      superseded: { ...previous, ...supersededPatch, verificationNote: note },
      replacement,
    };
  });
}

// --- Contexte déterministe -------------------------------------------------

export function getProjectContext(
  ports: ProjectMemoryPorts,
  projectId: string,
  options: Omit<ContextSelectionOptions, 'nowMs'> & { nowMs?: number } = {},
): ProjectContext {
  const project = requireProject(ports, projectId);
  // Tous les faits sont chargés, puis filtrés **par la sélection déterministe** :
  // c'est elle qui doit pouvoir dire *pourquoi* un fait a été écarté (docs/03 §6.6).
  const facts = storePorts(ports).facts.list({ projectId, includeInactive: true });

  return buildProjectContext(project, facts, {
    ...options,
    nowMs: options.nowMs ?? ports.clock.nowMs(),
  });
}

export function projectFactSummary(
  ports: ProjectMemoryPorts,
  projectId: string,
): ProjectFactSummary {
  requireProject(ports, projectId);
  return summarizeProjectFacts(storePorts(ports).facts.list({ projectId, includeInactive: true }));
}
