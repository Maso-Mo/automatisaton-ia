import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type {
  MediaAssetRecord,
  MediaStore,
  VideoRenderRecord,
  VideoRenderStore,
} from '@aia/database';
import {
  assertSupportedVideoProbe,
  defaultRenderPlan,
  detectVideoContainer,
  formatMs,
  hasSpeechInWindow,
  renderPlanWarnings,
  validateRenderPlan,
  videoStorageKey,
  VERTICAL_FORMAT,
  type FFmpegRunner,
  type MediaProbe,
  type StorageAdapter,
} from '@aia/media';
import type { Agent, LLMUsage, MediaPlannerInput } from '@aia/ai';
import type { EditorialPorts } from '@aia/core';
import { RENDER_VIDEO_JOB, type Queue } from '@aia/queue';
import type { AppLogger } from '@aia/observability';
import {
  NotFoundError,
  ValidationError,
  uuidv7,
  type Clock,
  type RenderPlanProposal,
  type StoredRenderPlan,
} from '@aia/shared';

/**
 * Module vidéo de l'API (étape 7) : **importer**, **proposer**, **valider**,
 * **suivre**. Le rendu lui-même n'est pas ici — il est un job du worker
 * (docs/02 §5 : l'API écrit le job, le worker l'exécute).
 *
 * Trois frontières sont tenues par ce module :
 *
 * 1. **le type réel d'abord** : une vidéo est reconnue par son contenu
 *    (`detectVideoContainer`) puis par ce que `ffprobe` en dit, jamais par son
 *    extension ni par ce que le client annonce (docs/05 §5.1) ;
 * 2. **un codec non pris en charge est une erreur nommée** (H.264 seul à cette
 *    étape) : aucune conversion silencieuse, aucun rendu au hasard ;
 * 3. **le plan est proposé, jamais exécuté** : `media_planner` propose,
 *    l'utilisateur modifie et valide, **puis** la ligne `video_renders` et le job
 *    sont créés. Un plan invalide n'empêche personne de travailler : il est
 *    remplacé par un plan calculé en code (`defaultRenderPlan`), et la provenance
 *    du plan choisi est conservée (`source`).
 */

export interface MediaPlannerAgentLike {
  agent: Agent<MediaPlannerInput, RenderPlanProposal>;
  prompt: { promptVersionId: string; filePath: string };
  lastCallId(): string | null;
}

export interface VideoFeatureDeps {
  media: MediaStore;
  renders: VideoRenderStore;
  /** Le contenu approuvé auquel le rendu sera rattaché (ports du domaine). */
  ports: EditorialPorts;
  storage: StorageAdapter;
  ffmpeg: FFmpegRunner;
  /**
   * L'agent de montage — **optionnel**, et son appel n'est pas supposé réussir :
   * sans lui (ou sans prompt actif, ou sans clé de fournisseur), le plan est
   * calculé en code. La signature le dit : `undefined` est un cas normal.
   */
  planner?(): MediaPlannerAgentLike | undefined;
  performanceGuidance?(projectId: string, target: string): string[];
  /** La file, en **écriture seule** : l'API n'exécute rien. */
  queue: Pick<Queue, 'enqueue'>;
  logger: AppLogger;
  clock: Clock;
  /** Bornes du produit, lues dans la configuration (`VIDEO_MAX_CLIP_S`). */
  maxClipMs: number;
  /** Durée maximale d'une vidéo source (`MEDIA_MAX_DURATION_S`). */
  maxVideoDurationMs: number;
}

/** Le poids maximal d'une source : la même limite que le téléversement déclaré. */
export type VideoUploadInput = {
  projectId: string;
  bytes: Uint8Array;
  declaredMime: string;
  maxUploadBytes: number;
};

export interface UploadedVideo {
  asset: MediaAssetRecord;
  probe: MediaProbe;
  /** Vrai si l'asset existait déjà (même empreinte) : rien n'a été réécrit. */
  deduplicated: boolean;
  warnings: string[];
}

/**
 * Importe une **vidéo source** : contenu reconnu, `ffprobe` interrogé, fichier
 * écrit sous une clé fabriquée par le serveur, asset dédupliqué par empreinte.
 *
 * La déduplication est la même que pour l'audio : envoyer deux fois la même vidéo
 * ne la stocke qu'une fois. Le fichier est écrit **avant** la ligne, et la ligne
 * est retirée si l'écriture échoue — jamais l'inverse (aucun asset fantôme).
 */
export async function uploadVideo(
  deps: VideoFeatureDeps,
  input: VideoUploadInput,
): Promise<UploadedVideo> {
  if (input.bytes.byteLength === 0) {
    throw new ValidationError('Un fichier vidéo non vide est requis.', {
      code: 'VIDEO_BODY_REQUIRED',
    });
  }
  if (input.bytes.byteLength > input.maxUploadBytes) {
    throw new ValidationError(
      `Fichier trop volumineux : ${Math.round(input.bytes.byteLength / 1_048_576)} Mo (maximum ${Math.round(
        input.maxUploadBytes / 1_048_576,
      )} Mo).`,
      {
        code: 'VIDEO_TOO_LARGE',
        details: { sizeBytes: input.bytes.byteLength, maxUploadBytes: input.maxUploadBytes },
      },
    );
  }

  const container = detectVideoContainer(input.bytes, input.declaredMime);
  const hash = createHash('sha256').update(input.bytes).digest('hex');

  const existing = deps.media.assetByHash(input.projectId, hash);
  if (existing) {
    const probe = await deps.ffmpeg.probe(deps.storage.getLocalPath(existing.storageKey));
    return {
      asset: existing,
      probe,
      deduplicated: true,
      warnings: videoWarnings(probe, existing.durationMs),
    };
  }

  const assetId = uuidv7(deps.clock.nowMs());
  const storageKey = videoStorageKey(hash, assetId, container.extension, deps.clock.now());
  const target = deps.storage.getLocalPath(storageKey);
  const partPath = `${target}.${randomUUID()}.part`;

  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(partPath, input.bytes);
    const probe = await deps.ffmpeg.probe(partPath);
    assertSupportedVideoProbe(probe);
    await rename(partPath, target);

    const asset = deps.media.createVideoAsset({
      id: assetId,
      projectId: input.projectId,
      role: 'original',
      storageKey,
      // Le nom d'origine du client n'est **jamais** repris : la clé est fabriquée
      // par le serveur, donc aucune traversée de répertoire n'est possible.
      originalFilename: null,
      mimeType: container.mime,
      sizeBytes: input.bytes.byteLength,
      sha256: hash,
      width: probe.width,
      height: probe.height,
      durationMs: probe.durationMs,
      codec: probe.videoCodec,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      source: 'upload',
    });

    deps.logger.info(
      {
        projectId: input.projectId,
        assetId: asset.id,
        container: container.extension,
        codec: probe.videoCodec,
        durationMs: probe.durationMs,
        sizeBytes: input.bytes.byteLength,
      },
      'vidéo source importée',
    );

    return { asset, probe, deduplicated: false, warnings: videoWarnings(probe, probe.durationMs) };
  } catch (error) {
    await rm(partPath, { force: true });
    throw error;
  }
}

/**
 * Ce qu'il faut dire à l'utilisateur **avant** qu'il choisisse un extrait : une
 * vidéo trop longue (le rendu deviendrait dissuasif), ou sans audio (les
 * sous-titres ne pourront pas exister).
 */
export function videoWarnings(probe: MediaProbe, durationMs: number | null): string[] {
  const warnings: string[] = [];
  if (!probe.hasAudio) {
    warnings.push(
      'Cette vidéo n’a pas de piste audio : elle ne pourra pas être transcrite, donc pas sous-titrée.',
    );
  }
  if (durationMs !== null && durationMs > 30 * 60 * 1_000) {
    warnings.push('Vidéo de plus de 30 minutes : le rendu et la transcription seront longs.');
  }
  if (probe.width !== null && probe.height !== null && probe.width > probe.height) {
    warnings.push(
      'Vidéo horizontale : le format vertical recadre les côtés (recadrage centré, bords coupés).',
    );
  }
  return warnings;
}

// --- Le contenu approuvé, et la vidéo source --------------------------------

interface ApprovedContent {
  contentItemId: string;
  contentVersionId: string;
  projectId: string;
  target: string;
  body: string;
  title: string | null;
}

/**
 * Charge le contenu **approuvé** : c'est la version validée qui produit le rendu.
 *
 * Le critère n'est **pas** `state === 'approved'` mais « une version approuvée
 * existe encore » : approuver, c'est figer un texte (`approvedVersionId` +
 * `approvedAt`), et la suite de la vie du contenu ne défait pas ce fait. Un
 * contenu déjà publié reste donc montable — c'est le cas normal d'un short
 * destiné à une autre plateforme — alors qu'un contenu régénéré ou corrigé
 * depuis (le domaine remet `approvedVersionId` à `null`) ne l'est plus : le
 * montage doit correspondre au texte que quelqu'un a validé, pas à un brouillon.
 *
 * Un contenu archivé (rejeté) est refusé sans ambiguïté : on ne monte pas un
 * texte que l'utilisateur a rejeté.
 */
function approvedContent(deps: VideoFeatureDeps, contentItemId: string): ApprovedContent {
  const item = deps.ports.store.getContentItem(contentItemId);
  if (!item) {
    throw new NotFoundError(`Contenu introuvable : ${contentItemId}`, {
      code: 'CONTENT_NOT_FOUND',
      details: { contentItemId },
    });
  }
  if (item.archivedAt !== null) {
    throw new ValidationError(
      'Ce contenu est archivé : un texte rejeté ne devient pas un short. Reprendre une version approuvée.',
      { code: 'CONTENT_ARCHIVED', details: { contentItemId, state: item.state } },
    );
  }
  const version =
    item.approvedVersionId === null ? null : deps.ports.store.getVersion(item.approvedVersionId);
  if (!version || version.approvedAt === null) {
    throw new ValidationError(
      'Ce contenu n’a pas de version approuvée : approuver une version avant de préparer une vidéo (le montage et les sous-titres viennent du texte validé).',
      { code: 'CONTENT_NOT_APPROVED', details: { contentItemId, state: item.state } },
    );
  }
  return {
    contentItemId: item.id,
    contentVersionId: version.id,
    projectId: item.projectId,
    target: item.target,
    body: version.body,
    title: version.title,
  };
}

interface SourceVideo {
  asset: MediaAssetRecord;
  durationMs: number;
}

/** La vidéo source : elle doit appartenir au **même projet** que le contenu. */
function sourceVideo(
  deps: VideoFeatureDeps,
  projectId: string,
  sourceAssetId: string,
): SourceVideo {
  const asset = deps.media.asset(sourceAssetId);
  if (!asset || asset.kind !== 'video' || asset.projectId !== projectId) {
    throw new NotFoundError(`Vidéo source introuvable dans ce projet : ${sourceAssetId}`, {
      code: 'VIDEO_SOURCE_NOT_FOUND',
      details: { sourceAssetId, projectId },
    });
  }
  if (asset.durationMs === null || asset.durationMs <= 0) {
    throw new ValidationError(
      'La durée de cette vidéo est inconnue : elle ne peut pas être montée.',
      {
        code: 'VIDEO_DURATION_UNKNOWN',
        details: { sourceAssetId },
      },
    );
  }
  if (asset.durationMs > deps.maxVideoDurationMs) {
    throw new ValidationError(
      `Vidéo trop longue : ${formatMs(asset.durationMs)} (maximum ${formatMs(deps.maxVideoDurationMs)}).`,
      { code: 'VIDEO_TOO_LONG', details: { durationMs: asset.durationMs } },
    );
  }
  return { asset, durationMs: asset.durationMs };
}

// --- Proposition de plan (l'agent, ou le calcul en code) ---------------------

export interface VideoPlanRequest {
  contentItemId: string;
  sourceAssetId: string;
}

export interface VideoPlanResult {
  plan: StoredRenderPlan;
  /** Les avertissements **honnêtes** : recadrage, absence de parole, pas d'audio. */
  warnings: string[];
  /** Vrai si le plan vient du calcul déterministe et non de l'agent. */
  usedFallback: boolean;
  /** Pourquoi le repli a été utilisé (journalisé, et affiché si demandé). */
  fallbackReason: string | null;
  content: {
    contentItemId: string;
    contentVersionId: string;
    target: string;
    title: string | null;
    versionNumber: number | null;
  };
  video: {
    assetId: string;
    durationMs: number;
    width: number | null;
    height: number | null;
    hasAudio: boolean;
    codec: string | null;
  };
  transcript: { available: boolean; segments: number; language: string | null };
  policy: {
    preset: string;
    width: number;
    height: number;
    fps: number;
    container: string;
    maxClipMs: number;
    subtitleMode: 'burned';
    crop: 'vertical_center';
  };
  usage: LLMUsage | null;
  repaired: boolean;
}

/**
 * Propose un plan de montage — **sans rien créer** : ni ligne, ni job. C'est la
 * règle de docs/05 §6.3 : on montre le plan, l'utilisateur le modifie, et lui
 * seul déclenche le rendu.
 *
 * L'agent est **optionnel** et jamais indispensable : s'il est absent, s'il
 * échoue, s'il rend un plan hors bornes ou si le budget le refuse, le plan
 * calculé en code prend le relais. Un plan par défaut honnête vaut mieux qu'un
 * écran bloqué — et la provenance est écrite dans le plan stocké.
 */
export async function proposeVideoPlan(
  deps: VideoFeatureDeps,
  request: VideoPlanRequest,
): Promise<VideoPlanResult> {
  const content = approvedContent(deps, request.contentItemId);
  const source = sourceVideo(deps, content.projectId, request.sourceAssetId);
  const transcript = deps.media.transcriptForAsset(source.asset.id);

  const bounds = { sourceDurationMs: source.durationMs, maxClipMs: deps.maxClipMs };
  const segments = transcript?.segments ?? [];

  /**
   * Obtenir l'agent est lui-même une opération qui peut échouer : le prompt actif
   * peut manquer (démarrage à froid), le fournisseur peut refuser faute de clé.
   * Aucune de ces raisons ne justifie de priver l'utilisateur d'un plan : elles
   * font basculer sur le plan calculé en code, et sont **journalisées**.
   */
  let planner: MediaPlannerAgentLike | null = null;
  let plannerError: unknown = null;
  try {
    planner = deps.planner?.() ?? null;
  } catch (error) {
    plannerError = error;
  }

  let candidate: RenderPlanProposal | null = null;
  let usedFallback = false;
  let fallbackReason: string | null = null;
  let usage: LLMUsage | null = null;
  let repaired = false;

  if (plannerError !== null) {
    usedFallback = true;
    fallbackReason =
      plannerError instanceof Error
        ? `agent de montage indisponible : ${plannerError.message}`
        : 'agent de montage indisponible';
    deps.logger.warn(
      { contentItemId: content.contentItemId, err: plannerError },
      'media_planner non constructible : plan calculé en code',
    );
  } else if (planner === null) {
    usedFallback = true;
    fallbackReason = 'agent de montage non configuré : plan calculé en code';
  } else if (segments.length === 0) {
    usedFallback = true;
    fallbackReason = 'aucune transcription disponible : plan calculé en code';
  } else {
    try {
      const result = await planner.agent.run(
        {
          script: content.body,
          transcript: { text: transcript?.text ?? '', segments },
          video: {
            durationMs: source.durationMs,
            width: source.asset.width,
            height: source.asset.height,
            hasAudio: source.asset.hasAudio === true,
          },
          maxClipMs: deps.maxClipMs,
          targetLabel: content.target,
          performanceGuidance:
            deps.performanceGuidance?.(content.projectId, content.target).slice(0, 4) ?? [],
        },
        {
          callContext: {
            agent: 'media_planner',
            task: 'video_plan',
            projectId: content.projectId,
            promptVersionId: planner.prompt.promptVersionId,
          },
        },
      );
      // Les bornes réelles sont vérifiées **en code** : le schéma ne connaît pas
      // la durée de la vidéo (docs/05 §6.3).
      validateRenderPlan(result.output, bounds);
      candidate = result.output;
      usage = result.usage;
      repaired = result.repaired;
    } catch (error) {
      usedFallback = true;
      // Le motif est préfixé : l'écran doit distinguer « l'agent n'a pas pu » de
      // « le plan proposé était mauvais ». Le message d'origine suit tel quel —
      // c'est lui qui dit *quoi* corriger (clé absente, modèle indisponible…).
      fallbackReason = `agent de montage indisponible : ${
        error instanceof Error ? error.message : 'raison inconnue'
      }`;
      deps.logger.warn(
        { contentItemId: content.contentItemId, sourceAssetId: source.asset.id, err: error },
        'media_planner indisponible : plan calculé en code',
      );
    }
  }

  const plan: StoredRenderPlan =
    candidate === null
      ? {
          ...defaultRenderPlan({
            sourceDurationMs: source.durationMs,
            maxClipMs: deps.maxClipMs,
            transcriptSegments: segments,
          }),
          source: 'fallback',
        }
      : { ...candidate, source: 'agent' };

  const warnings = [
    ...videoWarnings(
      {
        durationMs: source.durationMs,
        width: source.asset.width,
        height: source.asset.height,
        videoCodec: source.asset.codec,
        audioCodec: null,
        container: null,
        hasAudio: source.asset.hasAudio === true,
        fps: source.asset.fps,
        sizeBytes: source.asset.sizeBytes,
      },
      source.durationMs,
    ),
    ...renderPlanWarnings({
      plan,
      sourceWidth: source.asset.width,
      sourceHeight: source.asset.height,
      transcriptSegments: segments,
    }),
  ];

  return {
    plan,
    warnings,
    usedFallback,
    fallbackReason,
    content: {
      contentItemId: content.contentItemId,
      contentVersionId: content.contentVersionId,
      target: content.target,
      title: content.title,
      versionNumber: deps.ports.store.getVersion(content.contentVersionId)?.versionNumber ?? null,
    },
    video: {
      assetId: source.asset.id,
      durationMs: source.durationMs,
      width: source.asset.width,
      height: source.asset.height,
      hasAudio: source.asset.hasAudio === true,
      codec: source.asset.codec,
    },
    transcript: {
      available: transcript !== null,
      segments: segments.length,
      language: transcript?.language ?? null,
    },
    policy: {
      preset: VERTICAL_FORMAT.preset,
      width: VERTICAL_FORMAT.width,
      height: VERTICAL_FORMAT.height,
      fps: VERTICAL_FORMAT.fps,
      container: VERTICAL_FORMAT.container,
      maxClipMs: deps.maxClipMs,
      subtitleMode: 'burned',
      crop: 'vertical_center',
    },
    usage,
    repaired,
  };
}

// --- Création du rendu, relance, validation ----------------------------------

export interface CreateVideoRenderRequest {
  contentItemId: string;
  sourceAssetId: string;
  /** Le plan **validé par l'utilisateur** (déjà vérifié par le schéma côté route). */
  plan: RenderPlanProposal;
  /** D'où vient ce plan : l'agent, le calcul de repli, ou la main de l'utilisateur. */
  planSource?: 'agent' | 'fallback' | 'manual';
}

export interface VideoRenderResult {
  render: VideoRenderRecord;
  jobId: string;
  warnings: string[];
}

/**
 * Crée le rendu **et** son job — dans cet ordre, et jamais autrement.
 *
 * Le plan n'est plus seulement proposé : il est validé par l'utilisateur, donc
 * vérifié une seconde fois contre la **source** (bornes réelles). Les gardes qui
 * suivent sont volontairement dupliquées dans le worker : un plan ne doit pas
 * pouvoir atteindre FFmpeg parce qu'une des deux extrémités a oublié de vérifier.
 *
 * Si le job ne peut pas être créé, la ligne de rendu est retirée : un rendu sans
 * job serait un état que nulle part dans l'application ne sait afficher.
 */
export async function createVideoRender(
  deps: VideoFeatureDeps,
  request: CreateVideoRenderRequest,
): Promise<VideoRenderResult> {
  const content = approvedContent(deps, request.contentItemId);
  const source = sourceVideo(deps, content.projectId, request.sourceAssetId);
  const bounds = { sourceDurationMs: source.durationMs, maxClipMs: deps.maxClipMs };
  validateRenderPlan(request.plan, bounds);

  const transcript = deps.media.transcriptForAsset(source.asset.id);
  if (!transcript) {
    throw new ValidationError(
      'Aucune transcription pour cette vidéo : les sous-titres brûlés en ont besoin. Lancer la transcription de la vidéo, puis relancer la préparation.',
      { code: 'VIDEO_TRANSCRIPT_REQUIRED', details: { sourceAssetId: source.asset.id } },
    );
  }
  if (source.asset.hasAudio !== true) {
    throw new ValidationError(
      'Cette vidéo n’a pas de piste audio : elle ne peut pas être transcrite, donc pas sous-titrée.',
      { code: 'VIDEO_HAS_NO_AUDIO', details: { sourceAssetId: source.asset.id } },
    );
  }

  const warnings = renderPlanWarnings({
    plan: request.plan,
    sourceWidth: source.asset.width,
    sourceHeight: source.asset.height,
    transcriptSegments: transcript.segments,
  });
  if (!hasSpeechInWindow(transcript.segments, request.plan)) {
    throw new ValidationError(
      'Cet extrait ne contient aucune parole transcrite : les sous-titres brûlés n’auraient rien à afficher. Déplacer le début ou la fin de l’extrait.',
      { code: 'VIDEO_NO_SUBTITLES_IN_WINDOW', details: { sourceAssetId: source.asset.id } },
    );
  }

  const render = deps.renders.create({
    projectId: content.projectId,
    contentItemId: content.contentItemId,
    contentVersionId: content.contentVersionId,
    sourceAssetIds: [source.asset.id],
    preset: VERTICAL_FORMAT.preset,
    plan: { ...request.plan, source: request.planSource ?? 'manual' },
  });

  try {
    const jobId = await deps.queue.enqueue(RENDER_VIDEO_JOB, { renderId: render.id });
    const attached = deps.renders.attachJob(render.id, jobId);

    deps.logger.info(
      {
        renderId: render.id,
        jobId,
        contentItemId: content.contentItemId,
        contentVersionId: content.contentVersionId,
        sourceAssetId: source.asset.id,
        startMs: request.plan.startMs,
        endMs: request.plan.endMs,
      },
      'rendu vidéo mis en file',
    );

    return { render: attached, jobId, warnings };
  } catch (error) {
    deps.renders.remove(render.id);
    throw error;
  }
}

/**
 * « Relancer » et **reprise** : le même rendu, le même plan, le même job type.
 *
 * Un rendu terminé ne se relance pas — il faudrait un nouveau plan, donc un
 * nouveau rendu (§15 : ne pas faire croire que le montage validé correspond à un
 * autre texte).
 */
export async function resumeVideoRender(
  deps: VideoFeatureDeps,
  renderId: string,
): Promise<VideoRenderResult> {
  const render = deps.renders.getOrThrow(renderId);
  if (render.status === 'completed') {
    throw new ValidationError(
      'Ce rendu est terminé : modifier le plan crée un nouveau rendu, ce qui conserve l’ancien fichier.',
      { code: 'VIDEO_RENDER_ALREADY_COMPLETED', details: { renderId } },
    );
  }

  const requeued = deps.renders.requeue(renderId);
  const jobId = await deps.queue.enqueue(RENDER_VIDEO_JOB, { renderId });
  const attached = deps.renders.attachJob(requeued.id, jobId);

  deps.logger.info({ renderId, jobId, previousStatus: render.status }, 'rendu vidéo relancé');
  return { render: attached, jobId, warnings: [] };
}

/** Validation humaine : le rendu est regardé puis accepté. Rien n'est publié. */
export function validateVideoRender(deps: VideoFeatureDeps, renderId: string): VideoRenderRecord {
  const validated = deps.renders.validate(renderId);
  deps.logger.info({ renderId, contentVersionId: validated.contentVersionId }, 'rendu validé');
  return validated;
}
