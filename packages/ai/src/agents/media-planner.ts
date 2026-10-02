import { renderPlanProposalSchema, type RenderPlanProposal } from '@aia/shared';
import type { LLMProvider } from '../provider';
import { createStructuredAgent, type Agent, type PromptSource } from './agent';

/**
 * `media_planner` — l'agent de plan de montage (docs/04 §4.7, étape 7).
 *
 * Son rôle est **volontairement** étroit : proposer un extrait, des sous-titres
 * brûlés et un recadrage centré. Il ne lance **jamais** FFmpeg, il ne publie
 * rien, et il ne décide d'aucune préférence qui appartient au code (format,
 * vitesse, musique — docs/05 §6.2).
 *
 * Ce que l'étape 7 interdit et que cet agent ne fait donc pas : analyser toute la
 * vidéo, chercher un « moment fort », noter une émotion, regarder les images.
 * Ses seules entrées sont **déjà disponibles** : le texte approuvé, la
 * transcription horodatée, la durée de la vidéo.
 *
 * Le plan proposé est **modifiable** par l'utilisateur, et un plan qui ne
 * respecte pas le schéma (bornes incohérentes, timecode inventé) est refusé
 * **avant** tout appel FFmpeg. Quand l'agent n'y arrive pas, on ne s'arrête pas :
 * `defaultRenderPlan` (dans `@aia/media`) calcule un plan en code — docs/05 §6.3.
 */

export interface MediaPlannerSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface MediaPlannerInput {
  /** Le texte **approuvé** du contenu (script TikTok/Short) : la seule intention connue. */
  script: string;
  /** Transcription disponible : texte et segments horodatés. */
  transcript: {
    text: string;
    segments: readonly MediaPlannerSegment[];
  };
  video: {
    durationMs: number;
    width: number | null;
    height: number | null;
    hasAudio: boolean;
  };
  /** Durée maximale d'un extrait : une borne du produit, pas un choix du modèle. */
  maxClipMs: number;
  /** Libellé de la cible (« Short TikTok »…) : du contexte, jamais une consigne de format. */
  targetLabel?: string;
}

export const MEDIA_PLANNER_AGENT = 'media_planner';
export const MEDIA_PLANNER_TASK = 'video_plan';
export const MEDIA_PLANNER_MAX_INPUT_TOKENS = 8_000;
export const MEDIA_PLANNER_MAX_OUTPUT_TOKENS = 700;
/** Un plan se relit : un peu de variété sans dériver. */
export const MEDIA_PLANNER_TEMPERATURE = 0.2;

/** Bornes du prompt : le transcript d'une longue vidéo ne rentre pas entier, et n'aide pas. */
export const MEDIA_PLANNER_MAX_SEGMENTS = 120;
export const MEDIA_PLANNER_MAX_SCRIPT_CHARS = 4_000;

function seconds(milliseconds: number): string {
  return (Math.max(0, milliseconds) / 1_000).toFixed(1);
}

/**
 * Le prompt final : instructions **du fichier** + contexte **injecté**. Aucun
 * chemin de fichier, aucun identifiant technique n'est envoyé au modèle.
 */
export function buildMediaPlannerPrompt(input: MediaPlannerInput): string {
  const parts: string[] = [];
  parts.push('# Vidéo source');
  parts.push(
    `Durée totale : ${seconds(input.video.durationMs)} s · ${
      input.video.width !== null && input.video.height !== null
        ? `${input.video.width}×${input.video.height}`
        : 'résolution inconnue'
    } · ${input.video.hasAudio ? 'avec audio' : 'sans audio'}`,
  );
  parts.push(`Durée maximale de l’extrait : ${seconds(input.maxClipMs)} s`);

  parts.push('', '# Texte approuvé du contenu');
  parts.push(
    input.script.trim().length === 0
      ? 'Aucun texte approuvé fourni.'
      : input.script.slice(0, MEDIA_PLANNER_MAX_SCRIPT_CHARS),
  );

  parts.push('', '# Transcription horodatée (source : whisper.cpp, segments)');
  const segments = input.transcript.segments.slice(0, MEDIA_PLANNER_MAX_SEGMENTS);
  parts.push(
    segments.length === 0
      ? 'Aucun segment transcrit : aucun sous-titre n’est possible.'
      : segments
          .map(
            (segment) =>
              `[${seconds(segment.startMs)} → ${seconds(segment.endMs)}] ${segment.text.trim()}`,
          )
          .join('\n'),
  );

  parts.push('', '# Contraintes non négociables');
  parts.push(
    [
      '- tu ne fournis que le JSON demandé : `startMs`, `endMs`, `subtitleMode`, `crop`, `reason` ;',
      '- `startMs` entre 0 et la durée de la vidéo, `endMs` strictement supérieur à `startMs` ;',
      '- `endMs` au plus égal à la durée de la vidéo, et `endMs - startMs` au plus égal à la durée maximale ci-dessus ;',
      '- l’extrait doit au moins contenir un segment transcrit, sinon aucun sous-titre ne s’affiche ;',
      '- `subtitleMode` vaut `burned` et `crop` vaut `vertical_center` : ce sont les seules valeurs acceptées ;',
      '- `reason` explique en une phrase pourquoi cet extrait, sans inventer de contenu.',
    ].join('\n'),
  );

  return parts.join('\n');
}

export interface MediaPlannerAgentOptions {
  provider: LLMProvider;
  prompt: PromptSource;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  temperature?: number;
}

export function createMediaPlannerAgent(
  options: MediaPlannerAgentOptions,
): Agent<MediaPlannerInput, RenderPlanProposal> {
  return createStructuredAgent<MediaPlannerInput, RenderPlanProposal>({
    name: MEDIA_PLANNER_AGENT,
    task: MEDIA_PLANNER_TASK,
    provider: options.provider,
    prompt: options.prompt,
    schema: renderPlanProposalSchema,
    buildPrompt: (input) => `${options.prompt.body}\n\n${buildMediaPlannerPrompt(input)}`,
    maxOutputTokens: options.maxOutputTokens ?? MEDIA_PLANNER_MAX_OUTPUT_TOKENS,
    maxInputTokens: options.maxInputTokens ?? MEDIA_PLANNER_MAX_INPUT_TOKENS,
    temperature: options.temperature ?? MEDIA_PLANNER_TEMPERATURE,
    expectedOutputTokens: 200,
  });
}
