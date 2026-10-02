import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { encodeJson, parseJsonUnknown, uuidv7, type AsrEngine } from '@aia/shared';
import type { DatabaseHandle } from '../client';
import { mediaAssets, messageAttachments, transcripts } from '../schema';

export interface MediaAssetRecord {
  id: string;
  projectId: string | null;
  kind: 'audio' | 'image' | 'video' | 'document';
  role: string;
  /** L'asset d'origine dont celui-ci dérive (un rendu vertical dérive d'une vidéo). */
  parentAssetId: string | null;
  storageKey: string;
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  bitrate: number | null;
  codec: string | null;
  fps: number | null;
  hasAudio: boolean | null;
  source: 'upload' | 'generated' | 'url_import' | 'render';
  language: string | null;
  usageCount: number;
  createdAt: number;
}

export interface TranscriptSegmentRecord {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptRecord {
  id: string;
  mediaAssetId: string;
  engine: AsrEngine;
  model: string | null;
  language: string | null;
  text: string;
  segments: TranscriptSegmentRecord[];
  wordCount: number | null;
  durationMs: number | null;
  confidence: number | null;
  hasWordTimestamps: boolean;
  processingMs: number | null;
  costMicroUsd: number;
  editedBody: string | null;
  createdAt: number;
}

function decodeSegments(raw: string): TranscriptSegmentRecord[] {
  const parsed = parseJsonUnknown(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  return parsed.value.filter(
    (entry): entry is TranscriptSegmentRecord =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as TranscriptSegmentRecord).startMs === 'number' &&
      typeof (entry as TranscriptSegmentRecord).endMs === 'number' &&
      typeof (entry as TranscriptSegmentRecord).text === 'string',
  );
}

export function createMediaStore(handle: DatabaseHandle, nowMs: () => number) {
  const newId = (): string => uuidv7(nowMs());
  const toAsset = (row: typeof mediaAssets.$inferSelect): MediaAssetRecord => ({
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as MediaAssetRecord['kind'],
    role: row.role,
    parentAssetId: row.parent_asset_id,
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    bitrate: row.bitrate,
    codec: row.codec,
    fps: row.fps,
    hasAudio: row.has_audio,
    source: row.source as MediaAssetRecord['source'],
    language: row.language,
    usageCount: row.usage_count,
    createdAt: row.created_at,
  });
  const toTranscript = (row: typeof transcripts.$inferSelect): TranscriptRecord => ({
    id: row.id,
    mediaAssetId: row.media_asset_id,
    engine: row.engine as AsrEngine,
    model: row.model,
    language: row.language,
    text: row.text,
    segments: decodeSegments(row.segments_json),
    wordCount: row.word_count,
    durationMs: row.duration_ms,
    confidence: row.confidence,
    hasWordTimestamps: row.has_word_timestamps,
    processingMs: row.processing_ms,
    costMicroUsd: row.cost_micro_usd,
    editedBody: row.edited_body,
    createdAt: row.created_at,
  });

  return {
    asset(id: string): MediaAssetRecord | null {
      const row = handle.db.select().from(mediaAssets).where(eq(mediaAssets.id, id)).get();
      return row ? toAsset(row) : null;
    },
    assetByHash(projectId: string, sha256: string): MediaAssetRecord | null {
      const row = handle.db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.project_id, projectId), eq(mediaAssets.sha256, sha256)))
        .get();
      return row ? toAsset(row) : null;
    },
    /**
     * Les assets d'un projet, par type. Le tri est du plus récent au plus ancien :
     * c'est ce que l'écran vidéo affiche (dernier import en haut), et il ne
     * dépend donc pas de l'ordre d'insertion.
     */
    listAssets(
      projectId: string,
      filter: { kind?: MediaAssetRecord['kind']; limit?: number } = {},
    ): MediaAssetRecord[] {
      const conditions = [eq(mediaAssets.project_id, projectId), isNull(mediaAssets.deleted_at)];
      if (filter.kind) conditions.push(eq(mediaAssets.kind, filter.kind));
      return handle.db
        .select()
        .from(mediaAssets)
        .where(and(...conditions))
        .orderBy(desc(mediaAssets.created_at))
        .limit(filter.limit ?? 50)
        .all()
        .map(toAsset);
    },
    /**
     * Les audios que **rien ne référence** et qui sont plus vieux que la fenêtre
     * de rétention : les seuls candidats à la suppression (voir
     * `decideAudioPurge` dans `@aia/media`). La requête filtre
     * `usage_count = 0` : un audio rattaché à un message n'est jamais proposé.
     */
    orphanAudioAssets(cutoffMs: number, limit = 200): MediaAssetRecord[] {
      const rows = handle.db
        .select()
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.kind, 'audio'),
            eq(mediaAssets.usage_count, 0),
            isNull(mediaAssets.deleted_at),
            lte(mediaAssets.created_at, cutoffMs),
          ),
        )
        .orderBy(mediaAssets.created_at)
        .limit(limit)
        .all();
      return rows.map(toAsset);
    },
    /**
     * Supprime un audio **et ses dépendances**, dans l'ordre des clés
     * étrangères. L'usage prévu est celui d'une purge : un audio rattaché à un
     * message n'arrive jamais ici (le compteur `usage_count` le protège), et
     * `message_attachments` est vidé par acquittement de la contrainte, pas par
     * confort.
     */
    deleteAsset(id: string): void {
      handle.sqlite.transaction(() => {
        handle.db.delete(messageAttachments).where(eq(messageAttachments.media_asset_id, id)).run();
        handle.db.delete(transcripts).where(eq(transcripts.media_asset_id, id)).run();
        handle.db.delete(mediaAssets).where(eq(mediaAssets.id, id)).run();
      })();
    },
    createAudioAsset(input: {
      id?: string;
      projectId: string;
      storageKey: string;
      originalFilename: string | null;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
    }): MediaAssetRecord {
      const existing = this.assetByHash(input.projectId, input.sha256);
      if (existing) return existing;
      const id = input.id ?? newId();
      handle.db
        .insert(mediaAssets)
        .values({
          id,
          project_id: input.projectId,
          kind: 'audio',
          role: 'original',
          storage_key: input.storageKey,
          original_filename: input.originalFilename,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
          sha256: input.sha256,
          has_audio: true,
          source: 'upload',
          created_at: nowMs(),
        })
        .run();
      return this.asset(id)!;
    },
    /**
     * Crée un **asset vidéo** — importé (`source: 'upload'`) ou produit par un
     * rendu (`source: 'render'`, `role: 'vertical'` ou `'subtitled'`).
     *
     * Un rendu n'est **jamais** un remplacement : c'est un nouvel asset, rattaché à
     * son original par `parentAssetId` (docs/05 §6.4 : « le rendu est un nouvel
     * asset, jamais un remplacement »).
     */
    createVideoAsset(input: {
      id?: string;
      projectId: string;
      role?: 'original' | 'vertical' | 'subtitled' | 'thumbnail' | 'poster';
      parentAssetId?: string | null;
      storageKey: string;
      originalFilename?: string | null;
      mimeType: string;
      sizeBytes: number;
      sha256: string;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      codec: string | null;
      fps: number | null;
      hasAudio: boolean;
      language?: string | null;
      source: 'upload' | 'render';
    }): MediaAssetRecord {
      const id = input.id ?? newId();
      handle.db
        .insert(mediaAssets)
        .values({
          id,
          project_id: input.projectId,
          kind: 'video',
          role: input.role ?? 'original',
          parent_asset_id: input.parentAssetId ?? null,
          storage_key: input.storageKey,
          original_filename: input.originalFilename ?? null,
          mime_type: input.mimeType,
          size_bytes: input.sizeBytes,
          sha256: input.sha256,
          width: input.width,
          height: input.height,
          duration_ms: input.durationMs,
          codec: input.codec,
          fps: input.fps,
          has_audio: input.hasAudio,
          language: input.language ?? null,
          source: input.source,
          created_at: nowMs(),
        })
        .run();
      return this.asset(id)!;
    },
    updateAssetMetadata(
      id: string,
      input: { durationMs: number | null; codec?: string | null; language?: string | null },
    ): void {
      handle.db
        .update(mediaAssets)
        .set({
          duration_ms: input.durationMs,
          codec: input.codec,
          language: input.language,
        })
        .where(eq(mediaAssets.id, id))
        .run();
    },
    transcript(id: string): TranscriptRecord | null {
      const row = handle.db.select().from(transcripts).where(eq(transcripts.id, id)).get();
      return row ? toTranscript(row) : null;
    },
    transcriptForAsset(assetId: string): TranscriptRecord | null {
      const row = handle.db
        .select()
        .from(transcripts)
        .where(eq(transcripts.media_asset_id, assetId))
        .orderBy(desc(transcripts.created_at))
        .get();
      return row ? toTranscript(row) : null;
    },
    saveTranscript(input: {
      mediaAssetId: string;
      engine: AsrEngine;
      model: string;
      language: string | null;
      text: string;
      segments: TranscriptSegmentRecord[];
      durationMs: number | null;
      processingMs: number;
    }): TranscriptRecord {
      const existing = this.transcriptForAsset(input.mediaAssetId);
      if (existing && existing.engine === input.engine && existing.model === input.model) {
        return existing;
      }
      const id = newId();
      handle.db
        .insert(transcripts)
        .values({
          id,
          media_asset_id: input.mediaAssetId,
          engine: input.engine,
          model: input.model,
          language: input.language,
          text: input.text,
          segments_json: encodeJson(input.segments),
          word_count: input.text.trim().split(/\s+/).filter(Boolean).length,
          duration_ms: input.durationMs,
          confidence: null,
          has_word_timestamps: false,
          processing_ms: input.processingMs,
          cost_micro_usd: 0,
          created_at: nowMs(),
        })
        .run();
      return this.transcript(id)!;
    },
    updateEditedBody(id: string, editedBody: string): TranscriptRecord | null {
      handle.db
        .update(transcripts)
        .set({ edited_body: editedBody })
        .where(eq(transcripts.id, id))
        .run();
      return this.transcript(id);
    },
    attachToMessage(messageId: string, assetId: string): void {
      handle.sqlite.transaction(() => {
        handle.db
          .insert(messageAttachments)
          .values({
            id: newId(),
            message_id: messageId,
            media_asset_id: assetId,
            kind: 'audio',
            created_at: nowMs(),
          })
          .onConflictDoNothing()
          .run();
        handle.db
          .update(mediaAssets)
          .set({ usage_count: sql`${mediaAssets.usage_count} + 1`, last_used_at: nowMs() })
          .where(eq(mediaAssets.id, assetId))
          .run();
      })();
    },
  };
}

export type MediaStore = ReturnType<typeof createMediaStore>;
