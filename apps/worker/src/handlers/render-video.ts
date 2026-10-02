import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { MediaStore, VideoRenderStore } from '@aia/database';
import {
  buildSubtitleCues,
  buildVerticalShortArgs,
  describeRenderPlan,
  ffmpegUnavailable,
  formatMs,
  renderAssSubtitles,
  renderStorageKey,
  sha256File,
  SUBTITLE_FILE_NAME,
  VERTICAL_FORMAT,
  type FFmpegRunner,
  type StorageAdapter,
} from '@aia/media';
import { renderVideoSpec, type JobDefinition, type RenderVideoInput } from '@aia/queue';
import {
  CapabilityError,
  NotFoundError,
  ValidationError,
  serializeError,
  toAppError,
  type Clock,
} from '@aia/shared';
import type { Semaphore } from '../features/semaphore';
/**
 * Le handler du job `render_video` (docs/05 §6.4, docs/10 §4.7).
 *
 * C'est **la** partie chère du produit : on ne l'exécute donc que sur un plan
 * validé, jamais dans une requête HTTP, et on explique chaque échec.
 *
 * Ce que le handler garantit, dans l'ordre où ça compte :
 *
 * 1. **il ne relit pas le plan ailleurs que dans `video_renders`** : le job ne
 *    porte qu'un `renderId`, donc la reprise relit exactement le même plan ;
 * 2. **il est idempotent** : un rendu déjà terminé n'est pas rejoué (il rend son
 *    résultat) ; un rendu interrompu est relancé **depuis sa source** — c'est ce
 *    que veut dire « reprendre » ici (§13) ;
 * 3. **les sous-titres viennent de la transcription existante**, jamais d'une
 *    invention : sans transcript, il s'arrête et le dit ;
 * 4. **un seul encodage à la fois** (`semaphore`) : un PC modeste reste réactif
 *    pendant un rendu.
 *
 * Le fichier est écrit dans un `.part` du **répertoire cible** puis renommé : un
 * fichier visible est un fichier terminé, et le rename reste sur le même volume.
 */
export interface RenderVideoOutput {
  renderId: string;
  outputAssetId: string;
  durationMs: number | null;
  outputSizeBytes: number | null;
  subtitleCues: number;
}

/**
 * Enregistre l'échec **sur la ligne du rendu**, puis laisse remonter l'erreur.
 *
 * Le statut décrit la dernière tentative : sans cette écriture, un rendu refusé
 * par FFmpeg resterait affiché « encodage » indéfiniment, alors que le job est
 * terminé en échec — et l'écran ne pourrait pas dire pourquoi. Le motif est
 * **sérialisé sans pile d'appels** (`serializeError`), comme tout ce qui part
 * vers l'extérieur (docs/08 §6.3).
 *
 * La politique de reprise n'est pas décidée ici : si la file réessaie (erreur
 * transitoire, ou une seule reprise pour une erreur interne), la tentative
 * suivante repasse par `markPreparing`, qui ré-arme la ligne et efface le motif.
 */
function recordRenderFailure(renders: VideoRenderStore, renderId: string, error: unknown): void {
  try {
    renders.fail(renderId, serializeError(toAppError(error)));
  } catch {
    // La ligne est déjà dans un état terminal (annulée, ou terminée entre-temps) :
    // l'erreur d'origine est plus utile que celle du marquage, on la garde.
  }
}

export interface RenderVideoHandlerDeps {
  renders: VideoRenderStore;
  media: MediaStore;
  storage: StorageAdapter;
  ffmpeg: FFmpegRunner;
  clock: Clock;
  /** Sémaphore partagé : un seul rendu lourd à la fois (docs/05 §6.4). */
  semaphore: Semaphore;
  /** Durée maximale d'un extrait : la borne opposée au plan validé. */
  maxClipMs: number;
  /** Répertoire de travail des fichiers temporaires de rendu. */
  temporaryRoot?: string;
}

export function createRenderVideoHandler(
  deps: RenderVideoHandlerDeps,
): JobDefinition<RenderVideoInput, RenderVideoOutput> {
  return {
    ...renderVideoSpec,
    handler: async (input, ctx) => {
      const render = deps.renders.getOrThrow(input.renderId);
      await ctx.setStep('load_render', 5);

      // Un rendu déjà terminé n'est pas refait : c'est ce qui protège une reprise
      // après un bail expiré — la file rejoue le même job, avec le même renderId.
      if (render.status === 'completed' && render.outputAssetId !== null) {
        await ctx.emitEvent({
          step: 'done',
          progress: 100,
          message: 'Rendu déjà terminé : réutilisation du fichier existant.',
          data: { renderId: render.id, outputAssetId: render.outputAssetId, reused: true },
        });
        return {
          renderId: render.id,
          outputAssetId: render.outputAssetId,
          durationMs: render.durationMs,
          outputSizeBytes: render.outputSizeBytes,
          subtitleCues: 0,
        };
      }
      if (render.status === 'cancelled') {
        throw new ValidationError(
          `Ce rendu a été annulé : il ne s’exécute plus. En créer un nouveau depuis le plan.`,
          {
            code: 'VIDEO_RENDER_NOT_RUNNABLE',
            details: { renderId: render.id, status: render.status },
          },
        );
      }

      const plan = render.plan;
      if (plan === null) {
        throw new ValidationError(
          'Le plan de ce rendu est illisible : il doit passer par la validation du schéma de plan.',
          { code: 'VIDEO_RENDER_PLAN_INVALID', details: { renderId: render.id } },
        );
      }

      const sourceAssetId = render.sourceAssetIds[0];
      const source = sourceAssetId === undefined ? null : deps.media.asset(sourceAssetId);
      if (!source || source.kind !== 'video') {
        throw new NotFoundError(`Vidéo source introuvable : ${sourceAssetId ?? '(aucune)'}`, {
          code: 'VIDEO_SOURCE_NOT_FOUND',
          details: { renderId: render.id, sourceAssetId: sourceAssetId ?? null },
        });
      }
      if (!(await deps.storage.exists(source.storageKey))) {
        throw new NotFoundError(`Fichier vidéo absent du stockage : ${source.storageKey}`, {
          code: 'MEDIA_FILE_MISSING',
        });
      }
      if (source.durationMs !== null && plan.endMs > source.durationMs) {
        throw new ValidationError(
          `Le plan dépasse la durée de la vidéo (${formatMs(plan.endMs)} > ${formatMs(
            source.durationMs,
          )}).`,
          { code: 'VIDEO_PLAN_BEYOND_SOURCE' },
        );
      }
      if (plan.endMs - plan.startMs > deps.maxClipMs) {
        throw new ValidationError(
          `Extrait trop long pour cette étape : ${formatMs(
            plan.endMs - plan.startMs,
          )} (maximum ${formatMs(deps.maxClipMs)}).`,
          { code: 'VIDEO_PLAN_TOO_LONG' },
        );
      }

      const transcript = deps.media.transcriptForAsset(source.id);
      if (!transcript) {
        throw new ValidationError(
          'Aucune transcription pour cette vidéo : les sous-titres brûlés en ont besoin. Lancer la transcription de la vidéo, puis relancer le rendu.',
          { code: 'VIDEO_TRANSCRIPT_REQUIRED', details: { sourceAssetId: source.id } },
        );
      }
      if (source.hasAudio !== true) {
        throw new ValidationError(
          'Cette vidéo n’a pas de piste audio : elle ne peut pas être transcrite, donc pas sous-titrée.',
          { code: 'VIDEO_HAS_NO_AUDIO', details: { sourceAssetId: source.id } },
        );
      }

      const version = await deps.ffmpeg.version();
      if (version === null) throw ffmpegUnavailable('binaire introuvable ou non exécutable');

      return deps.semaphore.run(async () => {
        deps.renders.markPreparing(render.id);
        await ctx.setStep('load_source', 10);
        await ctx.setStep('build_subtitles', 15);

        const workDir = await mkdtemp(
          join(deps.temporaryRoot ?? tmpdir(), `aia-render-${render.id.slice(-8)}-`),
        );
        const outputKey = renderStorageKey(render.id);
        const finalPath = deps.storage.getLocalPath(outputKey);
        const partPath = `${finalPath}.${randomUUID()}.part`;

        try {
          const cues = buildSubtitleCues({
            segments: transcript.segments,
            clipStartMs: plan.startMs,
            clipEndMs: plan.endMs,
          });
          if (cues.length === 0) {
            throw new ValidationError(
              'Cet extrait ne contient aucune parole transcrite : les sous-titres brûlés n’auraient rien à afficher. Modifier le début ou la fin de l’extrait.',
              { code: 'VIDEO_NO_SUBTITLES_IN_WINDOW', details: { renderId: render.id } },
            );
          }
          await writeFile(
            join(workDir, SUBTITLE_FILE_NAME),
            renderAssSubtitles(cues, {
              width: VERTICAL_FORMAT.width,
              height: VERTICAL_FORMAT.height,
            }),
            'utf8',
          );

          const args = buildVerticalShortArgs({
            inputPath: deps.storage.getLocalPath(source.storageKey),
            outputPath: partPath,
            plan,
            hasAudio: source.hasAudio === true,
            subtitleFileName: SUBTITLE_FILE_NAME,
          });
          // Les arguments **exacts** sont conservés avant l'exécution : un rendu qui
          // échoue doit pouvoir être expliqué, et rejoué à l'identique.
          deps.renders.recordCompiledArgs(render.id, args, version);

          await ctx.emitEvent({
            step: 'build_subtitles',
            progress: 20,
            message: `${cues.length} réplique(s) de sous-titres · ${describeRenderPlan(plan)}`,
            data: { renderId: render.id, cues: cues.length, preset: render.preset },
          });

          await mkdir(dirname(finalPath), { recursive: true });
          deps.renders.markRendering(render.id);
          await ctx.setStep('encode', 25);

          const durationMs = plan.endMs - plan.startMs;
          await deps.ffmpeg.runOrThrow(args, {
            cwd: workDir,
            expectedDurationMs: durationMs,
            signal: ctx.signal,
            onProgress: (progress) => {
              if (progress.percent === null) return;
              // 25 → 90 : l'encodage occupe les deux tiers de la barre, la
              // finalisation le reste. Aucun pourcentage n'est inventé : il vient
              // d'`out_time_us`, et le store ne le laisse jamais reculer.
              const mapped = 25 + Math.round(progress.percent * 0.65);
              deps.renders.setProgress(render.id, mapped);
              void ctx.setStep('encode', mapped);
            },
          });

          // --- Finalisation : probe, vérification, publication du fichier ------
          await ctx.setStep('finalize', 92);
          const produced = await deps.ffmpeg.probe(partPath);
          if (
            produced.width !== VERTICAL_FORMAT.width ||
            produced.height !== VERTICAL_FORMAT.height
          ) {
            throw new CapabilityError(
              `Le rendu n’est pas au format attendu (${produced.width ?? '?'}×${
                produced.height ?? '?'
              } au lieu de ${VERTICAL_FORMAT.width}×${VERTICAL_FORMAT.height}).`,
              { code: 'VIDEO_RENDER_FORMAT_MISMATCH' },
            );
          }
          if (produced.durationMs === null || produced.durationMs <= 0) {
            throw new CapabilityError(
              'Le fichier rendu est illisible : ffprobe ne mesure aucune durée.',
              { code: 'VIDEO_RENDER_UNREADABLE' },
            );
          }

          const size = await stat(partPath);
          // Renommage atomique : à partir d'ici, le fichier est **complet**.
          await rename(partPath, finalPath);

          const outputAsset = deps.media.createVideoAsset({
            projectId: render.projectId,
            role: 'subtitled',
            parentAssetId: source.id,
            storageKey: outputKey,
            originalFilename: null,
            mimeType: 'video/mp4',
            sizeBytes: size.size,
            sha256: await sha256File(finalPath),
            width: produced.width,
            height: produced.height,
            durationMs: produced.durationMs,
            codec: produced.videoCodec,
            fps: produced.fps,
            hasAudio: produced.hasAudio,
            language: transcript.language,
            source: 'render',
          });

          const completed = deps.renders.complete(render.id, {
            outputAssetId: outputAsset.id,
            durationMs: produced.durationMs,
            outputSizeBytes: size.size,
          });

          await ctx.emitEvent({
            step: 'done',
            progress: 100,
            message: `Rendu terminé : ${formatMs(produced.durationMs)} de vidéo verticale sous-titrée.`,
            data: {
              renderId: render.id,
              outputAssetId: outputAsset.id,
              durationMs: produced.durationMs,
              outputSizeBytes: size.size,
            },
          });

          return {
            renderId: completed.id,
            outputAssetId: outputAsset.id,
            durationMs: produced.durationMs,
            outputSizeBytes: size.size,
            subtitleCues: cues.length,
          };
        } catch (error) {
          recordRenderFailure(deps.renders, render.id, error);
          throw error;
        } finally {
          // Un rendu interrompu ne laisse ni fichier partiel ni sous-titres derrière lui.
          await rm(partPath, { force: true });
          await rm(workDir, { recursive: true, force: true });
        }
      });
    },
  };
}
