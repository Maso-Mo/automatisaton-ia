import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { messages } from './conversation';
import { projects } from './projects';

/** Fichiers locaux inventoriés ; le contenu binaire reste hors de SQLite. */
export const mediaAssets = sqliteTable(
  'media_assets',
  {
    id: text().primaryKey(),
    project_id: text().references(() => projects.id),
    kind: text().notNull(),
    role: text().notNull().default('original'),
    parent_asset_id: text(),
    storage_key: text().notNull(),
    original_filename: text(),
    mime_type: text().notNull(),
    size_bytes: integer().notNull(),
    sha256: text().notNull(),
    width: integer(),
    height: integer(),
    duration_ms: integer(),
    bitrate: integer(),
    codec: text(),
    fps: integer(),
    has_audio: integer({ mode: 'boolean' }),
    language: text(),
    source: text().notNull(),
    source_url: text(),
    usage_count: integer().notNull().default(0),
    last_used_at: integer(),
    created_at: integer().notNull(),
    deleted_at: integer(),
  },
  (table) => [
    uniqueIndex('uq_asset_hash').on(table.project_id, table.sha256, table.role),
    index('idx_assets_project').on(table.project_id, table.kind, table.deleted_at),
    index('idx_assets_orphans').on(table.usage_count, table.created_at),
    check('chk_assets_kind', sql`${table.kind} in ('audio','image','video','document')`),
    check(
      'chk_assets_role',
      sql`${table.role} in ('original','poster','thumbnail','vertical','square','subtitled','audio_normalized')`,
    ),
    check(
      'chk_assets_source',
      sql`${table.source} in ('upload','generated','url_import','render')`,
    ),
    check('chk_assets_size', sql`${table.size_bytes} > 0`),
    check('chk_assets_usage', sql`${table.usage_count} >= 0`),
  ],
);

/** Transcription brute et correction humaine restent toutes les deux auditables. */
export const transcripts = sqliteTable(
  'transcripts',
  {
    id: text().primaryKey(),
    media_asset_id: text()
      .notNull()
      .references(() => mediaAssets.id),
    engine: text().notNull(),
    model: text(),
    language: text(),
    text: text().notNull(),
    segments_json: text().notNull(),
    word_count: integer(),
    duration_ms: integer(),
    confidence: integer(),
    has_word_timestamps: integer({ mode: 'boolean' }).notNull().default(false),
    processing_ms: integer(),
    cost_micro_usd: integer().notNull().default(0),
    edited_body: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_transcript_asset').on(table.media_asset_id, table.engine, table.model),
    index('idx_transcripts_lang').on(table.language),
    check(
      'chk_transcripts_engine',
      sql`${table.engine} in ('whisper_cpp','faster_whisper','cloud')`,
    ),
    check('chk_transcripts_cost', sql`${table.cost_micro_usd} >= 0`),
  ],
);

/** Relation explicite entre un message et son audio, sans transformer le fichier en message. */
export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    id: text().primaryKey(),
    message_id: text()
      .notNull()
      .references(() => messages.id),
    media_asset_id: text()
      .notNull()
      .references(() => mediaAssets.id),
    kind: text().notNull(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_attachment').on(table.message_id, table.media_asset_id, table.kind),
    index('idx_attachments_asset').on(table.media_asset_id),
    check('chk_attachments_kind', sql`${table.kind} in ('audio','image','video','document')`),
  ],
);
