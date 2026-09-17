import { PLATFORM_WRITER_AGENT, buildMemoryPack, type PlatformWriterRetry } from '@aia/ai';
import {
  REGENERATION_ATTEMPTS_PER_TARGET,
  assertBriefApproved,
  contentContext,
  needsRegeneration,
  pickDraft,
  planRegeneration,
  recordDraft,
  unexpectedTargets,
  validateDraft,
  writerMemorySource,
  type ContentItem,
  type ContentVersion,
  type DraftValidation,
  type EditorialPorts,
  type NewReviewNoteRecord,
  type ProjectMemoryPorts,
} from '@aia/core';
import { getLlmCall, type DatabaseHandle } from '@aia/database';
import type { AppLogger } from '@aia/observability';
import type { GenerateContentInput, JobContext, JobHandler } from '@aia/queue';
import {
  NotFoundError,
  ValidationError,
  contentTargetSpec,
  sortContentTargets,
  toAppError,
  type ContentTarget,
  type TargetDraft,
} from '@aia/shared';
import {
  WRITER_AUTHOR,
  buildWriterInput,
  createPlatformWriter,
  type PlatformWriterDeps,
} from '../features/platform-writer';

/**
 * Le job `generate_content` : la rédaction, côté worker (docs/05 §4.3).
 *
 * C'est **le** job qui dépense : un appel peut écrire cinq textes longs. Trois
 * principes le gouvernent, et ils sont dans cet ordre :
 *
 * 1. **on refuse avant de payer.** La fiche maître doit être validée, l'angle
 *    choisi, les prompts présents, les lignes de contenu créées. Chaque refus
 *    arrive avant l'appel au modèle ;
 * 2. **le domaine décide, le handler exécute.** La couverture du lot
 *    (`pickDraft`), le contrôle de forme (`validateDraft`), la borne de
 *    réécriture (`planRegeneration`), les transitions d'état : tout est dans
 *    `@aia/core`. Ici, on assemble un contexte, on appelle, on écrit ;
 * 3. **rien n'est silencieux.** Une cible manquante fait échouer le job, une
 *    cible inventée par le modèle est journalisée et jetée, un texte hors
 *    format est **conservé** avec ses remarques (docs/05 §4.4).
 *
 * Le découpage suit les sous-étapes nommées de docs/05 §4.3 — `build_context`,
 * `write_initial`, `validate_shapes`, `write_retry`, `enforce_blocking` — parce
 * que ce sont elles que l'interface affiche et que la reprise lit.
 */

export interface GenerateContentHandlerDeps {
  handle: DatabaseHandle;
  memory: ProjectMemoryPorts;
  ports: EditorialPorts;
  logger: AppLogger;
  /**
   * Le rédacteur : modèle, température, dossier de prompts, fabrique de
   * fournisseur (enregistré, avec veto de budget). Le handler ne connaît ni clé
   * d'API, ni fournisseur : la racine de composition décide (docs/02 §5).
   */
  writer: Omit<PlatformWriterDeps, 'handle'>;
}

/** Ce qui s'est écrit pour une cible : le résultat visible d'un appel. */
export interface DraftReport {
  itemId: string;
  target: ContentTarget;
  versionId: string;
  versionNumber: number;
  /** `false` : la version existait déjà (reprise d'un job interrompu), elle n'a pas été repayée. */
  written: boolean;
  /** Problèmes bloquants restants après la passe de réécriture (0 = le texte passe). */
  blocking: number;
  warnings: number;
}

export interface GenerateContentOutput {
  projectId: string;
  angleId: string;
  mode: GenerateContentInput['mode'];
  targets: ContentTarget[];
  drafts: DraftReport[];
  /** Les cibles réécrites après un contrôle de forme en échec. */
  retried: ContentTarget[];
  /** Les clés produites sans être demandées : jamais écrites, seulement signalées. */
  unexpected: string[];
  /** Empreinte combinée des prompts du dernier appel → `prompt_version_hash`. */
  promptVersionHash: string;
  promptFiles: string[];
  model: string;
  /** `true` : la sortie a nécessité une réparation ; un taux élevé = prompt à revoir. */
  repaired: boolean;
}

/** Une version écrite pendant ce job, avec le contrôle qui va avec. */
interface WrittenDraft {
  item: ContentItem;
  version: ContentVersion;
  validation: DraftValidation;
  written: boolean;
}

/**
 * Le brouillon relu depuis une version stockée.
 *
 * Le contrôle de forme est une **fonction du texte** : on peut donc recontrôler
 * une version déjà écrite sans rien payer. C'est ce qui rend la reprise possible
 * — un job interrompu après l'écriture ne réécrit pas, mais sait quand même quoi
 * corriger (docs/05 §4.3, sous-étape 2).
 */
function draftOfVersion(version: ContentVersion): TargetDraft {
  return {
    title: version.title,
    hook: version.hook ?? '',
    body: version.body,
    hashtags: [...version.hashtags],
    mentions: [...version.mentions],
    notes: [],
  };
}

/**
 * Le contenu d'une régénération demandée par l'utilisateur : **un** contenu
 * exact, celui sur lequel il a cliqué, et **une** cible.
 *
 * Trois vérifications, toutes locales, parce qu'un job peut être repris
 * longtemps après sa mise en file : le contenu existe, il appartient bien à ce
 * projet et à cet angle, et la cible demandée est la sienne. C'est ce qui
 * interdit de réécrire au passage une plateforme que personne n'a demandée
 * (docs/05 §4.4, borne 1).
 */
function regenerationTarget(
  ports: EditorialPorts,
  input: GenerateContentInput,
  targets: readonly ContentTarget[],
): ContentItem {
  const contentItemId = input.contentItemId;
  if (!contentItemId) {
    throw new ValidationError(
      'Un job `regenerated` doit désigner le contenu à réécrire (`contentItemId`) : une cible seule ne dit pas quel contenu réécrire.',
      {
        code: 'CONTENT_ITEM_REQUIRED',
        details: { projectId: input.projectId, angleId: input.angleId },
      },
    );
  }

  const item = ports.store.getContentItem(contentItemId);
  if (!item || item.projectId !== input.projectId || item.angleId !== input.angleId) {
    throw new NotFoundError(`Contenu introuvable dans ce projet et cet angle : ${contentItemId}`, {
      code: 'CONTENT_NOT_FOUND',
      details: { itemId: contentItemId, projectId: input.projectId, angleId: input.angleId },
    });
  }

  const target = targets[0];
  if (targets.length !== 1 || target !== item.target) {
    throw new ValidationError(
      `Une régénération ne porte que sur une cible, celle du contenu : ${targets.length} cible(s) reçue(s) pour un contenu « ${item.target} ».`,
      {
        code: 'REGENERATION_TARGET_MISMATCH',
        details: { itemId: item.id, target: item.target, targets },
      },
    );
  }

  return item;
}

/** La version courante d'un contenu, ou `null` : le contenu est encore vide. */
function currentVersionOf(ports: EditorialPorts, item: ContentItem): ContentVersion | null {
  return item.currentVersionId ? ports.store.getVersion(item.currentVersionId) : null;
}

/**
 * La version a-t-elle été écrite par **ce** job ?
 *
 * C'est la seule question qui distingue « reprise d'un job interrompu » de
 * « version précédente qu'on vient régénérer » — et les deux se ressemblent :
 * dans les deux cas, le contenu a une version courante. Le lien passe par
 * `llm_calls.job_id`, jamais par une supposition sur l'ancienneté.
 */
function writtenByJob(
  handle: DatabaseHandle,
  version: ContentVersion | null,
  jobId: string,
): boolean {
  if (!version?.llmCallId) return false;
  return getLlmCall(handle, version.llmCallId)?.job_id === jobId;
}

/**
 * Les lignes `content_items` d'un lot **initial**, une par cible.
 *
 * L'API les a créées **avant** la mise en file (docs/05 §4.3) : le job ne crée
 * rien, il remplit. Par cible, on prend la ligne non archivée la plus récente —
 * la file dédupliquant un lot, c'est celle de ce lot. Une absence est une
 * incohérence, pas un cas normal : elle échoue bruyamment, avant tout appel.
 */
function batchItems(
  ports: EditorialPorts,
  input: GenerateContentInput,
  targets: readonly ContentTarget[],
): ContentItem[] {
  const byAngle = ports.store.listContentItemsByAngle(input.angleId);

  return targets.map((target) => {
    const candidates = byAngle
      .filter(
        (item) =>
          item.projectId === input.projectId && item.target === target && item.state !== 'archived',
      )
      .sort((left, right) => right.createdAt - left.createdAt || (right.id > left.id ? 1 : -1));

    const item = candidates[0];
    if (!item) {
      throw new ValidationError(
        `Aucun contenu à écrire pour « ${contentTargetSpec(target).label} » : la ligne n’a pas été créée avant la mise en file.`,
        { code: 'CONTENT_ITEM_MISSING', details: { angleId: input.angleId, target } },
      );
    }
    return item;
  });
}

interface WriteDraftInput {
  item: ContentItem;
  draft: TargetDraft;
  generation: GenerateContentInput['mode'];
  promptVersionHash: string;
  llmCallId: string | null;
  modelUsed: string | null;
  temperatureX100: number | null;
  contextFingerprint: string | null;
  notes?: readonly NewReviewNoteRecord[];
}

/**
 * Écrit **une** version, ou n'écrit rien si ce job l'a déjà écrite.
 *
 * La seconde branche est la reprise : un job repris après une interruption ne
 * repaie pas un appel déjà payé (docs/05 §4.3, « déjà écrite → sautée »). On
 * recontrôle alors le texte stocké — `validateDraft` est une fonction du texte,
 * donc gratuite — pour savoir s'il reste quelque chose à réécrire.
 */
function writeDraft(
  deps: GenerateContentHandlerDeps,
  input: WriteDraftInput,
  jobId: string,
): WrittenDraft {
  const existing = currentVersionOf(deps.ports, input.item);
  if (existing && writtenByJob(deps.handle, existing, jobId)) {
    return {
      item: input.item,
      version: existing,
      validation: validateDraft(input.item.target, draftOfVersion(existing)),
      written: false,
    };
  }

  const recorded = recordDraft(deps.ports, {
    item: input.item,
    draft: input.draft,
    generation: input.generation,
    promptVersionHash: input.promptVersionHash,
    llmCallId: input.llmCallId,
    modelUsed: input.modelUsed,
    temperatureX100: input.temperatureX100,
    contextFingerprint: input.contextFingerprint,
    author: WRITER_AUTHOR,
    ...(input.notes && input.notes.length > 0 ? { extraNotes: [...input.notes] } : {}),
  });

  return {
    item: recorded.item,
    version: recorded.version,
    validation: recorded.validation,
    written: true,
  };
}

/** L'empreinte du contexte telle qu'elle a été journalisée pour cet appel. */
function contextFingerprintOf(handle: DatabaseHandle, callId: string | null): string | null {
  return callId ? (getLlmCall(handle, callId)?.context_fingerprint ?? null) : null;
}

function hasBlockingIssues(validation: DraftValidation): boolean {
  return needsRegeneration([validation]).length > 0;
}

/** Un refus du domaine (plafond atteint, contenu archivé) se dit, il ne se cache pas. */
async function emitRefusal(ctx: JobContext, entry: WrittenDraft, error: unknown): Promise<void> {
  await ctx.emitEvent({
    step: 'write_retry',
    level: 'warn',
    message: `réécriture refusée par le domaine : ${toAppError(error).message}`,
    data: { itemId: entry.item.id, target: entry.item.target, versionId: entry.version.id },
  });
}

/**
 * Le handler du job (docs/05 §4.3).
 *
 * La spécification du job (tentatives, lease, clé de déduplication) n'est pas
 * ici : elle est dans `@aia/queue`, partagée avec l'API qui met le job en file.
 * Un worker qui recopierait ces valeurs finirait par ne plus produire le même
 * job que celui que l'API a écrit.
 */
export function createGenerateContentHandler(
  deps: GenerateContentHandlerDeps,
): JobHandler<GenerateContentInput, GenerateContentOutput> {
  const writerDeps: PlatformWriterDeps = { handle: deps.handle, ...deps.writer };

  return async (input, ctx) => {
    // --- 1. build_context : tout ce qui peut refuser, avant de payer -------
    await ctx.setStep('build_context', 10);

    // La fiche maître peut être retombée en brouillon depuis la mise en file :
    // écrire sous une fiche non validée produirait un texte que personne ne peut
    // approuver.
    assertBriefApproved(deps.ports, input.projectId);

    const context = contentContext(deps.ports, {
      projectId: input.projectId,
      angleId: input.angleId,
    });
    // La **même** mémoire que l'entretien et le plan : une seule sélection de
    // faits, donc un texte qui ne peut pas contredire le plan qui l'a demandé.
    const memoryPack = buildMemoryPack(writerMemorySource(deps.memory, input.projectId));

    const targets = sortContentTargets(input.targets);
    if (targets.length === 0) {
      throw new ValidationError('Aucune cible demandée : rien à écrire.', {
        code: 'NO_CONTENT_TARGET',
        details: { projectId: input.projectId, angleId: input.angleId },
      });
    }

    const items: ContentItem[] = [];
    const userRetries: PlatformWriterRetry[] = [];
    /** Renseigné seulement en régénération : un appel ne porte alors qu'un contenu. */
    let singleItem: ContentItem | null = null;

    if (input.mode === 'regenerated') {
      const item = regenerationTarget(deps.ports, input, targets);
      items.push(item);
      singleItem = item;

      // On repart du texte refusé : le modèle corrige au lieu de réinventer, et
      // la consigne de l'utilisateur part telle quelle, sans reformulation
      // (docs/04 §4.3).
      const previous = currentVersionOf(deps.ports, item);
      if (previous) {
        userRetries.push({
          target: item.target,
          reason: input.instruction ?? 'L’utilisateur demande une nouvelle version de ce texte.',
          previousBody: previous.body,
        });
      }
    } else {
      items.push(...batchItems(deps.ports, input, targets));
    }

    // Les prompts du lot, lus en base : un lot sans sa section de plateforme
    // échoue ici, pas au milieu d'un appel payant.
    const bundle = createPlatformWriter(writerDeps, ctx, {
      projectId: input.projectId,
      targets,
    });
    const writerInput = buildWriterInput(context, memoryPack, {
      targets,
      ...(userRetries.length > 0 ? { retries: userRetries } : {}),
    });
    const estimate = bundle.agent.estimateTokens(writerInput);

    await ctx.emitEvent({
      step: 'build_context',
      message: `contexte assemblé : ${targets.length} cible(s), ≈${estimate.input} jetons d’entrée`,
      data: {
        targets,
        promptFiles: bundle.promptFiles,
        promptVersionHash: bundle.promptVersionHash,
        estimate,
      },
    });

    // --- 2. write_initial : un appel pour tout le lot ----------------------
    await ctx.setStep('write_initial', 40);

    const result = await bundle.agent.run(writerInput, {
      callContext: {
        projectId: input.projectId,
        subjectId: context.subject.id,
        ...(singleItem ? { contentId: singleItem.id } : {}),
        agent: PLATFORM_WRITER_AGENT,
        task: bundle.agent.task,
        jobId: ctx.jobId,
        promptVersionId: bundle.prompts.rules.promptVersionId,
      },
      signal: ctx.signal,
    });

    const callId = bundle.lastCallId();
    const contextFingerprint = contextFingerprintOf(deps.handle, callId);

    // --- 3. validate_shapes, puis écriture ---------------------------------
    await ctx.setStep('validate_shapes', 65);

    // La couverture d'abord, et elle lève si une cible manque : **rien** n'est
    // écrit avant que le lot soit complet. Trois contenus sur quatre ne sont pas
    // un résultat acceptable (docs/05 §4.3).
    const pending = items.map((item) => ({
      item,
      draft: pickDraft(result.output, item.target),
    }));

    const unexpected = unexpectedTargets(result.output, targets);
    if (unexpected.length > 0) {
      await ctx.emitEvent({
        step: 'validate_shapes',
        level: 'warn',
        message: `cibles produites sans être demandées, ignorées : ${unexpected.join(', ')}`,
        data: { unexpected },
      });
    }

    const written = pending.map((entry) =>
      writeDraft(
        deps,
        {
          item: entry.item,
          draft: entry.draft,
          generation: input.mode,
          promptVersionHash: bundle.promptVersionHash,
          llmCallId: callId,
          modelUsed: result.usage.model,
          temperatureX100: bundle.temperatureX100,
          contextFingerprint,
        },
        ctx.jobId,
      ),
    );

    // --- 4. write_retry : une passe, ciblée, bornée par le domaine ---------
    //
    // La borne n'est pas décidée ici : `REGENERATION_ATTEMPTS_PER_TARGET` est une
    // règle du produit, et `planRegeneration` la fait respecter (contenu non
    // archivé, plafond par contenu). Le handler ne fait que lui obéir.
    const retried: ContentTarget[] = [];
    let round = 0;
    let failing = written.filter((entry) => hasBlockingIssues(entry.validation));

    while (failing.length > 0 && round < REGENERATION_ATTEMPTS_PER_TARGET) {
      round += 1;
      await ctx.setStep('write_retry', 80);

      const retryTargets: ContentTarget[] = [];
      const retries: PlatformWriterRetry[] = [];
      const notesByItem = new Map<string, readonly NewReviewNoteRecord[]>();

      for (const entry of failing) {
        try {
          const plan = planRegeneration(deps.ports, entry.item.id, [entry.validation]);
          const target = plan.targets[0];
          if (!target) continue;

          retryTargets.push(target);
          retries.push({
            target,
            reason: plan.reasons[0] ?? 'Texte hors format : réécrire pour la cible concernée.',
            previousBody: entry.version.body,
          });
          notesByItem.set(entry.item.id, plan.notes);
        } catch (error) {
          // Plafond atteint, contenu archivé entre-temps : on ne réécrit pas, on
          // le dit. Le texte reste présenté avec ses remarques, et c'est
          // l'utilisateur qui tranche (docs/05 §4.4).
          await emitRefusal(ctx, entry, error);
        }
      }

      if (retryTargets.length === 0) break;

      const retryBundle = createPlatformWriter(writerDeps, ctx, {
        projectId: input.projectId,
        targets: retryTargets,
      });
      const retryResult = await retryBundle.agent.run(
        buildWriterInput(context, memoryPack, { targets: retryTargets, retries }),
        {
          callContext: {
            projectId: input.projectId,
            subjectId: context.subject.id,
            ...(singleItem ? { contentId: singleItem.id } : {}),
            agent: PLATFORM_WRITER_AGENT,
            task: retryBundle.agent.task,
            jobId: ctx.jobId,
            promptVersionId: retryBundle.prompts.rules.promptVersionId,
          },
          signal: ctx.signal,
        },
      );
      const retryCallId = retryBundle.lastCallId();
      const retryFingerprint = contextFingerprintOf(deps.handle, retryCallId);

      // Les brouillons d'abord — une cible absente lève —, l'écriture ensuite :
      // jamais un lot écrit à moitié.
      const redrafts = failing.map((entry) => ({
        entry,
        draft: pickDraft(retryResult.output, entry.item.target),
      }));
      const indexByItem = new Map(written.map((entry, index) => [entry.item.id, index] as const));

      for (const { entry, draft } of redrafts) {
        const updated = writeDraft(
          deps,
          {
            item: entry.item,
            draft,
            generation: 'regenerated',
            promptVersionHash: retryBundle.promptVersionHash,
            llmCallId: retryCallId,
            modelUsed: retryResult.usage.model,
            temperatureX100: retryBundle.temperatureX100,
            contextFingerprint: retryFingerprint,
            notes: notesByItem.get(entry.item.id) ?? [],
          },
          ctx.jobId,
        );

        const index = indexByItem.get(entry.item.id);
        if (index !== undefined) written[index] = updated;
        retried.push(entry.item.target);
      }

      failing = written.filter((entry) => hasBlockingIssues(entry.validation));
    }

    // --- Rapport -----------------------------------------------------------
    //
    // `enforce_blocking` (docs/05 §4.3) n'a pas son mot à dire ici : les états de
    // `content_items` sont écrits par `recordDraft`, dans la même transaction que
    // la version. Un texte qui garde un problème bloquant n'est pas caché — il est
    // écrit, puis signalé, et c'est l'utilisateur qui tranche.
    const reports: DraftReport[] = written.map((entry) => ({
      itemId: entry.item.id,
      target: entry.item.target,
      versionId: entry.version.id,
      versionNumber: entry.version.versionNumber,
      written: entry.written,
      blocking: entry.validation.blocking.length,
      warnings: entry.validation.warnings.length,
    }));

    deps.logger.info(
      {
        jobId: ctx.jobId,
        projectId: input.projectId,
        angleId: input.angleId,
        mode: input.mode,
        targets,
        written: reports.filter((report) => report.written).length,
        retried,
        blocking: reports.reduce((total, report) => total + report.blocking, 0),
        model: result.usage.model,
        repaired: result.repaired,
      },
      'contenus rédigés',
    );

    return {
      projectId: input.projectId,
      angleId: input.angleId,
      mode: input.mode,
      targets: [...targets],
      drafts: reports,
      retried,
      unexpected,
      promptVersionHash: bundle.promptVersionHash,
      promptFiles: bundle.promptFiles,
      model: result.usage.model,
      repaired: result.repaired,
    };
  };
}
