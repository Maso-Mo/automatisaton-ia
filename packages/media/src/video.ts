import { join } from 'node:path';
import {
  RENDER_CLIP_MAX_MS,
  RENDER_CLIP_MIN_MS,
  ValidationError,
  type RenderPlanProposal,
} from '@aia/shared';
import type { MediaProbe } from './ffmpeg';

/**
 * Le **format unique** de l'étape 7 et la compilation d'un plan en arguments
 * FFmpeg (docs/05 §6.4, docs/10 §4.7).
 *
 * Un seul format, une seule stratégie de recadrage, un seul passage d'encodage :
 * c'est ce qui rend cette étape livrable, et c'est écrit ici plutôt que dispersé
 * dans le worker. La règle de `docs/10` §4.7 est explicite — si le rendu déborde,
 * on réduit le périmètre (un format, sans transition), on n'allonge pas l'étape.
 *
 * Tout ce fichier est **pur** : aucune E/S, aucun processus. C'est la partie la
 * plus risquée du produit (un filtre FFmpeg mal construit se paie en minutes
 * d'encodage), et elle se teste donc sans lancer FFmpeg.
 */

export interface VerticalFormat {
  preset: 'vertical_9_16';
  width: number;
  height: number;
  fps: number;
  container: 'mp4';
  videoCodec: 'h264';
  audioCodec: 'aac';
}

/** 1080 × 1920, 30 i/s, MP4/H.264 + AAC : le seul rendu de l'étape. */
export const VERTICAL_FORMAT: VerticalFormat = {
  preset: 'vertical_9_16',
  width: 1080,
  height: 1920,
  fps: 30,
  container: 'mp4',
  videoCodec: 'h264',
  audioCodec: 'aac',
};

/**
 * Codecs vidéo **acceptés en entrée**. Un seul, volontairement (docs/10 §4.7 :
 * « ne cherche pas à supporter tous les codecs »). Un autre codec produit une
 * erreur qui le **nomme**, jamais un rendu au hasard.
 */
export const ACCEPTED_SOURCE_VIDEO_CODECS = ['h264'] as const;

export interface SupportedVideoContainer {
  extension: 'mp4' | 'mov' | 'webm';
  mime: string;
}

const CONTAINER_MIMES: Record<SupportedVideoContainer['extension'], readonly string[]> = {
  mp4: ['video/mp4', 'video/x-m4v'],
  mov: ['video/quicktime'],
  webm: ['video/webm', 'video/x-matroska'],
};

const CONTAINER_MIME: Record<SupportedVideoContainer['extension'], string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

function normalizedMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * Reconnaissance du **conteneur par son contenu**, jamais par son extension ni
 * par ce que le client annonce (docs/05 §5.1). Un `.mp4` qui n'en est pas un est
 * refusé ici, avant tout stockage.
 */
export function detectVideoContainer(
  data: Uint8Array,
  declaredMime: string,
): SupportedVideoContainer {
  if (data.byteLength < 12) {
    throw new ValidationError('Le fichier vidéo est vide ou incomplet.', {
      code: 'VIDEO_FORMAT_UNSUPPORTED',
    });
  }
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let extension: SupportedVideoContainer['extension'] | undefined;

  // EBML (Matroska / WebM) : même en-tête pour les deux, d'où un seul choix.
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    extension = 'webm';
  } else if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12).trim().toLowerCase();
    extension = brand === 'qt' || brand.startsWith('qt') ? 'mov' : 'mp4';
  }

  if (extension === undefined) {
    throw new ValidationError(
      'Format vidéo non pris en charge : seuls MP4, MOV et WebM sont acceptés.',
      { code: 'VIDEO_FORMAT_UNSUPPORTED' },
    );
  }

  const mime = normalizedMime(declaredMime);
  if (mime !== 'application/octet-stream' && !CONTAINER_MIMES[extension].includes(mime)) {
    throw new ValidationError('Le type déclaré ne correspond pas au contenu vidéo.', {
      code: 'VIDEO_MIME_MISMATCH',
      details: { declaredMime: mime, detectedFormat: extension },
    });
  }

  return { extension, mime: CONTAINER_MIME[extension] };
}

/**
 * Vérifie ce qui a été **décodé** : un flux vidéo présent, un codec accepté, et
 * une durée exploitable. Le message nomme le codec trouvé — « erreur explicite »
 * veut dire « on peut agir », pas « ça n'a pas marché ».
 */
export function assertSupportedVideoProbe(probe: MediaProbe): void {
  if (probe.videoCodec === null) {
    throw new ValidationError('Ce fichier ne contient aucune piste vidéo décodable.', {
      code: 'VIDEO_STREAM_MISSING',
    });
  }
  if (!ACCEPTED_SOURCE_VIDEO_CODECS.some((codec) => codec === probe.videoCodec)) {
    throw new ValidationError(
      `Codec vidéo non pris en charge : ${probe.videoCodec}. Convertir la source en H.264 (MP4) avant de l’importer.`,
      {
        code: 'VIDEO_CODEC_UNSUPPORTED',
        details: {
          detectedCodec: probe.videoCodec,
          acceptedCodecs: [...ACCEPTED_SOURCE_VIDEO_CODECS],
        },
      },
    );
  }
  if (probe.durationMs === null || probe.durationMs <= 0) {
    throw new ValidationError('Durée vidéo indéterminée : ffprobe ne peut pas la mesurer.', {
      code: 'VIDEO_DURATION_UNKNOWN',
    });
  }
}

/** Clé de stockage d'une vidéo source : elle est fabriquée par le serveur. */
export function videoStorageKey(
  hash: string,
  assetId: string,
  extension: SupportedVideoContainer['extension'],
  now: Date,
): string {
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return join(year + month, hash.slice(0, 2), `${assetId}.${extension}`);
}

/** Clé de stockage d'un rendu : `renders/{render_id}.mp4` (docs/05 §6.4). */
export function renderStorageKey(renderId: string): string {
  return join('renders', `${renderId}.${VERTICAL_FORMAT.container}`);
}

// --- Validation d'un plan --------------------------------------------------

export interface PlanBounds {
  /** Durée de la vidéo source, telle que `ffprobe` l'a mesurée. */
  sourceDurationMs: number;
  /** Durée maximale d'un extrait à cette étape (`VIDEO_MAX_CLIP_S`). */
  maxClipMs: number;
}

/**
 * Les contrôles que le schéma **ne peut pas** faire (docs/05 §6.3) : ils portent
 * sur la source, que le schéma ne connaît pas.
 *
 * 1. `start >= 0`, `end > start`, `end <= durée de la vidéo` ;
 * 2. durée de l'extrait dans `[RENDER_CLIP_MIN_MS, maxClipMs]`.
 *
 * Chaque refus a son code : l'écran peut alors dire *quoi corriger* au lieu de
 * « plan invalide ».
 */
export function validateRenderPlan(plan: RenderPlanProposal, bounds: PlanBounds): void {
  if (plan.startMs < 0) {
    throw new ValidationError('Le début de l’extrait ne peut pas être négatif.', {
      code: 'VIDEO_PLAN_START_NEGATIVE',
    });
  }
  if (plan.endMs <= plan.startMs) {
    throw new ValidationError('La fin de l’extrait doit être postérieure au début.', {
      code: 'VIDEO_PLAN_END_BEFORE_START',
    });
  }
  if (plan.endMs > bounds.sourceDurationMs) {
    throw new ValidationError(
      `La fin de l’extrait (${formatMs(plan.endMs)}) dépasse la durée de la vidéo (${formatMs(
        bounds.sourceDurationMs,
      )}).`,
      {
        code: 'VIDEO_PLAN_BEYOND_SOURCE',
        details: { endMs: plan.endMs, sourceDurationMs: bounds.sourceDurationMs },
      },
    );
  }

  const durationMs = plan.endMs - plan.startMs;
  if (durationMs < RENDER_CLIP_MIN_MS) {
    throw new ValidationError(
      `Extrait trop court : ${formatMs(durationMs)} (minimum ${formatMs(RENDER_CLIP_MIN_MS)}).`,
      { code: 'VIDEO_PLAN_TOO_SHORT', details: { durationMs, minMs: RENDER_CLIP_MIN_MS } },
    );
  }
  if (durationMs > bounds.maxClipMs) {
    throw new ValidationError(
      `Extrait trop long : ${formatMs(durationMs)} (maximum ${formatMs(bounds.maxClipMs)}).`,
      { code: 'VIDEO_PLAN_TOO_LONG', details: { durationMs, maxMs: bounds.maxClipMs } },
    );
  }
}

/** `m:ss.mmm` : lisible par un humain, sans dépendance à la locale. */
export function formatMs(milliseconds: number): string {
  const clamped = Math.max(0, Math.round(milliseconds));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1_000);
  const millis = clamped % 1_000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/**
 * Y a-t-il de la parole transcrite dans cette fenêtre ? C'est la question qui
 * décide si des sous-titres ont quelque chose à afficher — et elle est posée
 * **avant** l'encodage, jamais après (docs/10 §4.7).
 */
export function hasSpeechInWindow(
  segments: readonly { startMs: number; endMs: number; text: string }[],
  plan: Pick<RenderPlanProposal, 'startMs' | 'endMs'>,
): boolean {
  return segments.some(
    (segment) =>
      segment.endMs > plan.startMs && segment.startMs < plan.endMs && segment.text.trim() !== '',
  );
}

/**
 * Avertissements **honnêtes** affichés avec le plan, avant tout encodage
 * (docs/10 §4.7 : « si la vidéo se prête mal au crop, afficher un avertissement »).
 *
 * Ils ne bloquent pas ici : un avertissement qui bloque devient un refus, et
 * l'utilisateur doit pouvoir décider. Le refus, lui, existe — mais au moment de
 * valider le plan, avec un code précis (`VIDEO_NO_SUBTITLES_IN_WINDOW`).
 */
export function renderPlanWarnings(input: {
  plan: Pick<RenderPlanProposal, 'startMs' | 'endMs'>;
  sourceWidth: number | null;
  sourceHeight: number | null;
  transcriptSegments: readonly { startMs: number; endMs: number; text: string }[];
}): string[] {
  const warnings: string[] = [];

  if (!hasSpeechInWindow(input.transcriptSegments, input.plan)) {
    warnings.push(
      'Aucune parole transcrite dans cet extrait : les sous-titres n’auraient rien à afficher. Déplacer le début ou la fin.',
    );
  }

  const { sourceWidth, sourceHeight } = input;
  if (sourceWidth !== null && sourceHeight !== null && sourceWidth > sourceHeight) {
    // Part de la largeur d'origine conservée par un recadrage centré 9:16.
    const keptWidth = (VERTICAL_FORMAT.width / VERTICAL_FORMAT.height) * sourceHeight;
    const keptRatio = Math.min(1, keptWidth / sourceWidth);
    if (keptRatio < 0.6) {
      warnings.push(
        `Recadrage important : la vidéo est en ${sourceWidth}×${sourceHeight}, le format vertical ne gardera qu’environ ${Math.round(
          keptRatio * 100,
        )} % de la largeur d’origine (bords coupés).`,
      );
    }
  }

  return warnings;
}

/**
 * Le plan **par défaut**, calculé en code — jamais par un modèle.
 *
 * C'est le repli de docs/05 §6.3 : quand l'agent ne propose pas de plan
 * exploitable, le pipeline ne s'arrête pas, il propose l'extrait le plus simple
 * possible. Une seule règle, donc : **depuis le premier passage transcrit**, sur
 * au plus soixante secondes (ou la durée de la vidéo). Aucun score, aucune
 * détection de « moment fort » — ce que l'étape 7 interdit explicitement.
 */
export function defaultRenderPlan(input: {
  sourceDurationMs: number;
  maxClipMs: number;
  transcriptSegments: readonly { startMs: number; endMs: number }[];
}): RenderPlanProposal {
  const targetMs = Math.max(RENDER_CLIP_MIN_MS, Math.min(60_000, input.maxClipMs));
  const first = input.transcriptSegments[0];
  const startMs = Math.max(
    0,
    Math.min(first?.startMs ?? 0, input.sourceDurationMs - RENDER_CLIP_MIN_MS),
  );
  const endMs = Math.max(
    startMs + RENDER_CLIP_MIN_MS,
    Math.min(input.sourceDurationMs, startMs + targetMs),
  );

  return {
    startMs,
    endMs,
    subtitleMode: 'burned',
    crop: 'vertical_center',
    reason:
      'Extrait par défaut calculé en code : du premier passage transcrit jusqu’à 60 secondes au plus, aucun modèle consulté.',
  };
}

/** Résumé chiffré du plan, pour les journaux et l'écran. */
export function describeRenderPlan(plan: RenderPlanProposal): string {
  return `${formatMs(plan.startMs)} → ${formatMs(plan.endMs)} (${formatMs(
    plan.endMs - plan.startMs,
  )}, sous-titres brûlés, recadrage centré)`;
}

// --- Compilation du plan en arguments (fonction pure) ----------------------

export interface VerticalShortArgsInput {
  /** Chemin **absolu** de la vidéo source (argument, jamais dans un filtre). */
  inputPath: string;
  /** Chemin **absolu** du fichier de sortie (écrit dans un temporaire, puis renommé). */
  outputPath: string;
  plan: Pick<RenderPlanProposal, 'startMs' | 'endMs'>;
  hasAudio: boolean;
  /**
   * Nom **relatif** du fichier ASS **dans le répertoire de travail** du rendu, ou
   * `null` pour ne pas incruster de sous-titres. Un nom relatif interdit toute
   * injection de chemin dans le filtre FFmpeg.
   */
  subtitleFileName?: string | null;
}

function seconds(milliseconds: number): string {
  return (Math.max(0, milliseconds) / 1_000).toFixed(3);
}

/** Le filtre vidéo : recadrage centré 9:16, puis sous-titres brûlés. */
export function buildVerticalFilterGraph(subtitleFileName?: string | null): string {
  const chain = [
    `scale=${VERTICAL_FORMAT.width}:${VERTICAL_FORMAT.height}:force_original_aspect_ratio=increase`,
    `crop=${VERTICAL_FORMAT.width}:${VERTICAL_FORMAT.height}`,
    // `setsar=1` : sans lui, un SAR non carré réapparaît dans le lecteur.
    'setsar=1',
  ];
  if (subtitleFileName !== null && subtitleFileName !== undefined) {
    chain.push(`subtitles=${subtitleFileName}`);
  }
  return `[0:v]${chain.join(',')}[v]`;
}

/**
 * Un **seul** passage d'encodage (docs/05 §6.4) : découpe, recadrage, sous-titres
 * brûlés et audio dans la même commande. Deux passages doubleraient le temps et
 * perdraient de la qualité.
 *
 * La sortie est `+faststart` : le fichier est lisible dès le premier octet, ce
 * qui compte pour une prévisualisation dans le navigateur.
 */
export function buildVerticalShortArgs(input: VerticalShortArgsInput): string[] {
  const durationMs = input.plan.endMs - input.plan.startMs;
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    // La progression est écrite sur stdout : c'est ce qui alimente l'écran.
    '-progress',
    'pipe:1',
    '-nostats',
    '-ss',
    seconds(input.plan.startMs),
    '-t',
    seconds(durationMs),
    '-i',
    input.inputPath,
    '-filter_complex',
    buildVerticalFilterGraph(input.subtitleFileName),
    '-map',
    '[v]',
    ...(input.hasAudio ? ['-map', '0:a?'] : []),
    '-c:v',
    VERTICAL_FORMAT.videoCodec === 'h264' ? 'libx264' : VERTICAL_FORMAT.videoCodec,
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(VERTICAL_FORMAT.fps),
    '-movflags',
    '+faststart',
    ...(input.hasAudio
      ? ['-c:a', VERTICAL_FORMAT.audioCodec, '-b:a', '128k', '-ar', '48000', '-ac', '2']
      : ['-an']),
    '-y',
    input.outputPath,
  ];
}

export { RENDER_CLIP_MAX_MS, RENDER_CLIP_MIN_MS };
