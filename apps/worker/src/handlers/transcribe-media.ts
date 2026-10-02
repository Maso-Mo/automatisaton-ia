import type { MediaStore } from '@aia/database';
import type { StorageAdapter, Transcriber } from '@aia/media';
import { transcribeMediaSpec, type JobDefinition, type TranscribeMediaInput } from '@aia/queue';
import { NotFoundError, ValidationError, type Clock } from '@aia/shared';

export interface TranscribeMediaOutput {
  assetId: string;
  transcriptId: string;
  language: string | null;
  durationMs: number | null;
}

/**
 * Le handler du job `transcribe_media` : **local, sans réseau, idempotent**.
 *
 * Quatre décisions valent d'être explicitées, parce qu'elles décident du
 * comportement en cas de panne :
 *
 * 1. **le fichier est vérifié avant d'appeler le décodeur** : un audio dont le
 *    fichier a disparu est un `not_found` (aucune reprise — réessayer ne fera
 *    pas réapparaître le fichier), pas une erreur transitoire ;
 * 2. **une transcription déjà là n'est pas refaite** : si un transcript du même
 *    moteur et du même modèle existe, le job se termine en le réutilisant. C'est
 *    l'idempotence qui protège la reprise après un bail expiré ;
 * 3. **la durée n'est plafonnée qu'ici**, après décodage : l'API reçoit un
 *    fichier, pas une durée fiable. Un dépassement est un `validation` : pas de
 *    reprise, et l'utilisateur voit le motif ;
 * 4. **le handler ne décide d'aucune reprise** (docs/02 §12) : il lève une erreur
 *    typée, la file tranche.
 */
export function createTranscribeMediaHandler(deps: {
  media: MediaStore;
  storage: StorageAdapter;
  transcriber: Transcriber;
  clock: Clock;
  /** Plafond de durée, en millisecondes. `0` (défaut) : aucun plafond. */
  maxDurationMs?: number;
}): JobDefinition<TranscribeMediaInput, TranscribeMediaOutput> {
  return {
    ...transcribeMediaSpec,
    handler: async (input, ctx) => {
      const asset = deps.media.asset(input.assetId);
      if (!asset || asset.kind !== 'audio') {
        throw new NotFoundError(`Média audio introuvable : ${input.assetId}`, {
          code: 'MEDIA_ASSET_NOT_FOUND',
        });
      }

      await ctx.setStep('load_audio', 5);
      if (!(await deps.storage.exists(asset.storageKey))) {
        throw new NotFoundError(`Fichier audio absent du stockage : ${asset.storageKey}`, {
          code: 'MEDIA_FILE_MISSING',
        });
      }

      const existing = deps.media.transcriptForAsset(asset.id);
      if (
        existing &&
        existing.engine === deps.transcriber.engine &&
        existing.model === deps.transcriber.model
      ) {
        await ctx.emitEvent({
          step: 'done',
          progress: 100,
          message: 'Transcription locale déjà disponible.',
          data: { transcriptId: existing.id, reused: true },
        });
        return {
          assetId: asset.id,
          transcriptId: existing.id,
          language: existing.language,
          durationMs: existing.durationMs,
        };
      }

      await ctx.setStep('normalize_audio', 15);
      const startedAt = deps.clock.nowMs();
      const result = await deps.transcriber.transcribe(
        deps.storage.getLocalPath(asset.storageKey),
        input.language,
      );
      const processingMs = Math.max(0, deps.clock.nowMs() - startedAt);

      const maxDurationMs = deps.maxDurationMs ?? 0;
      if (maxDurationMs > 0 && result.durationMs !== null && result.durationMs > maxDurationMs) {
        throw new ValidationError(
          `Enregistrement trop long : ${Math.round(result.durationMs / 1_000)} s (plafond ${Math.round(
            maxDurationMs / 1_000,
          )} s).`,
          {
            code: 'AUDIO_TOO_LONG',
            details: { durationMs: result.durationMs, maxDurationMs },
          },
        );
      }

      await ctx.setStep('persist_transcript', 90);
      const transcript = deps.media.saveTranscript({
        mediaAssetId: asset.id,
        engine: deps.transcriber.engine,
        model: deps.transcriber.model,
        language: result.language,
        text: result.text,
        segments: result.segments,
        durationMs: result.durationMs,
        processingMs,
      });
      deps.media.updateAssetMetadata(asset.id, {
        durationMs: result.durationMs,
        codec: 'pcm_s16le',
        language: result.language,
      });

      await ctx.emitEvent({
        step: 'done',
        progress: 100,
        message: 'Transcription locale terminée. Une relecture est requise avant envoi.',
        data: { transcriptId: transcript.id },
      });

      return {
        assetId: asset.id,
        transcriptId: transcript.id,
        language: transcript.language,
        durationMs: transcript.durationMs,
      };
    },
  };
}
