import {
  addFact,
  addFactBodySchema,
  archiveProject,
  contextQuerySchema,
  createProject,
  createProjectBodySchema,
  factListQuerySchema,
  FACT_DETAIL_MAX_LENGTH,
  FACT_STATEMENT_MAX_LENGTH,
  FACT_STATUS_TRANSITIONS,
  getFact,
  getProject,
  getProjectContext,
  listProjectFacts,
  listProjects,
  listProjectsQuerySchema,
  parseOrThrow,
  PROJECT_KNOWLEDGE_CATEGORIES,
  PROJECT_STATUS_TRANSITIONS,
  projectFactSummary,
  RECENCY_HALF_LIFE_DAYS,
  replaceFact,
  replaceFactBodySchema,
  setFactVerification,
  updateFact,
  updateFactBodySchema,
  updateProject,
  updateProjectBodySchema,
  verificationBodySchema,
} from '@aia/core';
import {
  FACT_CATEGORY_LABELS,
  FACT_CATEGORIES,
  FACT_SOURCE_LABELS,
  FACT_SOURCES,
  FACT_VERIFICATION_STATUS_LABELS,
  FACT_VERIFICATION_STATUSES,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from '@aia/shared';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';

/**
 * Mémoire des projets (docs/10 §4.2) : créer, lire, modifier, archiver un projet,
 * puis gérer ses faits — ajout, correction, confirmation, invalidation,
 * remplacement — et lire un contexte **déterministe**.
 *
 * La route ne décide de rien : elle valide une entrée (`parseOrThrow`), appelle
 * un cas d'usage de `@aia/core`, et rend le résultat. Un refus métier est une
 * erreur typée (`validation`, `conflict`, `not_found`) traduite en statut HTTP
 * par le gestionnaire d'erreurs unique (docs/02 §12).
 *
 * **Aucune route de suppression n'existe** : la mémoire longue ne se supprime
 * pas (docs/03 §2.6). Invalider, c'est `POST …/verification` ; remplacer, c'est
 * `POST …/replacement`.
 */

function vocabulary(): unknown {
  return {
    projectStatuses: PROJECT_STATUSES.map((value) => ({
      value,
      label: PROJECT_STATUS_LABELS[value],
      next: PROJECT_STATUS_TRANSITIONS[value],
    })),
    factCategories: FACT_CATEGORIES.map((value) => ({ value, label: FACT_CATEGORY_LABELS[value] })),
    factSources: FACT_SOURCES.map((value) => ({ value, label: FACT_SOURCE_LABELS[value] })),
    factVerificationStatuses: FACT_VERIFICATION_STATUSES.map((value) => ({
      value,
      label: FACT_VERIFICATION_STATUS_LABELS[value],
      next: FACT_STATUS_TRANSITIONS[value],
    })),
    /** Les seize informations demandées à l'étape 2. */
    knowledgeCategories: [...PROJECT_KNOWLEDGE_CATEGORIES],
    limits: {
      factStatementMaxLength: FACT_STATEMENT_MAX_LENGTH,
      factDetailMaxLength: FACT_DETAIL_MAX_LENGTH,
      recencyHalfLifeDays: RECENCY_HALF_LIFE_DAYS,
    },
  };
}

export function registerProjectRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/projects/vocabulary', async () => vocabulary());

  app.get('/projects', async (request) => {
    const query = parseOrThrow(listProjectsQuerySchema, request.query, 'PROJECT_QUERY_INVALID');
    const projects = listProjects(context.memory, {
      ...(query.status ? { statuses: query.status } : {}),
      ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return { projects };
  });

  app.post('/projects', async (request, reply) => {
    const body = parseOrThrow(createProjectBodySchema, request.body, 'PROJECT_INPUT_INVALID');
    const project = createProject(context.memory, body);
    reply.status(201);
    return { project, summary: projectFactSummary(context.memory, project.id) };
  });

  app.get('/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const project = getProject(context.memory, id);
    return {
      project,
      summary: projectFactSummary(context.memory, id),
      /** Les seize informations attendues : celles qui manquent sont nommées. */
      context: getProjectContext(context.memory, id, { limit: 8 }),
    };
  });

  app.patch('/projects/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateProjectBodySchema, request.body, 'PROJECT_INPUT_INVALID');
    return { project: updateProject(context.memory, id, body) };
  });

  app.post('/projects/:id/archive', async (request) => {
    const { id } = request.params as { id: string };
    return { project: archiveProject(context.memory, id) };
  });

  // --- Faits ---------------------------------------------------------------

  app.get('/projects/:id/facts', async (request) => {
    const { id } = request.params as { id: string };
    const query = parseOrThrow(factListQuerySchema, request.query, 'FACT_QUERY_INVALID');
    const facts = listProjectFacts(context.memory, id, {
      ...(query.category ? { categories: query.category } : {}),
      ...(query.status ? { statuses: query.status } : {}),
      ...(query.since !== undefined ? { sinceMs: query.since } : {}),
      ...(query.until !== undefined ? { untilMs: query.until } : {}),
      ...(query.includeInactive !== undefined ? { includeInactive: query.includeInactive } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    return { facts, summary: projectFactSummary(context.memory, id) };
  });

  app.post('/projects/:id/facts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(addFactBodySchema, request.body, 'FACT_INPUT_INVALID');
    const fact = addFact(context.memory, id, body);
    reply.status(201);
    return { fact };
  });

  app.get('/projects/:id/facts/:factId', async (request) => {
    const { id, factId } = request.params as { id: string; factId: string };
    return { fact: getFact(context.memory, id, factId) };
  });

  app.patch('/projects/:id/facts/:factId', async (request) => {
    const { id, factId } = request.params as { id: string; factId: string };
    const body = parseOrThrow(updateFactBodySchema, request.body, 'FACT_INPUT_INVALID');
    return { fact: updateFact(context.memory, id, factId, body) };
  });

  /** Confirmer, douter, invalider : un seul geste, une transition validée. */
  app.post('/projects/:id/facts/:factId/verification', async (request) => {
    const { id, factId } = request.params as { id: string; factId: string };
    const body = parseOrThrow(verificationBodySchema, request.body, 'FACT_VERIFICATION_INVALID');
    return {
      fact: setFactVerification(context.memory, id, factId, body.status, body.note ?? null),
    };
  });

  /**
   * Remplacement : le nouveau fait référence l'ancien, qui reste lisible. La
   * réponse contient **les deux** — l'historique est la preuve, pas un détail.
   */
  app.post('/projects/:id/facts/:factId/replacement', async (request, reply) => {
    const { id, factId } = request.params as { id: string; factId: string };
    const body = parseOrThrow(replaceFactBodySchema, request.body, 'FACT_INPUT_INVALID');
    const result = replaceFact(context.memory, id, factId, body);
    reply.status(201);
    return result;
  });

  /** Contexte déterministe : projet, catégories, états, dates, limite. */
  app.get('/projects/:id/context', async (request) => {
    const { id } = request.params as { id: string };
    const query = parseOrThrow(contextQuerySchema, request.query, 'CONTEXT_QUERY_INVALID');
    return getProjectContext(context.memory, id, {
      ...(query.category ? { categories: query.category } : {}),
      ...(query.status ? { statuses: query.status } : {}),
      ...(query.since !== undefined ? { sinceMs: query.since } : {}),
      ...(query.until !== undefined ? { untilMs: query.until } : {}),
      ...(query.includeUnverified !== undefined
        ? { includeUnverified: query.includeUnverified }
        : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
  });
}
