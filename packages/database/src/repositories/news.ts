import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { encodeJson, uuidv7 } from '@aia/shared';
import type { DatabaseHandle } from '../client';
import { appSettings, newsItems, newsSources } from '../schema';

export type NewsSourceKindRecord = 'rss' | 'atom' | 'web' | 'api' | 'manual';
export type NewsItemStatus = 'new' | 'shortlisted' | 'used' | 'dismissed' | 'expired';
export type NewsUrgencyRecord = 'BREAKING' | 'HIGH' | 'NORMAL' | 'EVERGREEN';
export type NewsVerificationRecord = 'source_confirmed' | 'needs_review' | 'confirmed' | 'disputed';

export interface NewsSourceRecord {
  id: string;
  projectId: string;
  name: string;
  kind: NewsSourceKindRecord;
  url: string | null;
  categories: string[];
  keywords: string[];
  excludeKeywords: string[];
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
  externalId: string | null;
  title: string;
  summary: string | null;
  url: string;
  canonicalUrl: string | null;
  author: string | null;
  publishedAt: number | null;
  discoveredAt: number;
  language: string | null;
  contentHash: string;
  relevanceScore: number | null;
  freshnessScore: number | null;
  trustScore: number | null;
  noveltyScore: number | null;
  projectMatchScore: number | null;
  audienceMatchScore: number | null;
  finalScore: number | null;
  scoreExplanation: string[];
  categories: string[];
  /** Alias historique conservé pour les consommateurs de l'étape 7. */
  topicTags: string[];
  matchedSkill: string | null;
  urgency: NewsUrgencyRecord;
  verificationStatus: NewsVerificationRecord;
  claims: string[];
  suggestion: Record<string, unknown> | null;
  status: NewsItemStatus;
  dismissalReason: string | null;
  verified: boolean;
  llmEnriched: boolean;
  createdAt: number;
  expiresAt: number | null;
}

function decodeStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function decodeObject(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toSource(row: typeof newsSources.$inferSelect): NewsSourceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    kind: row.kind as NewsSourceKindRecord,
    url: row.url,
    categories: decodeStringArray(row.categories_json),
    keywords: decodeStringArray(row.keywords_json),
    excludeKeywords: decodeStringArray(row.exclude_keywords_json),
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
    externalId: row.external_id,
    title: row.title,
    summary: row.summary,
    url: row.url,
    canonicalUrl: row.canonical_url,
    author: row.author,
    publishedAt: row.published_at,
    discoveredAt: row.fetched_at,
    language: row.language,
    contentHash: row.content_hash,
    relevanceScore: row.relevance_score,
    freshnessScore: row.freshness_score,
    trustScore: row.authority_score,
    noveltyScore: row.novelty_score,
    projectMatchScore: row.project_match_score,
    audienceMatchScore: row.audience_match_score,
    finalScore: row.final_score,
    scoreExplanation: decodeStringArray(row.score_explanation_json),
    categories: decodeStringArray(row.topic_tags_json),
    topicTags: decodeStringArray(row.topic_tags_json),
    matchedSkill: row.matched_skill,
    urgency: row.urgency as NewsUrgencyRecord,
    verificationStatus: row.verification_status as NewsVerificationRecord,
    claims: decodeStringArray(row.claims_json),
    suggestion: decodeObject(row.suggestion_json),
    status: row.status as NewsItemStatus,
    dismissalReason: row.dismissal_reason,
    verified: row.verified,
    llmEnriched: row.llm_enriched,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export function createNewsStore(handle: DatabaseHandle, nowMs: () => number) {
  const newId = (): string => uuidv7(nowMs());
  const touchRevision = (): void => {
    const now = nowMs();
    handle.db
      .insert(appSettings)
      .values({ key: 'news.revision', value_json: '1', value_type: 'number', updated_at: now })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value_json: sql`cast(cast(${appSettings.value_json} as integer) + 1 as text)`,
          value_type: 'number',
          updated_at: now,
        },
      })
      .run();
  };

  return {
    createSource(input: {
      id?: string;
      projectId: string;
      name: string;
      kind: NewsSourceKindRecord;
      url?: string | null;
      categories?: readonly string[];
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
          categories_json: encodeJson(input.categories ?? []),
          keywords_json: encodeJson(input.keywords ?? []),
          exclude_keywords_json: encodeJson(input.excludeKeywords ?? []),
          language: input.language ?? null,
          authority: input.authority ?? 3,
          enabled: true,
          refresh_hours: input.refreshHours ?? 12,
          created_at: now,
          updated_at: now,
        })
        .run();
      touchRevision();
      return this.sourceById(id)!;
    },

    sourceById(id: string): NewsSourceRecord | null {
      const row = handle.db.select().from(newsSources).where(eq(newsSources.id, id)).get();
      return row ? toSource(row) : null;
    },

    listSources(projectId?: string): NewsSourceRecord[] {
      return (
        projectId
          ? handle.db
              .select()
              .from(newsSources)
              .where(eq(newsSources.project_id, projectId))
              .orderBy(desc(newsSources.created_at))
              .all()
          : handle.db.select().from(newsSources).orderBy(desc(newsSources.created_at)).all()
      ).map(toSource);
    },

    listDueSources(now = nowMs()): NewsSourceRecord[] {
      return handle.db
        .select()
        .from(newsSources)
        .where(
          and(
            eq(newsSources.enabled, true),
            or(
              isNull(newsSources.last_fetch_at),
              sql`${newsSources.last_fetch_at} + ${newsSources.refresh_hours} * 3600000 <= ${now}`,
            ),
          ),
        )
        .all()
        .map(toSource);
    },

    updateSource(
      id: string,
      patch: Partial<{
        name: string;
        url: string;
        categories: string[];
        keywords: string[];
        excludeKeywords: string[];
        language: string | null;
        authority: number;
        refreshHours: number;
        enabled: boolean;
      }>,
    ): NewsSourceRecord | null {
      const now = nowMs();
      const set: Partial<typeof newsSources.$inferInsert> = { updated_at: now };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.url !== undefined) set.url = patch.url;
      if (patch.categories !== undefined) set.categories_json = encodeJson(patch.categories);
      if (patch.keywords !== undefined) set.keywords_json = encodeJson(patch.keywords);
      if (patch.excludeKeywords !== undefined)
        set.exclude_keywords_json = encodeJson(patch.excludeKeywords);
      if (patch.language !== undefined) set.language = patch.language;
      if (patch.authority !== undefined) set.authority = patch.authority;
      if (patch.refreshHours !== undefined) set.refresh_hours = patch.refreshHours;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      const changed = handle.db.update(newsSources).set(set).where(eq(newsSources.id, id)).run();
      if (changed.changes > 0) touchRevision();
      return changed.changes > 0 ? this.sourceById(id) : null;
    },

    recordSourceSuccess(id: string): NewsSourceRecord | null {
      const now = nowMs();
      handle.db
        .update(newsSources)
        .set({
          last_fetch_at: now,
          last_success_at: now,
          last_error: null,
          consecutive_failures: 0,
          updated_at: now,
        })
        .where(eq(newsSources.id, id))
        .run();
      touchRevision();
      return this.sourceById(id);
    },

    recordSourceFailure(id: string, message: string): NewsSourceRecord | null {
      const current = this.sourceById(id);
      if (!current) return null;
      const failures = current.consecutiveFailures + 1;
      const now = nowMs();
      handle.db
        .update(newsSources)
        .set({
          last_fetch_at: now,
          last_error: message,
          consecutive_failures: failures,
          enabled: failures < 5,
          updated_at: now,
        })
        .where(eq(newsSources.id, id))
        .run();
      touchRevision();
      return this.sourceById(id);
    },

    findDuplicate(input: {
      projectId: string;
      sourceId: string;
      externalId?: string | null;
      canonicalUrl?: string | null;
      contentHash: string;
    }): NewsItemRecord | null {
      const identity = [eq(newsItems.content_hash, input.contentHash)];
      if (input.canonicalUrl) identity.push(eq(newsItems.canonical_url, input.canonicalUrl));
      if (input.externalId) {
        identity.push(
          and(
            eq(newsItems.source_id, input.sourceId),
            eq(newsItems.external_id, input.externalId),
          )!,
        );
      }
      const row = handle.db
        .select()
        .from(newsItems)
        .where(and(eq(newsItems.project_id, input.projectId), or(...identity)))
        .get();
      return row ? toItem(row) : null;
    },

    insertItem(input: {
      id?: string;
      projectId: string;
      sourceId: string;
      externalId?: string | null;
      title: string;
      url: string;
      canonicalUrl?: string | null;
      summary?: string | null;
      author?: string | null;
      contentHash: string;
      publishedAt?: number | null;
      language?: string | null;
      rawJson?: string | null;
      categories?: readonly string[];
      topicTags?: readonly string[];
      expiresAt?: number | null;
      score?: {
        relevance: number;
        freshness: number;
        trust: number;
        projectMatch: number;
        audienceMatch: number;
        final: number;
        explanation: string[];
      };
      urgency?: NewsUrgencyRecord;
      verificationStatus?: NewsVerificationRecord;
      claims?: string[];
    }): { item: NewsItemRecord; created: boolean } {
      const existing = this.findDuplicate(input);
      if (existing) return { item: existing, created: false };
      const id = input.id ?? newId();
      const now = nowMs();
      handle.db
        .insert(newsItems)
        .values({
          id,
          project_id: input.projectId,
          source_id: input.sourceId,
          external_id: input.externalId ?? null,
          title: input.title,
          summary: input.summary ?? null,
          url: input.url,
          canonical_url: input.canonicalUrl ?? null,
          author: input.author ?? null,
          published_at: input.publishedAt ?? null,
          fetched_at: now,
          language: input.language ?? null,
          raw_json: input.rawJson ?? null,
          content_hash: input.contentHash,
          relevance_score: input.score?.relevance ?? null,
          freshness_score: input.score?.freshness ?? null,
          authority_score: input.score?.trust ?? null,
          novelty_score: 100,
          project_match_score: input.score?.projectMatch ?? null,
          audience_match_score: input.score?.audienceMatch ?? null,
          final_score: input.score?.final ?? null,
          score_explanation_json: encodeJson(input.score?.explanation ?? []),
          topic_tags_json: encodeJson(input.categories ?? input.topicTags ?? []),
          urgency: input.urgency ?? 'NORMAL',
          verification_status: input.verificationStatus ?? 'source_confirmed',
          claims_json: encodeJson(input.claims ?? []),
          status: input.score && input.score.final < 35 ? 'dismissed' : 'new',
          dismissal_reason:
            input.score && input.score.final < 35
              ? 'Score local inférieur au seuil de pertinence (35/100).'
              : null,
          verified: true,
          llm_enriched: false,
          created_at: now,
          expires_at: input.expiresAt ?? null,
        })
        .run();
      touchRevision();
      return { item: this.itemById(id)!, created: true };
    },

    itemById(id: string): NewsItemRecord | null {
      const row = handle.db.select().from(newsItems).where(eq(newsItems.id, id)).get();
      return row ? toItem(row) : null;
    },

    listItems(
      filterOrProjectId:
        | {
            projectId?: string;
            status?: NewsItemStatus;
            sourceId?: string;
            urgency?: NewsUrgencyRecord;
            minScore?: number;
            since?: number;
            limit?: number;
          }
        | string = {},
    ): NewsItemRecord[] {
      const filter =
        typeof filterOrProjectId === 'string'
          ? { projectId: filterOrProjectId }
          : filterOrProjectId;
      const conditions = [];
      if (filter.projectId) conditions.push(eq(newsItems.project_id, filter.projectId));
      if (filter.status) conditions.push(eq(newsItems.status, filter.status));
      if (filter.sourceId) conditions.push(eq(newsItems.source_id, filter.sourceId));
      if (filter.urgency) conditions.push(eq(newsItems.urgency, filter.urgency));
      if (filter.minScore !== undefined)
        conditions.push(gte(newsItems.final_score, filter.minScore));
      if (filter.since !== undefined) conditions.push(gte(newsItems.fetched_at, filter.since));
      return handle.db
        .select()
        .from(newsItems)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(newsItems.final_score), desc(newsItems.published_at))
        .limit(filter.limit ?? 50)
        .all()
        .map(toItem);
    },

    recentForSimilarity(projectId: string, since: number): NewsItemRecord[] {
      return handle.db
        .select()
        .from(newsItems)
        .where(and(eq(newsItems.project_id, projectId), gte(newsItems.created_at, since)))
        .orderBy(desc(newsItems.created_at))
        .limit(200)
        .all()
        .map(toItem);
    },

    setItemStatus(
      id: string,
      status: NewsItemStatus,
      dismissalReason?: string | null,
    ): NewsItemRecord | null {
      const changed = handle.db
        .update(newsItems)
        .set({ status, dismissal_reason: dismissalReason ?? null })
        .where(eq(newsItems.id, id))
        .run();
      if (changed.changes > 0) touchRevision();
      return changed.changes > 0 ? this.itemById(id) : null;
    },

    setSuggestion(id: string, suggestion: object): NewsItemRecord | null {
      const changed = handle.db
        .update(newsItems)
        .set({ suggestion_json: encodeJson(suggestion), status: 'shortlisted' })
        .where(eq(newsItems.id, id))
        .run();
      if (changed.changes > 0) touchRevision();
      return changed.changes > 0 ? this.itemById(id) : null;
    },

    setVerification(id: string, verificationStatus: NewsVerificationRecord): NewsItemRecord | null {
      const changed = handle.db
        .update(newsItems)
        .set({
          verification_status: verificationStatus,
          verified: verificationStatus === 'confirmed',
        })
        .where(eq(newsItems.id, id))
        .run();
      if (changed.changes > 0) touchRevision();
      return changed.changes > 0 ? this.itemById(id) : null;
    },

    latestRevision(): number {
      const row = handle.db
        .select({ value: appSettings.value_json })
        .from(appSettings)
        .where(eq(appSettings.key, 'news.revision'))
        .get();
      return Number(row?.value ?? 0);
    },

    claimCollectionCycle(bucket: string): boolean {
      let claimed = false;
      handle.db.transaction(
        (tx) => {
          const row = tx
            .select({ value: appSettings.value_json })
            .from(appSettings)
            .where(eq(appSettings.key, 'news.scheduler.bucket'))
            .get();
          const previous = row ? JSON.parse(row.value) : null;
          if (previous === bucket) return;
          const now = nowMs();
          tx.insert(appSettings)
            .values({
              key: 'news.scheduler.bucket',
              value_json: encodeJson(bucket),
              value_type: 'string',
              updated_at: now,
            })
            .onConflictDoUpdate({
              target: appSettings.key,
              set: { value_json: encodeJson(bucket), value_type: 'string', updated_at: now },
            })
            .run();
          claimed = true;
        },
        { behavior: 'immediate' },
      );
      return claimed;
    },

    expireBefore(now: number): number {
      const retentionCutoff = now - 30 * 24 * 60 * 60_000;
      const changed = handle.db
        .update(newsItems)
        .set({ status: 'expired' })
        .where(
          and(
            inArray(newsItems.status, ['new', 'shortlisted']),
            or(
              lt(newsItems.expires_at, now),
              and(isNull(newsItems.expires_at), lt(newsItems.published_at, retentionCutoff)),
            ),
          ),
        )
        .run();
      if (changed.changes > 0) touchRevision();
      return changed.changes;
    },
  };
}

export type NewsStore = ReturnType<typeof createNewsStore>;
