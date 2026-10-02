import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '@aia/core';
import type { MediaAssetRecord } from '@aia/database';
import { TRANSCRIBE_MEDIA_JOB } from '@aia/queue';
import { ACCEPTED_SOURCE_VIDEO_CODECS, VERTICAL_FORMAT } from '@aia/media';
import {
  ConflictError,
  NotFoundError,
  RENDER_PLAN_SOURCE_LABELS,
  SUPPORTED_RENDER_PRESETS,
  VIDEO_RENDER_PRESET_LABELS,
  VIDEO_RENDER_STATUSES,
  VIDEO_RENDER_STATUS_LABELS,
  ValidationError,
  renderPlanProposalSchema,
  renderPlanSourceSchema,
} from '@aia/shared';
import type { ApiContext } from '../bootstrap';
import {
  createVideoRender,
  proposeVideoPlan,
  resumeVideoRender,
  uploadVideo,
  validateVideoRender,
} from '../features/media';

/**
 * Vidéo (étape 7) : **importer**, **proposer un plan**, **rendre**, **relire**
 * (docs/05 §6, docs/10 §4.7).
 *
 * La répartition des rôles est celle de tout le produit, sans exception :
 *
 * 1. **l'API n'encode jamais** : elle mesure, propose, valide et met en file. Le
 *    rendu est un job du worker, avec son propre délai maximal (§4.7) ;
 * 2. **un plan se voit avant d'être exécuté** : `POST …/video/plan` ne crée rien,
 *    ni ligne ni job. La création du rendu est un acte distinct, qui porte le plan
 *    **validé par l'utilisateur** et sa provenance ;
 * 3. **le fichier rendu est un nouvel asset** (docs/05 §6.4) : jamais un
 *    remplacement de la source, toujours rattaché à son original ;
 * 4. **rien ne se publie ici** : la publication vidéo reste manuelle (niveau C,
 *    interdit explicite de §4.7).
 */

const videoPlanRequestSchema = z.object({ sourceAssetId: z.string().min(1) });

/** Langue de la transcription : celle de l'utilisateur, jamais devinée. */
const transcribeBodySchema = z.object({
  language: z
    .string()
    .min(2)
    .max(12)
    .regex(/^[a-z]{2}(-[A-Za-z]{2,4})?$/, 'langue attendue : « fr », « en »…')
    .default('fr'),
});

/**
 * Le plan arrive d'un écran qui peut l'avoir modifié : il repasse donc par le
 * **même** schéma que la proposition de l'agent (`@aia/shared`). Un timecode
 * inversé, un mode de sous-titres inventé ou un recadrage non implémenté sont
 * refusés avant toute écriture.
 */
const createVideoRenderSchema = z.object({
  sourceAssetId: z.string().min(1),
  plan: renderPlanProposalSchema,
  planSource: renderPlanSourceSchema.optional(),
});

/** Le projet doit exister : un import rattaché à un projet inexistant n'a pas de sens. */
function requireProject(context: ApiContext, projectId: string): void {
  if (!context.memory.store.projects.byId(projectId)) {
    throw new NotFoundError(`Projet introuvable : ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }
}

/**
 * Ce que l'écran de montage affiche d'une vidéo source : ses mesures, et
 * l'existence d'une transcription — puisque sans transcription, il n'y a pas de
 * sous-titres brûlés possibles (docs/05 §6.2). Le dire **avant** de proposer un
 * extrait évite de faire choisir un plan qui échouera.
 */
function videoSummary(context: ApiContext, asset: MediaAssetRecord) {
  const transcript = context.media.transcriptForAsset(asset.id);
  return {
    ...asset,
    transcript: {
      available: transcript !== null,
      edited: transcript?.editedBody !== null && transcript !== undefined,
      language: transcript?.language ?? null,
      segments: transcript?.segments.length ?? 0,
    },
  };
}

/**
 * Sert un fichier média avec l'en-tête `Range` quand le navigateur le demande.
 *
 * Ce n'est pas du confort : sans `Range`, la balise `<video>` ne peut pas se
 * déplacer dans la timeline, et l'aperçu d'un extrait de trois minutes devient
 * inutilisable. Le chemin vient toujours d'un **asset en base**, jamais de la
 * requête : aucune traversée de répertoire n'est possible.
 */
async function sendMediaFile(
  context: ApiContext,
  request: FastifyRequest,
  reply: FastifyReply,
  storageKey: string,
  mimeType: string,
): Promise<FastifyReply> {
  const path = context.mediaStorage.getLocalPath(storageKey);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    // Le fichier a disparu du disque : c'est une erreur du serveur, pas de
    // l'utilisateur — et elle est nommée, pas rendue comme un 404 trompeur.
    throw new ConflictError(
      'Le fichier de ce média est absent du stockage : impossible de l’afficher.',
      { code: 'MEDIA_FILE_MISSING', details: { storageKey } },
    );
  }

  const range = request.headers.range;
  const match = typeof range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match) {
    const start = match[1] === '' ? 0 : Number(match[1]);
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
      reply
        .status(206)
        .header('content-range', `bytes ${start}-${end}/${size}`)
        .header('accept-ranges', 'bytes')
        .header('content-length', String(end - start + 1))
        .type(mimeType);
      return reply.send(createReadStream(path, { start, end }));
    }
  }

  reply
    .status(200)
    .header('accept-ranges', 'bytes')
    .header('content-length', String(size))
    .type(mimeType);
  return reply.send(createReadStream(path));
}

export function registerVideoRoutes(app: FastifyInstance, context: ApiContext): void {
  const maxUploadBytes = context.config.env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024;

  /**
   * Le **vocabulaire de l'écran vidéo** : format unique, modes acceptés, bornes
   * réelles et disponibilité de FFmpeg.
   *
   * Comme pour `/editorial/vocabulary`, l'écran ne recopie rien : si le format
   * passe un jour à un autre preset, ou si la durée maximale d'extrait change, le
   * formulaire suit sans modification côté `apps/web`. Et si `ffmpeg` n'est pas
   * installé, l'écran le dit au lieu d'afficher un bouton qui échouera.
   */
  app.get('/media/video/capabilities', async () => ({
    format: {
      ...VERTICAL_FORMAT,
      label: VIDEO_RENDER_PRESET_LABELS[VERTICAL_FORMAT.preset],
    },
    /** Tous les presets du modèle, mais un seul `supported: true` (étape 7). */
    presets: Object.entries(VIDEO_RENDER_PRESET_LABELS).map(([value, label]) => ({
      value,
      label,
      supported: (SUPPORTED_RENDER_PRESETS as readonly string[]).includes(value),
    })),
    renderStatuses: VIDEO_RENDER_STATUSES.map((value) => ({
      value,
      label: VIDEO_RENDER_STATUS_LABELS[value],
    })),
    planSources: Object.entries(RENDER_PLAN_SOURCE_LABELS).map(([value, label]) => ({
      value,
      label,
    })),
    subtitleModes: [{ value: 'burned', label: 'Sous-titres incrustés dans l’image' }],
    crops: [{ value: 'vertical_center', label: 'Recadrage centré (bords coupés)' }],
    acceptedMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    acceptedCodecs: [...ACCEPTED_SOURCE_VIDEO_CODECS],
    maxUploadBytes,
    maxDurationMs: context.config.env.MEDIA_MAX_DURATION_S * 1_000,
    maxClipMs: context.config.env.VIDEO_MAX_CLIP_S * 1_000,
    /** La disponibilité est **mesurée**, pas espérée (même règle que la voix). */
    ffmpeg: (await context.video.ffmpeg.version()) !== null,
  }));

  /**
   * **Import d'une vidéo source.** Le corps de la requête est le fichier lui-même
   * (comme pour la voix) : même limite de taille déclarée, même honnêteté — le
   * serveur décide par le contenu (`detectVideoContainer`) puis par `ffprobe`,
   * jamais par l'extension ni par l'en-tête `Content-Type` du client.
   */
  app.post('/projects/:id/videos', { bodyLimit: maxUploadBytes }, async (request, reply) => {
    const { id: projectId } = request.params as { id: string };
    requireProject(context, projectId);
    if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      throw new ValidationError('Un fichier vidéo non vide est requis.', {
        code: 'VIDEO_BODY_REQUIRED',
      });
    }

    const uploaded = await uploadVideo(context.video, {
      projectId,
      bytes: request.body,
      declaredMime: request.headers['content-type'] ?? '',
      maxUploadBytes,
    });

    reply.status(uploaded.deduplicated ? 200 : 201);
    return {
      video: videoSummary(context, uploaded.asset),
      probe: uploaded.probe,
      deduplicated: uploaded.deduplicated,
      warnings: uploaded.warnings,
    };
  });

  /**
   * Les vidéos **importées** d'un projet. Les rendus sont des assets vidéo aussi
   * (`role: 'subtitled'`), mais ils ne sont pas des sources : les confondre
   * ferait apparaître un short comme entrée de son propre montage.
   */
  app.get('/projects/:id/videos', async (request) => {
    const { id: projectId } = request.params as { id: string };
    requireProject(context, projectId);
    const videos = context.media
      .listAssets(projectId, { kind: 'video', limit: 100 })
      .filter((asset) => asset.role === 'original');
    return { videos: videos.map((asset) => videoSummary(context, asset)) };
  });

  /** Aperçu d'une vidéo source : le fichier, avec `Range` pour la timeline. */
  app.get('/media/assets/:assetId/file', async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const asset = context.media.asset(assetId);
    if (!asset || asset.kind !== 'video') {
      throw new NotFoundError(`Vidéo introuvable : ${assetId}`, {
        code: 'VIDEO_ASSET_NOT_FOUND',
        details: { assetId },
      });
    }
    return sendMediaFile(context, request, reply, asset.storageKey, asset.mimeType);
  });

  /**
   * **Transcrire** la vidéo importée : sans transcription, il n'y a pas de
   * sous-titres brûlés, donc pas de short (docs/05 §6.2).
   *
   * La langue est celle de l'utilisateur, pas celle devinée par un modèle : elle
   * est envoyée au moteur, et le job est dédupliqué par
   * `transcribe:<asset>:<langue>` — demander deux fois la même transcription ne
   * paie pas deux décodages.
   */
  app.post('/media/assets/:assetId/transcribe', async (request, reply) => {
    const { assetId } = request.params as { assetId: string };
    const body = parseOrThrow(transcribeBodySchema, request.body ?? {}, 'TRANSCRIBE_INPUT_INVALID');
    const asset = context.media.asset(assetId);
    if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio')) {
      throw new NotFoundError(`Média introuvable : ${assetId}`, {
        code: 'MEDIA_ASSET_NOT_FOUND',
        details: { assetId },
      });
    }
    if (asset.hasAudio === false) {
      throw new ValidationError(
        'Ce média n’a pas de piste audio : il ne peut pas être transcrit (donc pas sous-titré).',
        { code: 'MEDIA_HAS_NO_AUDIO', details: { assetId } },
      );
    }
    if (!(await context.mediaStorage.exists(asset.storageKey))) {
      throw new ConflictError('Le fichier de ce média est absent du stockage.', {
        code: 'MEDIA_FILE_MISSING',
        details: { assetId, storageKey: asset.storageKey },
      });
    }

    const jobId = await context.mediaQueue.enqueue(TRANSCRIBE_MEDIA_JOB, {
      assetId: asset.id,
      language: body.language,
    });
    reply.status(202);
    return { asset, transcript: context.media.transcriptForAsset(asset.id), jobId };
  });

  /**
   * **Proposition de plan** — rien n'est créé : ni ligne `video_renders`, ni job.
   *
   * C'est le cœur de la règle de docs/05 §6.3 : l'agent propose, l'utilisateur
   * voit, modifie, puis déclenche. Un agent indisponible ne bloque pas l'écran :
   * un plan calculé en code est rendu, avec sa provenance et la raison du repli.
   */
  app.post('/content/:contentId/video/plan', async (request) => {
    const { contentId } = request.params as { contentId: string };
    const body = parseOrThrow(videoPlanRequestSchema, request.body, 'VIDEO_PLAN_INPUT_INVALID');
    return proposeVideoPlan(context.video, {
      contentItemId: contentId,
      sourceAssetId: body.sourceAssetId,
    });
  });

  /**
   * **Créer le rendu** : la seule route qui écrit une ligne et enfile un job.
   *
   * Elle rend `202` : le travail est long, il appartient au worker, et l'écran suit
   * la progression par `GET /events/jobs/:jobId` (même mécanique que la rédaction
   * et la transcription).
   */
  app.post('/content/:contentId/video/renders', async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    const body = parseOrThrow(createVideoRenderSchema, request.body, 'VIDEO_RENDER_INPUT_INVALID');
    const result = await createVideoRender(context.video, {
      contentItemId: contentId,
      sourceAssetId: body.sourceAssetId,
      plan: body.plan,
      ...(body.planSource ? { planSource: body.planSource } : {}),
    });
    reply.status(202);
    return result;
  });

  /** Les rendus d'un contenu : le dernier en haut, jamais mélangés à un autre texte. */
  app.get('/content/:contentId/renders', async (request) => {
    const { contentId } = request.params as { contentId: string };
    return { renders: context.renders.listByContentItem(contentId) };
  });

  app.get('/projects/:id/renders', async (request) => {
    const { id: projectId } = request.params as { id: string };
    requireProject(context, projectId);
    return { renders: context.renders.listByProject(projectId) };
  });

  /** Un rendu, son plan, ses arguments compilés et son éventuel échec expliqué. */
  app.get('/renders/:renderId', async (request) => {
    const { renderId } = request.params as { renderId: string };
    return { render: context.renders.getOrThrow(renderId) };
  });

  /**
   * **Reprendre** un rendu interrompu, ou relancer un échec : la même ligne, le
   * même plan, la même version de contenu. Rien de métier n'est recréé (§13).
   *
   * Un rendu terminé est refusé ici : le relancer laisserait croire que le montage
   * a changé, alors que c'est le **plan** qu'il faut modifier — donc un nouveau
   * rendu, qui conserve l'ancien.
   */
  app.post('/renders/:renderId/resume', async (request, reply) => {
    const { renderId } = request.params as { renderId: string };
    const result = await resumeVideoRender(context.video, renderId);
    reply.status(202);
    return result;
  });

  /**
   * Validation **humaine** du rendu : la seule trace que quelqu'un l'a regardé
   * (docs/05 §6.5). Elle n'ouvre aucune publication automatique.
   */
  app.post('/renders/:renderId/validate', async (request) => {
    const { renderId } = request.params as { renderId: string };
    return { render: validateVideoRender(context.video, renderId) };
  });

  /**
   * Le **fichier rendu**, pour l'aperçu dans l'écran. Il n'existe que si le rendu
   * est terminé : demander le fichier d'un rendu en cours est une erreur, pas un
   * fichier vide (l'écran afficherait un lecteur muet sans explication).
   */
  app.get('/renders/:renderId/file', async (request, reply) => {
    const { renderId } = request.params as { renderId: string };
    const render = context.renders.getOrThrow(renderId);
    if (render.status !== 'completed' || render.outputAssetId === null) {
      throw new ConflictError(
        'Le fichier de ce rendu n’est pas encore disponible : il n’est pas terminé.',
        { code: 'VIDEO_RENDER_NOT_COMPLETED', details: { renderId, status: render.status } },
      );
    }
    const asset = context.media.asset(render.outputAssetId);
    if (!asset) {
      throw new NotFoundError(`Asset de sortie introuvable : ${render.outputAssetId}`, {
        code: 'VIDEO_OUTPUT_ASSET_NOT_FOUND',
      });
    }
    return sendMediaFile(context, request, reply, asset.storageKey, asset.mimeType);
  });
}
