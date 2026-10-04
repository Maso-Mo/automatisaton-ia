import type {
  createContentFeatureStore,
  createExternalContentStore,
  createLearningsStore,
  createMetricsStore,
  createPerformancePatternStore,
  ExternalContentExampleRow,
  MetricSnapshotMetrics,
  MetricSnapshotRow,
  PublicationRecord,
} from '@aia/database';
import {
  deriveMetrics,
  extractContentFeatures,
  ViralPatternEngine,
  type ContentFeatures,
  type PerformanceObservation,
} from '@aia/analytics';
import {
  analyzePerformanceSpec,
  collectMetricsSpec,
  extractContentFeaturesSpec,
  rebuildPatternsSpec,
  type AnalyzePerformanceInput,
  type CollectMetricsInput,
  type ExtractContentFeaturesInput,
  type JobDefinition,
  type RebuildPatternsInput,
} from '@aia/queue';
import { NotFoundError, parseJsonUnknown, type Clock } from '@aia/shared';
import type { PlatformConnector } from '@aia/publishing';

type MetricsStore = ReturnType<typeof createMetricsStore>;
type FeatureStore = ReturnType<typeof createContentFeatureStore>;
type ExternalStore = ReturnType<typeof createExternalContentStore>;
type PatternStore = ReturnType<typeof createPerformancePatternStore>;
type LearningStore = ReturnType<typeof createLearningsStore>;

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function metricPayload(row: Record<string, unknown>): MetricSnapshotMetrics {
  return {
    impressions: optionalNumber(row.impressions),
    reach: optionalNumber(row.reach),
    views: optionalNumber(row.views),
    likes: optionalNumber(row.likes),
    comments: optionalNumber(row.comments),
    shares: optionalNumber(row.shares),
    saves: optionalNumber(row.saves),
    clicks: optionalNumber(row.clicks),
    followsGained: optionalNumber(row.followsGained),
    watchTimeSec: optionalNumber(row.watchTime ?? row.watchTimeSec),
    avgViewDurationSec: optionalNumber(row.averageWatchTime ?? row.avgViewDurationSec),
    completionRateX100: optionalNumber(row.completionRateX100),
    profileVisits: optionalNumber(row.profileVisits),
    followersAtPublish: optionalNumber(row.followers ?? row.followersAtPublish),
  };
}

function localDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function createCollectMetricsHandler(deps: {
  metrics: MetricsStore;
  publications: { listByProject(projectId: string): PublicationRecord[] };
  connector(publication: PublicationRecord): PlatformConnector | null;
  clock: Clock;
}): JobDefinition<
  CollectMetricsInput,
  { publications: number; snapshots: number; skipped: number }
> {
  return {
    ...collectMetricsSpec,
    handler: async (input, ctx) => {
      const publications = deps.publications
        .listByProject(input.projectId)
        .filter((item) => !input.publicationId || item.id === input.publicationId);
      let snapshots = 0;
      let skipped = 0;
      for (const publication of publications) {
        if (!publication.remoteId || !publication.publishedAt) {
          skipped += 1;
          continue;
        }
        const connector = deps.connector(publication);
        if (!connector?.capabilities().analytics) {
          skipped += 1;
          continue;
        }
        const previous = deps.metrics.listByPublication(publication.id);
        const since = new Date(previous.at(0)?.captured_at ?? publication.publishedAt);
        const rows = await connector.fetchMetrics(publication.remoteId, since);
        for (const row of rows) {
          const capturedAt = optionalNumber(row.capturedAt) ?? deps.clock.nowMs();
          deps.metrics.upsert({
            publicationId: publication.id,
            projectId: publication.projectId,
            platform: publication.platform,
            capturedAt,
            capturedDate:
              typeof row.capturedDate === 'string' ? row.capturedDate : localDate(capturedAt),
            source: 'api',
            collectionMethod: 'PlatformConnector.fetchMetrics',
            provenance: publication.platform,
            metrics: metricPayload(row),
            platformMetrics: row.platformMetrics,
            raw: row,
          });
          snapshots += 1;
        }
      }
      await ctx.emitEvent({
        step: 'done',
        progress: 100,
        message: `${snapshots} snapshot(s), ${skipped} publication(s) sans analytics API.`,
      });
      return { publications: publications.length, snapshots, skipped };
    },
  };
}

function normalizedValue(row: MetricSnapshotRow): number | null {
  if (row.followers_at_publish && row.followers_at_publish > 0) {
    const numerator = row.views ?? row.impressions ?? row.reach;
    return numerator === null ? null : numerator / row.followers_at_publish;
  }
  const denominator = row.impressions ?? row.reach ?? row.views;
  if (!denominator || denominator <= 0) return row.views;
  const values = [row.likes, row.comments, row.shares, row.saves];
  if (values.every((value) => value === null)) return row.views;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0) / denominator;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function createAnalyzePerformanceHandler(deps: {
  metrics: MetricsStore;
  publications: { getPublication(id: string): PublicationRecord | null };
}): JobDefinition<AnalyzePerformanceInput, { analyzed: number }> {
  return {
    ...analyzePerformanceSpec,
    handler: async (input, ctx) => {
      const all = deps.metrics.latestByProject(input.projectId);
      const latest = new Map<string, MetricSnapshotRow>();
      for (const row of all)
        if (!latest.has(row.publication_id)) latest.set(row.publication_id, row);
      const comparable = [...latest.values()];
      let analyzed = 0;
      for (const row of all) {
        if (input.publicationId && row.publication_id !== input.publicationId) continue;
        const publication = deps.publications.getPublication(row.publication_id);
        if (!publication?.publishedAt) continue;
        const baseline = comparable
          .filter(
            (candidate) =>
              candidate.platform === row.platform &&
              candidate.publication_id !== row.publication_id,
          )
          .map(normalizedValue)
          .filter((value): value is number => value !== null);
        const history = all.filter(
          (candidate) =>
            candidate.publication_id === row.publication_id &&
            candidate.captured_at < row.captured_at,
        );
        const derived = deriveMetrics({
          metrics: {
            impressions: row.impressions,
            reach: row.reach,
            views: row.views,
            likes: row.likes,
            comments: row.comments,
            shares: row.shares,
            saves: row.saves,
            clicks: row.clicks,
            followersAtPublish: row.followers_at_publish,
          },
          publishedAt: publication.publishedAt,
          capturedAt: row.captured_at,
          previous: history[0]
            ? { views: history[0].views, capturedAt: history[0].captured_at }
            : null,
          baselineValues: baseline,
          baselineMedian: median(baseline),
        });
        deps.metrics.upsert({
          publicationId: row.publication_id,
          projectId: row.project_id,
          platform: row.platform,
          capturedAt: row.captured_at,
          capturedDate: row.captured_date,
          source: row.source as 'api' | 'manual' | 'estimated',
          collectionMethod: row.collection_method,
          provenance: row.provenance,
          metrics: derived,
        });
        analyzed += 1;
      }
      await ctx.emitEvent({
        step: 'done',
        progress: 100,
        message: `${analyzed} snapshot(s) analysé(s).`,
      });
      return { analyzed };
    },
  };
}

export interface FeatureSource {
  publication(id: string): {
    projectId: string;
    publicationId: string;
    contentVersionId: string;
    platform: string;
    niche: string | null;
    contentType: string;
    title: string | null;
    hook: string | null;
    body: string;
    durationMs?: number | null;
    fps?: number | null;
    width?: number | null;
    height?: number | null;
    subtitleGenerated?: boolean | null;
    transcriptSegments?: Array<{ startMs: number; endMs: number; text: string }>;
    sceneChangesMs?: number[];
    experimentKey?: string | null;
    experimentVariant?: string | null;
  } | null;
}

export function createExtractContentFeaturesHandler(deps: {
  features: FeatureStore;
  external: ExternalStore;
  source: FeatureSource;
  clock: Clock;
}): JobDefinition<ExtractContentFeaturesInput, { featureSetId: string; extractionMs: number }> {
  return {
    ...extractContentFeaturesSpec,
    handler: async (input, ctx) => {
      const startedAt = deps.clock.nowMs();
      if (input.publicationId) {
        const source = deps.source.publication(input.publicationId);
        if (!source)
          throw new NotFoundError('Publication introuvable.', { code: 'PUBLICATION_NOT_FOUND' });
        const extracted = extractContentFeatures(source);
        const extractionMs = Math.max(0, deps.clock.nowMs() - startedAt);
        const row = deps.features.upsert({
          ...source,
          features: extracted,
          provenance: 'own_content',
          extractionMs,
        });
        await ctx.emitEvent({
          step: 'done',
          progress: 100,
          message: 'Caractéristiques locales extraites.',
        });
        return { featureSetId: row.id, extractionMs };
      }
      const external = deps.external
        .list(input.projectId)
        .find((item) => item.id === input.externalExampleId);
      if (!external)
        throw new NotFoundError('Exemple externe introuvable.', {
          code: 'EXTERNAL_EXAMPLE_NOT_FOUND',
        });
      const baseFeatures = extractContentFeatures({
        title: external.title,
        body: external.title,
        durationMs: external.duration_ms,
      });
      const extracted = external.extracted_features_json
        ? parseFeatures(external.extracted_features_json, baseFeatures)
        : baseFeatures;
      const extractionMs = Math.max(0, deps.clock.nowMs() - startedAt);
      const row = deps.features.upsert({
        projectId: external.project_id,
        externalExampleId: external.id,
        platform: external.platform,
        contentType: external.duration_ms ? 'short_video' : 'post',
        niche: external.topic,
        features: extracted,
        provenance: external.provenance,
        confidenceX100: external.confidence_x100,
        extractionMs,
        included: external.included,
      });
      await ctx.emitEvent({
        step: 'done',
        progress: 100,
        message: 'Exemple externe abstrait, sans copie du contenu.',
      });
      return { featureSetId: row.id, extractionMs };
    },
  };
}

function parseFeatures(raw: string, defaults: ContentFeatures): ContentFeatures {
  const parsed = parseJsonUnknown(raw);
  if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) {
    throw new Error('Caractéristiques externes invalides.');
  }
  return { ...defaults, ...(parsed.value as Partial<ContentFeatures>) };
}

function externalScore(example: ExternalContentExampleRow): number | null {
  if (example.followers && example.followers > 0 && example.views !== null)
    return example.views / example.followers;
  return example.views;
}

export function createRebuildPatternsHandler(deps: {
  metrics: MetricsStore;
  features: FeatureStore;
  external: ExternalStore;
  patterns: PatternStore;
  learnings: LearningStore;
  clock: Clock;
}): JobDefinition<RebuildPatternsInput, { patterns: number; rebuildMs: number }> {
  return {
    ...rebuildPatternsSpec,
    handler: async (input, ctx) => {
      const startedAt = deps.clock.nowMs();
      const snapshots = deps.metrics.latestByProject(input.projectId);
      const latest = new Map<string, MetricSnapshotRow>();
      for (const row of snapshots)
        if (!latest.has(row.publication_id)) latest.set(row.publication_id, row);
      const externals = deps.external.list(input.projectId);
      const externalById = new Map(externals.map((item) => [item.id, item]));
      const rows = deps.features.list(input.projectId).filter((item) => item.included);
      const raw = rows.flatMap((row) => {
        const features = deps.features.featuresOf(row) as ContentFeatures | null;
        if (!features) return [];
        const own = row.publication_id ? latest.get(row.publication_id) : undefined;
        const external = row.external_example_id
          ? externalById.get(row.external_example_id)
          : undefined;
        const score = own?.relative_performance_x100 ?? (external ? externalScore(external) : null);
        if (score === null || score === undefined) return [];
        return [{ row, features, own, external, score }];
      });
      const observations: PerformanceObservation[] = raw.map((item) => {
        const peers = raw
          .filter(
            (candidate) =>
              candidate.row.platform === item.row.platform &&
              Boolean(candidate.external) === Boolean(item.external),
          )
          .map((candidate) => candidate.score);
        const baseline = median(peers) ?? 1;
        const relative = item.own
          ? item.score
          : Math.round((item.score / Math.max(baseline, 0.0001)) * 100);
        return {
          id: item.row.id,
          projectId: item.row.project_id,
          platform: item.row.platform,
          niche: item.row.niche,
          contentType: item.row.content_type,
          origin: item.own ? 'personal' : 'external',
          features: item.features,
          relativePerformanceX100: relative,
          qualityX100: item.row.confidence_x100,
          observedAt: item.own?.captured_at ?? item.external?.collected_at ?? item.row.updated_at,
        };
      });
      const detected = new ViralPatternEngine().analyze(observations);
      for (const item of detected) {
        const periodEnd = item.lastObservedAt;
        const pattern = deps.patterns.upsert({
          projectId: input.projectId,
          platform: item.platform,
          niche: item.niche,
          contentType: item.contentType,
          dimension: item.dimension,
          value: item.feature,
          metric: 'engagement_rate',
          sampleSize: item.sampleSize,
          avgValueX100: 100 + item.observedEffectPercent,
          deltaPercent: item.observedEffectPercent,
          observedEffect: `${item.observedEffectPercent >= 0 ? '+' : ''}${item.observedEffectPercent}% de performance relative`,
          positiveSampleSize: item.positiveSampleSize,
          baselineSampleSize: item.baselineSampleSize,
          confidenceX100: item.confidenceX100,
          evidence: { featureSetIds: item.evidenceIds, personalEvidence: item.personalEvidence },
          status: item.status,
          firstObservedAt: item.firstObservedAt,
          lastObservedAt: item.lastObservedAt,
          periodStart: item.firstObservedAt,
          periodEnd,
        });
        if (item.status === 'LIKELY' || item.status === 'SUPPORTED') {
          const statement = `${item.dimension} « ${item.feature} » est associé à ${item.observedEffectPercent >= 0 ? '+' : ''}${item.observedEffectPercent}% de performance relative.`;
          if (
            !deps.learnings
              .listActive(input.projectId)
              .some((learning) => learning.statement === statement)
          ) {
            deps.learnings.insert({
              projectId: input.projectId,
              scope: item.dimension === 'hook_type' ? 'hook' : 'format',
              platform: item.platform,
              niche: item.niche,
              contentType: item.contentType,
              statement,
              sampleSize: item.sampleSize,
              confidence: item.status === 'SUPPORTED' ? 'forte' : 'moyenne',
              confidenceX100: item.confidenceX100,
              evidence: { patternId: pattern.id, featureSetIds: item.evidenceIds },
            });
          }
        }
      }
      const rebuildMs = Math.max(0, deps.clock.nowMs() - startedAt);
      await ctx.emitEvent({
        step: 'done',
        progress: 100,
        durationMs: rebuildMs,
        message: `${detected.length} pattern(s) reconstruits en ${rebuildMs} ms.`,
      });
      return { patterns: detected.length, rebuildMs };
    },
  };
}
