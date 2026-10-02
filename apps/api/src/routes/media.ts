import { getConversation, parseOrThrow, postMessageBodySchema } from '@aia/core';
import { detectAudioFormat, sha256, voiceStorageKey } from '@aia/media';
import { TRANSCRIBE_MEDIA_JOB } from '@aia/queue';
import { ConflictError, NotFoundError, ValidationError, uuidv7 } from '@aia/shared';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';
import { runConversationTurn } from '../features/conversation';

function requireAssetForConversation(context: ApiContext, conversationId: string, assetId: string) {
  const conversation = getConversation(context.conversation, conversationId);
  const asset = context.media.asset(assetId);
  if (!asset || asset.projectId !== conversation.projectId || asset.kind !== 'audio') {
    throw new NotFoundError(`Média vocal introuvable dans cette conversation : ${assetId}`, {
      code: 'VOICE_ASSET_NOT_FOUND',
    });
  }
  return { conversation, asset };
}

export function registerMediaRoutes(app: FastifyInstance, context: ApiContext): void {
  const maxUploadBytes = context.config.env.MEDIA_MAX_UPLOAD_MB * 1024 * 1024;

  app.get('/media/capabilities', async () => ({
    transcription: await context.transcriber.healthCheck(),
    maxUploadBytes,
    // Même valeur que celle appliquée par le worker après décodage : l'écran
    // annonce la limite que le serveur fait vraiment respecter.
    maxDurationMs: context.config.env.MEDIA_MAX_DURATION_S * 1_000,
    acceptedMimeTypes: [
      'audio/webm',
      'video/webm',
      'audio/ogg',
      'audio/wav',
      'audio/mpeg',
      'audio/mp4',
    ],
  }));

  app.post('/conversations/:id/voice', { bodyLimit: maxUploadBytes }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(context.conversation, id);
    if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
      throw new ValidationError('Un enregistrement audio non vide est requis.', {
        code: 'VOICE_BODY_REQUIRED',
      });
    }

    const audio = request.body;
    const detected = detectAudioFormat(audio, request.headers['content-type'] ?? '');
    const hash = sha256(audio);
    let asset = context.media.assetByHash(conversation.projectId, hash);
    // Ce que cette requête a créé, et qu'elle a donc le droit de défaire.
    let createdHere = false;

    if (!asset) {
      const assetId = uuidv7(context.clock.nowMs());
      const storageKey = voiceStorageKey(hash, assetId, detected.extension, context.clock.now());
      await context.mediaStorage.put(storageKey, audio);
      try {
        asset = context.media.createAudioAsset({
          id: assetId,
          projectId: conversation.projectId,
          storageKey,
          // Le nom d'origine du client n'est **jamais** repris : la clé de
          // stockage est fabriquée par le serveur (`voiceStorageKey`), donc
          // aucune traversée de répertoire n'est possible depuis l'entrée.
          originalFilename: null,
          mimeType: detected.mime,
          sizeBytes: audio.byteLength,
          sha256: hash,
        });
        createdHere = true;
      } catch (error) {
        await context.mediaStorage.delete(storageKey);
        throw error;
      }
    } else if (!(await context.mediaStorage.exists(asset.storageKey))) {
      await context.mediaStorage.put(asset.storageKey, audio);
    }

    try {
      const jobId = await context.mediaQueue.enqueue(
        TRANSCRIBE_MEDIA_JOB,
        { assetId: asset.id, language: 'fr' },
        { projectId: conversation.projectId, requiresNetwork: false },
      );

      reply.status(202);
      return { asset, jobId };
    } catch (error) {
      // Aucun orphelin laissé derrière soi : si le job n'a pas pu être créé,
      // l'audio n'a plus aucun consommateur. On le retire — mais **seulement**
      // s'il vient d'être créé par cette requête : l'audio d'un envoi
      // précédent (déduplication par empreinte) ne nous appartient pas.
      if (createdHere) {
        await context.mediaStorage.delete(asset.storageKey);
        context.media.deleteAsset(asset.id);
      }
      throw error;
    }
  });

  app.get('/conversations/:id/voice/:assetId/transcript', async (request) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const { asset } = requireAssetForConversation(context, id, assetId);
    return { asset, transcript: context.media.transcriptForAsset(asset.id) };
  });

  /**
   * **Annuler** un enregistrement qui n'a pas encore été envoyé.
   *
   * C'est la seule suppression d'audio autorisée par l'interface : un audio
   * rattaché à un message est refusé (`409`) parce qu'il est la preuve de ce qui
   * a été publié (docs/03 §12.1). Un audio qui n'a jamais été envoyé est un
   * brouillon : le garder n'a aucune valeur, et le laisser grossir le disque non
   * plus. Un job de transcription encore en file pour cet audio échouera en
   * `not_found` — sans reprise, ce qui est le comportement voulu.
   */
  app.delete('/conversations/:id/voice/:assetId', async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const { asset } = requireAssetForConversation(context, id, assetId);
    if (asset.usageCount > 0) {
      throw new ConflictError(
        'Enregistrement déjà rattaché à un message : il ne peut plus être supprimé.',
        { code: 'VOICE_ASSET_IN_USE', details: { assetId: asset.id } },
      );
    }

    await context.mediaStorage.delete(asset.storageKey);
    context.media.deleteAsset(asset.id);
    reply.status(204);
    return null;
  });

  app.post('/conversations/:id/voice/:assetId/send', async (request, reply) => {
    const { id, assetId } = request.params as { id: string; assetId: string };
    const { asset } = requireAssetForConversation(context, id, assetId);
    const transcript = context.media.transcriptForAsset(asset.id);
    if (!transcript) {
      throw new NotFoundError(`Transcription introuvable pour le média : ${asset.id}`, {
        code: 'TRANSCRIPT_NOT_FOUND',
      });
    }

    const body = parseOrThrow(postMessageBodySchema, request.body, 'TRANSCRIPT_INPUT_INVALID');
    const content = body.content.trim();
    if (content.length === 0) {
      throw new ValidationError('La transcription corrigée ne peut pas être vide.', {
        code: 'TRANSCRIPT_EMPTY',
      });
    }

    context.media.updateEditedBody(transcript.id, content);
    const result = await runConversationTurn(context.conversationFeature, id, {
      content,
      inputMode: 'voice',
      audioAssetId: asset.id,
      transcriptStatus: 'done',
    });
    context.media.attachToMessage(result.userMessage.id, asset.id);

    reply.status(201);
    return {
      conversation: result.conversation,
      userMessage: result.userMessage,
      message: result.assistantMessage,
      plan: result.plan,
      usage: result.usage,
      repaired: result.repaired,
      transcript: context.media.transcript(transcript.id),
    };
  });
}
