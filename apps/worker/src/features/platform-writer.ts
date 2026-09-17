import {
  PLATFORM_WRITER_AGENT,
  PLATFORM_WRITER_RULES_TASK,
  createPlatformWriterAgent,
  loadActivePrompt,
  platformWriterPromptHash,
  platformWriterPromptSources,
  type Agent,
  type LLMProvider,
  type MemoryPack,
  type PlatformWriterAngle,
  type PlatformWriterInput,
  type PlatformWriterRetry,
  type PlatformWriterSubject,
  type PromptSource,
} from '@aia/ai';
import type { ContentContext, ContentSubject, SubjectAngle } from '@aia/core';
import type { DatabaseHandle } from '@aia/database';
import type { JobContext } from '@aia/queue';
import { ValidationError, type ContentDraftsOutput, type ContentTarget } from '@aia/shared';

/**
 * Le **pont** entre le domaine éditorial et l'agent `platform_writer`, côté
 * worker (docs/02 §5).
 *
 * Comme `apps/api/src/features/agents.ts`, ce fichier ne contient aucune règle
 * métier : il traduit des objets du domaine en entrée d'agent, et il choisit les
 * prompts. Trois décisions y sont écrites, et elles sont toutes vérifiables :
 *
 * 1. **les prompts sont lus en base, jamais recopiés dans le code** : `rules.md`
 *    plus une section par cible demandée. Un lot sans sa section ne part pas ;
 * 2. **le contexte envoyé au modèle est la mémoire du projet**, pas la
 *    conversation : ce qui n'est pas un fait confirmé n'entre pas dans le prompt ;
 * 3. **le rédacteur est construit par appel, pas par processus** : chaque appel a
 *    son fournisseur enregistré, son identifiant d'appel et son empreinte de
 *    prompts — c'est ce qui rend un lot traçable ligne à ligne.
 */

/** Le nom de l'auteur des remarques du modèle dans `content_review_notes`. */
export const WRITER_AUTHOR = PLATFORM_WRITER_AGENT;

export interface WriterPromptSet {
  rules: PromptSource;
  /** Une section par cible **demandée** : les autres plateformes ne sont pas payées. */
  targets: Partial<Record<ContentTarget, PromptSource>>;
}

/**
 * Charge les prompts actifs d'un lot : les règles d'abord, puis la section de
 * chaque cible demandée.
 *
 * L'échec est **immédiat** — avant l'appel, donc avant la dépense. Un lot qui
 * partirait sans la section « LinkedIn » produirait un texte Linkedin générique,
 * et ce serait payant : mieux vaut un job en échec, visible, qu'un texte
 * silencieusement hors sujet.
 */
export function loadWriterPrompts(
  handle: DatabaseHandle,
  promptsDir: string,
  targets: readonly ContentTarget[],
): WriterPromptSet {
  const rules = loadActivePrompt(
    handle,
    promptsDir,
    PLATFORM_WRITER_AGENT,
    PLATFORM_WRITER_RULES_TASK,
  );
  if (!rules) {
    throw new ValidationError(
      `Prompt actif introuvable : ${PLATFORM_WRITER_AGENT}/${PLATFORM_WRITER_RULES_TASK}. Vérifier ${promptsDir} et redémarrer le worker.`,
      {
        code: 'PROMPT_MISSING',
        details: { agent: PLATFORM_WRITER_AGENT, task: PLATFORM_WRITER_RULES_TASK },
      },
    );
  }

  const sections: Partial<Record<ContentTarget, PromptSource>> = {};
  for (const target of targets) {
    const section = loadActivePrompt(handle, promptsDir, PLATFORM_WRITER_AGENT, target);
    if (!section) {
      throw new ValidationError(
        `Prompt actif introuvable : ${PLATFORM_WRITER_AGENT}/${target}. La génération ne part pas sans ses règles de plateforme.`,
        { code: 'PROMPT_MISSING', details: { agent: PLATFORM_WRITER_AGENT, target } },
      );
    }
    sections[target] = section;
  }

  return { rules, targets: sections };
}

/** Le sujet, tel que le rédacteur le voit : ni plus, ni moins. */
export function writerSubject(subject: ContentSubject): PlatformWriterSubject {
  return { title: subject.title, thesis: subject.thesis, pillar: subject.pillar };
}

/**
 * L'angle, traduit pour le prompt.
 *
 * Deux champs du domaine sont optionnels (`difficulty`, `estimatedLength`) alors
 * que le rédacteur les attend : on écrit explicitement « non précisé » plutôt que
 * d'inventer une valeur. Un modèle qui reçoit « difficile » sans que personne ne
 * l'ait dit écrit plus long, et l'écart devient invisible.
 */
export function writerAngle(angle: SubjectAngle): PlatformWriterAngle {
  return {
    hook: angle.hook,
    angleType: angle.angleType,
    structure: [...angle.structure],
    evidence: [...angle.evidence],
    difficulty: angle.difficulty ?? 'non précisée',
    estimatedLength: angle.estimatedLength ?? 'non précisée',
    // `all` signifie « toutes les plateformes » : ce n'est pas un indice de
    // plateforme, donc on n'en envoie aucun.
    platformHint: angle.platform === 'all' ? null : angle.platform,
    rationale: angle.rationale ?? '',
  };
}

export interface WriterRequest {
  /** Les cibles concernées : toutes pour un lot initial, la seule cible fautive sinon. */
  targets: readonly ContentTarget[];
  /** Les réécritures ciblées, avec le reproche et le texte précédent. */
  retries?: readonly PlatformWriterRetry[];
}

export function buildWriterInput(
  context: ContentContext,
  memoryPack: MemoryPack,
  request: WriterRequest,
): PlatformWriterInput {
  return {
    memoryPack,
    subject: writerSubject(context.subject),
    angle: writerAngle(context.angle),
    targets: request.targets,
    ...(request.retries && request.retries.length > 0 ? { retries: request.retries } : {}),
  };
}

export interface WriterProviderRequest {
  projectId: string;
  /** Version du prompt de **règles** : le prompt principal de l'appel, donc sa trace. */
  promptVersionId: string;
}

export interface WriterProviderBundle {
  provider: LLMProvider;
  /** Identifiant de la ligne `llm_calls` écrite par cet appel (traçabilité). */
  lastCallId(): string | null;
}

/** Fabrique du fournisseur, injectée par la racine de composition. */
export type WriterProviderFactory = (
  ctx: JobContext,
  request: WriterProviderRequest,
) => WriterProviderBundle;

export interface PlatformWriterDeps {
  handle: DatabaseHandle;
  promptsDir: string;
  /** Modèle du rédacteur (palier `standard`) : journalisé sur le job et la version. */
  model: string;
  temperature: number;
  createProvider: WriterProviderFactory;
}

export interface PlatformWriterBundle {
  agent: Agent<PlatformWriterInput, ContentDraftsOutput>;
  prompts: WriterPromptSet;
  /**
   * Empreinte combinée des prompts du lot → `content_versions.prompt_version_hash`.
   * Un lot qui change de prompt pour une seule plateforme change d'empreinte.
   */
  promptVersionHash: string;
  /** Les fichiers de prompts du lot : ce qui est journalisé et relu en cas de doute. */
  promptFiles: string[];
  model: string;
  temperatureX100: number;
  lastCallId(): string | null;
}

/**
 * Construit le rédacteur d'**un** appel : prompts du lot, fournisseur enregistré,
 * agent configuré.
 *
 * Un bundle par appel, jamais un agent partagé : une régénération ciblée est un
 * second appel, avec ses propres prompts (la seule cible fautive), sa propre
 * ligne `llm_calls` et sa propre empreinte. Un agent réutilisé ferait porter à la
 * seconde version la trace de la première.
 */
export function createPlatformWriter(
  deps: PlatformWriterDeps,
  ctx: JobContext,
  request: { projectId: string; targets: readonly ContentTarget[] },
): PlatformWriterBundle {
  const prompts = loadWriterPrompts(deps.handle, deps.promptsDir, request.targets);
  // Lève `PROMPT_MISSING` si une cible demandée n'a pas de section : la même
  // vérification que celle utilisée pour l'empreinte, donc jamais deux verdicts.
  const sources = platformWriterPromptSources(prompts.rules, prompts.targets, request.targets);

  const provider = deps.createProvider(ctx, {
    projectId: request.projectId,
    promptVersionId: prompts.rules.promptVersionId,
  });

  return {
    agent: createPlatformWriterAgent({
      provider: provider.provider,
      rules: prompts.rules,
      targets: prompts.targets,
      temperature: deps.temperature,
    }),
    prompts,
    promptVersionHash: platformWriterPromptHash(sources),
    promptFiles: sources.map((source) => source.filePath),
    model: deps.model,
    temperatureX100: Math.round(deps.temperature * 100),
    lastCallId: provider.lastCallId,
  };
}
