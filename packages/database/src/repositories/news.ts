import { and, desc, eq } from 'drizzle-orm';
import { encodeJson, uuidv7 } from '@aia/shared';
import type { DatabaseHandle } from '../client';
import { newsItems, newsSources } from '../schema';

/**
 * Persistance de la **veille** — schéma de l'étape 7, pipeline de l'étape 10.
 *
 * Ce module s'arrête volontairement au modèle de données : créer une source,
 * insérer une actualité **déjà récupérée**, la relire, la dédupliquer. Aucune
 * fonction de collecte, de scoring ou d'appel LLM n'existe ici — ce serait écrire
 * l'étape 10 à moitié, et le pipeline de veille n'a pas encore de source à lire
 * (docs/10 §4.7).
 *
 * La déduplication est **stricte** (`uq_news_hash`) : le même titre et la même URL
 * normalisés ne créent qu'une ligne. Insérer deux fois n'est pas une erreur, c'est
 * un cas normal — un flux relu renvoie ses items à chaque passage.
 */

export interface NewsSourceRecord {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  url: string | null;
  language: string | null;
  authority: number;
  enabled: boolean;
  refreshHours: number;
  lastFetchAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  createdAt: number;
  updatedAt: number;
}

export interface NewsItemRecord {
  id: string;
  projectId: string;
  sourceId: string;
  title: string;
  summary: string | null;
  url: string;
  canonicalUrl: string | null;
  publishedAt: number | null;
  fetchedAt: number;
  language: string | null;
  contentHash: string;
  finalScore: number | null;
  topicTags: string[];
  status: string;
  verified: boolean;
  llmEnriched: boolean;
  createdAt: number;
  expiresAt: number | null;
}

/** Les états d'une actualité dans le classement (docs/03 §13.2). */
export type NewsItemStatus = 'new' | 'shortlisted' | 'used' | 'dismissed' | 'expired';

function decodeTags(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === 'string')
      : [];
  } catch {
    return [];
  }
}

function toSource(row: typeof newsSources.$inferSelect): NewsSourceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    language: row.language,
    authority: row.authority,
    enabled: row.enabled,
    refreshHours: row.refresh_hours,
    lastFetchAt: row.last_fetch_at,
    lastSuccessAt: row.last_success_at,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toItem(row: typeof newsItems.$inferSelect): NewsItemRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceId: row.source_id,
    title: row.title,
    summary: row.summary,
    url: row.url,
    canonicalUrl: row.canonical_url,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    language: row.language,
    contentHash: row.content_hash,
    finalScore: row.final_score,
    topicTags: decodeTags(row.topic_tags_json),
    status: row.status,
    verified: row.verified,
    llmEnriched: row.llm_enriched,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createNewsStore(handle: DatabaseHandle, nowMs: () => number) {
  const newId = (): string => uuidv7(nowMs());

  return {
    createSource(input: {
      id?: string;
      projectId: string;
      name: string;
      kind: 'rss' | 'atom' | 'api' | 'manual';
      url?: string | null;
      language?: string | null;
      authority?: number;
      refreshHours?: number;
      keywords?: readonly string[];
      excludeKeywords?: readonly string[];
    }): NewsSourceRecord {
      const id = input.id ?? newId();
      const now = nowMs();
      handle.db
        .insert(newsSources)
        .values({
          id,
          project_id: input.projectId,
          name: input.name,
          kind: input.kind,
          url: input.url ?? null,
          keywords_json: input.keywords ? encodeJson(input.keywords) : null,
          exclude_keywords_json: input.excludeKeywords ? encodeJson(input.excludeKeywords) : null,
          language: input.language ?? null,
          authority: input.authority ?? 3,
          enabled: true,
          refresh_hours: input.refreshHours ?? 12,
          created_at: now,
          updated_at: now,
        })
        .run();
      return this.sourceById(id)!;
    },

    sourceById(id: string): NewsSourceRecord | null {
      const row = handle.db.select().from(newsSources).where(eq(newsSources.id, id)).get();
      return row ? toSource(row) : null;
    },

    listSources(projectId: string): NewsSourceRecord[] {
      return handle.db
        .select()
        .from(newsSources)
        .where(eq(newsSources.project_id, projectId))
        .orderBy(desc(newsSources.created_at))
        .all()
        .map(toSource);
    },

    setSourceEnabled(id: string, enabled: boolean): NewsSourceRecord | null {
      handle.db
        .update(newsSources)
        .set({ enabled, updated_at: nowMs() })
        .where(eq(newsSources.id, id))
        .run();
      return this.sourceById(id);
    },

    /**
     * Insère une actualité **déjà récupérée**. Un `content_hash` déjà présent ne
     * crée rien : `created` vaut alors `false`, et l'appelant sait qu'il n'a pas de
     * nouvelle ligne — c'est le cas normal d'un flux relu.
     */
    insertItem(input: {
      id?: string;
      projectId: string;
      sourceId: string;
      title: string;
      url: string;
      canonicalUrl?: string | null;
      summary?: string | null;
      contentHash: string;
      publishedAt?: number | null;
      language?: string | null;
      rawJson?: string | null;
      topicTags?: readonly string[];
      expiresAt?: number | null;
    }): { item: NewsItemRecord; created: boolean } {
      const existing = handle.db
        .select()
        .from(newsItems)
        .where(
          and(
            eq(newsItems.project_id, input.projectId),
            eq(newsItems.content_hash, input.contentHash),
          ),
        )
        .get();
      if (existing) return { item: toItem(existing), created: false };

      const id = input.id ?? newId();
      const now = nowMs();
      handle.db
        .insert(newsItems)
        .values({
          id,
          project_id: input.projectId,
          source_id: input.sourceId,
          title: input.title,
          summary: input.summary ?? null,
          url: input.url,
          canonical_url: input.canonicalUrl ?? null,
          published_at: input.publishedAt ?? null,
          fetched_at: now,
          language: input.language ?? null,
          raw_json: input.rawJson ?? null,
          content_hash: input.contentHash,
          topic_tags_json: input.topicTags ? encodeJson(input.topicTags) : null,
          status: 'new',
          verified: true,
          llm_enriched: false,
          created_at: now,
          expires_at: input.expiresAt ?? null,
        })
        .run();
      return { item: this.itemById(id)!, created: true };
    },

    itemById(id: string): NewsItemRecord | null {
      const row = handle.db.select().from(newsItems).where(eq(newsItems.id, id)).get();
      return row ? toItem(row) : null;
    },

    listItems(
      projectId: string,
      filter: { status?: NewsItemStatus; sourceId?: string; limit?: number } = {},
    ): NewsItemRecord[] {
      const conditions = [eq(newsItems.project_id, projectId)];
      if (filter.status) conditions.push(eq(newsItems.status, filter.status));
      if (filter.sourceId) conditions.push(eq(newsItems.source_id, filter.sourceId));
      return handle.db
        .select()
        .from(newsItems)
        .where(and(...conditions))
        .orderBy(desc(newsItems.created_at))
        .limit(filter.limit ?? 50)
        .all()
        .map(toItem);
    },
  };
}

export type NewsStore = ReturnType<typeof createNewsStore>;
