import {
  assertBriefApproved,
  assertRegenerationAllowed,
  contentContext,
  createContentItems,
  persistPlan,
  projectSnapshot,
  validatePlan,
  type ContentItem,
  type EditorialPorts,
  type PlanCreationResult,
  type ProjectMemoryPorts,
} from '@aia/core';
import type { Agent, AnglePlannerInput, LLMUsage } from '@aia/ai';
import { GENERATE_CONTENT_JOB, type Queue } from '@aia/queue';
import type { AppLogger } from '@aia/observability';
import {
  NotFoundError,
  ValidationError,
  type ContentTarget,
  type EditorialPlanOutput,
} from '@aia/shared';
import { projectMemoryPack } from './memory-pack';

/**
 * Orchestration éditoriale — étape 3 (plan) et étape 4 (rédaction).
 *
 * Deux régimes cohabitent ici, et la frontière entre les deux est le **temps** :
 *
 * 1. **le plan est synchrone** (docs/05 §10.1 : « génération éditoriale | plan :
 *    synchrone »). Un appel de quelques secondes se vit dans la requête, et
 *    l'utilisateur veut voir le plan tout de suite ;
 * 2. **la rédaction est un job** (docs/05 §10.1 : « rédaction | job »). Cinq
 *    textes, un appel lourd, des réessais : cela ne se met pas dans une requête
 *    HTTP. L'API **écrit** le job, le worker l'exécute, l'interface suit
 *    `job_events`.
 *
 * Aucune règle métier n'est écrite ici : le domaine vérifie l'ancrage
 * (`validatePlan`), crée les lignes (`createContentItems`) et décide des états.
 * Ce module ne fait que brancher le domaine sur un agent et sur la file.
 */

export interface EditorialAgentBundle<TIn, TOut> {
  agent: Agent<TIn, TOut>;
  prompt: { promptVersionId: string; filePath: string };
  /** Identifiant de la dernière ligne `llm_calls` écrite (traçabilité). */
  lastCallId(): string | null;
}

export interface EditorialFeatureDeps {
  memory: ProjectMemoryPorts;
  /** Le domaine éditorial : sujets, angles, contenus, versions. */
  ports: EditorialPorts;
  agents: {
    anglePlanner(): EditorialAgentBundle<AnglePlannerInput, EditorialPlanOutput>;
  };
  /**
   * La file, en **écriture seule** : l'API n'exécute rien. Le worker est le seul
   * à réserver et à exécuter des jobs (docs/02 §5).
   */
  queue: Pick<Queue, 'enqueue'>;
  logger: AppLogger;
}

export interface EditorialPlanResult extends PlanCreationResult {
  usage: LLMUsage;
  repaired: boolean;
}

/**
 * Génère un plan éditorial : mémoire → agent → vérification locale → persistance.
 *
 * L'ordre n'est pas négociable, et l'étape 3 en dépend :
 *
 * 1. **la fiche maître doit être validée** (`assertBriefApproved`) : un plan sans
 *    positionnement validé produirait des sujets que personne n'a validés ;
 * 2. le contexte envoyé au modèle est la **mémoire du projet**, pas la
 *    conversation : ce qui n'est pas un fait confirmé n'entre pas dans le prompt ;
 * 3. la sortie est **vérifiée en code** (`validatePlan`) : chaque `evidence` doit
 *    citer un fait réel, à la lettre. Un sujet non ancré est rejeté avec ses
 *    raisons — l'utilisateur voit pourquoi, et le plan n'est pas « silencieusement
 *    plus court » ;
 * 4. les titres déjà proposés sont transmis au modèle (`recentTitles`) **et**
 *    utilisés par le score : l'anti-répétition ne repose pas sur la bonne volonté
 *    du modèle.
 */
export async function generateEditorialPlan(
  deps: EditorialFeatureDeps,
  projectId: string,
): Promise<EditorialPlanResult> {
  assertBriefApproved(deps.ports, projectId);

  const snapshot = projectSnapshot(deps.ports, projectId);
  const memoryPack = projectMemoryPack({ memory: deps.memory }, projectId);
  const recentTitles = deps.ports.store.listSubjectTitles(projectId);

  const bundle = deps.agents.anglePlanner();
  const result = await bundle.agent.run(
    { memoryPack, openQuestions: [], recentTitles },
    {
      callContext: {
        projectId,
        agent: 'strategist',
        task: 'angles',
        promptVersionId: bundle.prompt.promptVersionId,
      },
    },
  );

  const validated = validatePlan(result.output, snapshot);
  const created = persistPlan(deps.ports, projectId, validated);

  deps.logger.info(
    {
      projectId,
      accepted: created.accepted,
      rejected: created.rejected.length,
      droppedAngles: created.droppedAngles,
      promptFile: bundle.prompt.filePath,
    },
    'plan éditorial enregistré',
  );

  return { ...created, usage: result.usage, repaired: result.repaired };
}

export interface ContentGenerationRequest {
  projectId: string;
  angleId: string;
  /** Les cibles demandées : au moins une, sinon il n'y a rien à écrire. */
  targets: readonly ContentTarget[];
}

export interface ContentGenerationResult {
  items: ContentItem[];
  /**
   * **Un** job pour le lot demandé — pas un job par contenu.
   *
   * C'est la conséquence directe de docs/04 §4.3 : les plateformes d'un même clic
   * partagent un seul appel structuré, donc un seul job, un seul contexte, un seul
   * coût d'entrée. Un job par plateforme paierait cinq fois le même contexte.
   */
  jobId: string;
}

export interface ContentRegenerationRequest {
  /** Le contenu **exact** à réécrire : celui sur lequel l'utilisateur a cliqué. */
  contentItemId: string;
  /** Consigne de réécriture, en clair, transmise telle quelle au modèle. */
  instruction?: string | null;
}

export interface ContentRegenerationResult {
  item: ContentItem;
  jobId: string;
}

/**
 * « Générer » — crée les contenus **puis** met le lot dans la file.
 *
 * Les deux moitiés de cette fonction ont chacune une raison d'être :
 *
 * - les lignes `content_items` sont créées **avant** le job par le domaine : si
 *   le modèle échoue, l'utilisateur voit que la génération a été tentée (et peut
 *   relancer) au lieu de ne rien voir du tout ;
 * - **un** job pour le lot : `platform_writer` produit toutes les cibles en un
 *   appel (docs/04 §4.3), et le worker répartit la réponse sur les lignes créées
 *   ici. Deux clics sur « Générer » ne paient pas deux fois : la file déduplique
 *   sur `(angle, mode, cibles)` (docs/03 §14.1).
 *
 * L'ordre est celui qui évite les écritures inutiles : `assertBriefApproved` et
 * `contentContext` refusent une fiche non validée, un angle non choisi ou un
 * sujet d'un autre projet **avant** qu'une seule ligne ne soit créée. Un job qui
 * échoue est visible ; une ligne de contenu orpheline, non.
 */
export async function enqueueContentGeneration(
  deps: EditorialFeatureDeps,
  request: ContentGenerationRequest,
): Promise<ContentGenerationResult> {
  assertBriefApproved(deps.ports, request.projectId);

  const context = contentContext(deps.ports, {
    projectId: request.projectId,
    angleId: request.angleId,
  });

  const items = createContentItems(deps.ports, {
    projectId: request.projectId,
    subjectId: context.subject.id,
    angleId: context.angle.id,
    targets: request.targets,
  });

  const only = items.length === 1 ? (items[0]?.id ?? null) : null;
  const jobId = await deps.queue.enqueue(GENERATE_CONTENT_JOB, {
    projectId: request.projectId,
    angleId: context.angle.id,
    targets: items.map((item) => item.target),
    mode: 'initial' as const,
    contentItemId: only,
    instruction: null,
  });

  deps.logger.info(
    {
      projectId: request.projectId,
      angleId: context.angle.id,
      items: items.length,
      jobId,
    },
    'génération de contenus mise en file',
  );

  return { items, jobId };
}

/**
 * « Régénérer » — une nouvelle version du contenu désigné, jamais un écrasement.
 *
 * Trois gardes, toutes **avant** la mise en file, parce qu'un job qui échoue
 * coûte une tentative de plus qu'un refus :
 *
 * 1. le contenu existe ;
 * 2. il n'est ni archivé ni au plafond de régénérations
 *    (`assertRegenerationAllowed`, docs/05 §4.3) ;
 * 3. la fiche maître est toujours validée — régénérer sur une fiche retombée en
 *    brouillon écrirait un texte que personne ne peut approuver.
 *
 * Le job ne porte **qu'une** cible : c'est la cible du contenu désigné. Le
 * rédacteur ne voit donc jamais les autres plateformes, et ne peut pas les
 * réécrire au passage (docs/05 §4.4, borne 1).
 */
export async function enqueueContentRegeneration(
  deps: EditorialFeatureDeps,
  request: ContentRegenerationRequest,
): Promise<ContentRegenerationResult> {
  const item = deps.ports.store.getContentItem(request.contentItemId);
  if (!item) {
    throw new NotFoundError(`Contenu introuvable : ${request.contentItemId}`, {
      code: 'CONTENT_NOT_FOUND',
      details: { itemId: request.contentItemId },
    });
  }

  assertRegenerationAllowed(item);
  assertBriefApproved(deps.ports, item.projectId);

  if (!item.angleId) {
    throw new ValidationError(
      `Le contenu ${item.id} n’a pas d’angle : impossible de le réécrire depuis sa source.`,
      { code: 'CONTENT_MISSING_ANGLE', details: { itemId: item.id } },
    );
  }
  const angle = deps.ports.store.getAngle(item.angleId);
  if (!angle) {
    throw new NotFoundError(`Angle introuvable : ${item.angleId}`, {
      code: 'ANGLE_NOT_FOUND',
      details: { angleId: item.angleId, itemId: item.id },
    });
  }

  const jobId = await deps.queue.enqueue(GENERATE_CONTENT_JOB, {
    projectId: item.projectId,
    angleId: angle.id,
    targets: [item.target],
    mode: 'regenerated' as const,
    contentItemId: item.id,
    instruction: request.instruction ?? null,
  });

  deps.logger.info(
    {
      projectId: item.projectId,
      contentItemId: item.id,
      target: item.target,
      jobId,
    },
    'régénération ciblée mise en file',
  );

  return { item, jobId };
}
