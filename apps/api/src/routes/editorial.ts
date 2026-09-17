import type { FastifyInstance } from 'fastify';
import {
  approveContent,
  approveContentBodySchema,
  contentBundle,
  contentHistory,
  contentListQuerySchema,
  editContent,
  editContentBodySchema,
  generateContentBodySchema,
  listProjectContent,
  markInReview,
  parseOrThrow,
  regenerateContentBodySchema,
  rejectAngle,
  rejectAngleBodySchema,
  rejectContent,
  rejectContentBodySchema,
  selectAngle,
  selectAngleBodySchema,
  subjectListQuerySchema,
  validateDraft,
  type ContentSubject,
  type DraftValidation,
  type EditorialPorts,
  type SubjectAngle,
} from '@aia/core';
import { allContentTargets, NotFoundError, type TargetDraft } from '@aia/shared';
import type { ApiContext } from '../bootstrap';
import {
  enqueueContentGeneration,
  enqueueContentRegeneration,
  generateEditorialPlan,
} from '../features/editorial';

/**
 * Editorial : plan, sujets, angles, contenus (docs/10 §4.3, §4.4).
 *
 * Trois principes, les memes que partout ailleurs :
 *
 * 1. **le domaine decide** : la route valide une entree (`parseOrThrow`), appelle
 *    un cas d'usage de `@aia/core`, et rend le resultat. Aucune regle metier ici ;
 * 2. **un plan est synchrone, une redaction est un job** (docs/05 §10.1) : la
 *    route du plan attend la reponse, celles qui redigent rendent `202` avec
 *    l'identifiant du job a suivre (`GET /events/jobs/:id`) ;
 * 3. **rien n'est approuve par le modele** : les decisions d'approbation et de
 *    rejet passent par leurs routes, et elles laissent une trace.
 */

/** Sujet et angles tels que l'ecran de choix les affiche : un objet, pas deux appels. */
function subjectWithAngles(
  ports: EditorialPorts,
  subject: ContentSubject,
): { subject: ContentSubject; angles: SubjectAngle[] } {
  return { subject, angles: ports.store.listAngles(subject.id) };
}

/**
 * Le controle local de la version courante, recalcule a la lecture.
 *
 * Il n'est **pas** stocke : `validateDraft` est une fonction pure des limites de
 * la plateforme et du texte. Le recalculer garantit qu'un contenu relu apres un
 * changement de limite (docs/06 §4 a §8) est juge avec la regle d'aujourd'hui, pas
 * avec celle de sa generation — et cela evite une colonne qui mentirait des la
 * premiere mise a jour des limites.
 */
function currentValidation(ports: EditorialPorts, itemId: string): DraftValidation | null {
  const { item, currentVersionId } = contentHistory(ports, itemId);
  if (!currentVersionId) return null;
  const version = ports.store.getVersion(currentVersionId);
  if (!version) return null;
  const draft: TargetDraft = {
    body: version.body,
    // `TargetDraft` est la forme **d'entrée** du schéma d'un brouillon : un texte
    // sans accroche est représenté par une chaîne vide, jamais par une absence.
    hook: version.hook ?? '',
    ...(version.title ? { title: version.title } : {}),
    hashtags: [...version.hashtags],
    mentions: [...version.mentions],
    // On ne rejoue pas les remarques du modèle : elles sont déjà en base, et ce
    // contrôle-ci ne juge que le texte.
    notes: [],
  };
  return validateDraft(item.target, draft);
}

export function registerEditorialRoutes(app: FastifyInstance, context: ApiContext): void {
  const deps = context.editorial;
  const ports: EditorialPorts = deps.ports;

  // --- Plan, sujets, angles --------------------------------------------------

  /**
   * Le plan est **synchrone** (docs/05 §10.1) : l'appel dure quelques secondes et
   * l'utilisateur veut voir les sujets tout de suite. `201` : un plan est une
   * creation, et son corps porte le verdict de la verification locale — les sujets
   * refuses **avec leurs raisons**.
   */
  app.post('/projects/:id/plan', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await generateEditorialPlan(deps, id);
    return reply.status(201).send({
      subjects: result.subjects,
      angles: result.angles,
      accepted: result.accepted,
      rejected: result.rejected,
      droppedAngles: result.droppedAngles,
      usage: result.usage,
      repaired: result.repaired,
    });
  });

  app.get('/projects/:id/subjects', async (request) => {
    const { id } = request.params as { id: string };
    const query = parseOrThrow(subjectListQuerySchema, request.query, 'SUBJECT_QUERY_INVALID');
    const subjects = ports.store.listSubjects(id, {
      ...(query.status ? { statuses: [query.status] } : {}),
    });
    const limited = query.limit ? subjects.slice(0, query.limit) : subjects;
    return { subjects: limited.map((subject) => subjectWithAngles(ports, subject)) };
  });

  app.get('/subjects/:subjectId', async (request) => {
    const { subjectId } = request.params as { subjectId: string };
    const subject = ports.store.getSubject(subjectId);
    if (!subject) {
      throw new NotFoundError(`Sujet introuvable : ${subjectId}`, {
        code: 'SUBJECT_NOT_FOUND',
        details: { subjectId },
      });
    }
    return subjectWithAngles(ports, subject);
  });

  app.post('/angles/:angleId/select', async (request) => {
    const { angleId } = request.params as { angleId: string };
    parseOrThrow(selectAngleBodySchema, request.body ?? {}, 'ANGLE_SELECT_INVALID');
    const { angle, subject } = selectAngle(ports, angleId);
    return { angle, subject, angles: ports.store.listAngles(subject.id) };
  });

  app.post('/angles/:angleId/reject', async (request) => {
    const { angleId } = request.params as { angleId: string };
    const body = parseOrThrow(rejectAngleBodySchema, request.body ?? {}, 'ANGLE_REJECT_INVALID');
    const angle = rejectAngle(ports, angleId, body.reason ?? null);
    return { angle, angles: ports.store.listAngles(angle.subjectId) };
  });

  // --- Contenus --------------------------------------------------------------

  app.get('/projects/:id/content', async (request) => {
    const { id } = request.params as { id: string };
    const query = parseOrThrow(contentListQuerySchema, request.query, 'CONTENT_QUERY_INVALID');
    const items = listProjectContent(ports, id, {
      ...(query.state ? { state: query.state } : {}),
    });
    const limited = query.limit ? items.slice(0, query.limit) : items;
    return {
      content: limited,
      /** Les cibles possibles : l'interface n'a pas a recopier cette table. */
      targets: allContentTargets(),
    };
  });

  /**
   * « Generer » : les lignes de contenu sont creees par le domaine, puis **un**
   * job pour le lot est mis dans la file. L'API **n'execute rien** — le worker est
   * seul a reserver et a executer (docs/02 §5). `202` : le travail est accepte,
   * pas termine.
   */
  app.post('/projects/:id/content', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(generateContentBodySchema, request.body, 'CONTENT_INPUT_INVALID');
    const result = await enqueueContentGeneration(deps, {
      projectId: id,
      angleId: body.angleId,
      targets: body.targets,
    });
    return reply.status(202).send({
      content: result.items.map((item) => contentBundle(ports, item.id)),
      jobId: result.jobId,
    });
  });

  /**
   * « Regenerer » : une nouvelle version, jamais un ecrasement (docs/05 §4.4).
   * Le job ne porte **qu'une** cible, celle du contenu designe.
   */
  app.post('/content/:contentId/regenerate', async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    const body = parseOrThrow(
      regenerateContentBodySchema,
      request.body ?? {},
      'REGENERATE_INPUT_INVALID',
    );
    const result = await enqueueContentRegeneration(deps, {
      contentItemId: contentId,
      instruction: body.instruction ?? null,
    });
    return reply.status(202).send({
      content: contentBundle(ports, result.item.id),
      jobId: result.jobId,
    });
  });

  /**
   * La lecture d'un contenu : l'etat, la version courante et ses remarques, **tout
   * l'historique** et le controle local recalcule. L'ecran de relecture n'a donc
   * qu'un appel a faire, et il ne peut pas afficher autre chose que ce que le
   * serveur sait.
   */
  app.get('/content/:contentId', async (request) => {
    const { contentId } = request.params as { contentId: string };
    return {
      content: contentBundle(ports, contentId),
      history: contentHistory(ports, contentId),
      validation: currentValidation(ports, contentId),
    };
  });

  /** L'ouverture de l'ecran de relecture : l'acte est enregistre, il n'est pas devine. */
  app.post('/content/:contentId/review', async (request) => {
    const { contentId } = request.params as { contentId: string };
    return { content: markInReview(ports, contentId) };
  });

  /**
   * L'edition manuelle : une nouvelle version, marquee `edited`. Le corps est
   * remplace en entier (docs/05 §4.5) ; l'approbation eventuelle tombe, parce
   * qu'un texte que l'utilisateur vient de changer n'est plus le texte approuve.
   */
  app.patch('/content/:contentId', async (request) => {
    const { contentId } = request.params as { contentId: string };
    const body = parseOrThrow(editContentBodySchema, request.body, 'CONTENT_EDIT_INVALID');
    editContent(ports, {
      itemId: contentId,
      author: body.author ?? 'user',
      draft: {
        body: body.body,
        // Un texte édité sans accroche a une accroche vide : c'est la forme
        // d'entrée du schéma, et c'est ainsi que le contrôle local la lira.
        hook: body.hook ?? '',
        ...(body.title !== undefined ? { title: body.title } : {}),
        hashtags: body.hashtags ?? [],
        mentions: body.mentions ?? [],
        // Les remarques du modèle concernaient la version précédente : la nouvelle
        // version part sans note inventée, et les erreurs du contrôle y seront
        // ajoutées par le domaine.
        notes: [],
      },
    });
    return { content: contentBundle(ports, contentId) };
  });

  app.post('/content/:contentId/approve', async (request) => {
    const { contentId } = request.params as { contentId: string };
    const body = parseOrThrow(
      approveContentBodySchema,
      request.body ?? {},
      'APPROVE_INPUT_INVALID',
    );
    return { content: approveContent(ports, contentId, body.approvedBy ?? null) };
  });

  /**
   * Le rejet : une decision humaine, tracee, qui archive le contenu. Le motif est
   * obligatoire — un rejet sans raison ne s'apprend pas (docs/05 §4.1).
   */
  app.post('/content/:contentId/reject', async (request) => {
    const { contentId } = request.params as { contentId: string };
    const body = parseOrThrow(rejectContentBodySchema, request.body, 'REJECT_INPUT_INVALID');
    return {
      content: rejectContent(ports, contentId, {
        reason: body.reason,
        author: body.author ?? 'user',
      }),
    };
  });
}
