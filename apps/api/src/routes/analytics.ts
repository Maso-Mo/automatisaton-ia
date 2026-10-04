import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PerformanceAdvisor, classifyPerformance } from '@aia/analytics';
import {
  ANALYZE_PERFORMANCE_JOB,
  COLLECT_METRICS_JOB,
  EXTRACT_CONTENT_FEATURES_JOB,
  REBUILD_PATTERNS_JOB,
} from '@aia/queue';
import { epochMsToLocalDateTime, localDateTimeToEpochMs, parseOrThrow } from '@aia/core';
import { ConflictError, NotFoundError, ValidationError } from '@aia/shared';
import type { ApiContext } from '../bootstrap';

const nullableMetric = z.number().int().nonnegative().nullable().optional();
const metricInput = z
  .object({
    publicationId: z.string().min(1),
    capturedAt: z.number().int().nonnegative().optional(),
    capturedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    source: z.enum(['manual', 'api']).default('manual'),
    collectionMethod: z.string().trim().min(1).max(100).optional(),
    provenance: z.string().trim().min(1).max(160).default('user'),
    impressions: nullableMetric,
    reach: nullableMetric,
    views: nullableMetric,
    likes: nullableMetric,
    comments: nullableMetric,
    shares: nullableMetric,
    saves: nullableMetric,
    clicks: nullableMetric,
    followsGained: nullableMetric,
    watchTimeSec: nullableMetric,
    avgViewDurationSec: nullableMetric,
    completionRateX100: nullableMetric,
    profileVisits: nullableMetric,
    followersAtPublish: nullableMetric,
    platformMetrics: z.record(z.string(), z.unknown()).optional(),
  })
  .refine(
    (value) =>
      [
        value.impressions,
        value.reach,
        value.views,
        value.likes,
        value.comments,
        value.shares,
        value.saves,
        value.clicks,
        value.watchTimeSec,
      ].some((metric) => metric !== undefined && metric !== null),
    'Au moins une métrique mesurée est requise.',
  );

const externalInput = z.object({
  projectId: z.string().min(1),
  platform: z.string().trim().min(1).max(40),
  url: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  title: z.string().trim().min(2).max(300),
  creatorName: z.string().trim().max(160).nullable().optional(),
  publishedAt: z.number().int().nonnegative().nullable().optional(),
  views: nullableMetric,
  likes: nullableMetric,
  comments: nullableMetric,
  shares: nullableMetric,
  followers: nullableMetric,
  durationMs: nullableMetric,
  topic: z.string().trim().max(160).nullable().optional(),
  extractedFeatures: z.record(z.string(), z.unknown()).optional(),
  provenance: z.string().trim().min(2).max(160).default('user_url'),
  confidenceX100: z.number().int().min(0).max(100).default(50),
});

function publicationOrThrow(context: ApiContext, id: string) {
  const publication = context.publishing.getPublication(id);
  if (!publication) {
    throw new NotFoundError('Publication introuvable.', { code: 'PUBLICATION_NOT_FOUND' });
  }
  return publication;
}

function dateOf(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function manualSnapshot(context: ApiContext, input: z.infer<typeof metricInput>) {
  const publication = publicationOrThrow(context, input.publicationId);
  const capturedAt = input.capturedAt ?? context.clock.nowMs();
  return context.metrics.upsert({
    publicationId: publication.id,
    projectId: publication.projectId,
    platform: publication.platform,
    capturedAt,
    capturedDate: input.capturedDate ?? dateOf(capturedAt),
    source: input.source,
    collectionMethod:
      input.collectionMethod ?? (input.source === 'manual' ? 'manual_entry' : 'platform_export'),
    provenance: input.provenance,
    metrics: {
      impressions: input.impressions,
      reach: input.reach,
      views: input.views,
      likes: input.likes,
      comments: input.comments,
      shares: input.shares,
      saves: input.saves,
      clicks: input.clicks,
      followsGained: input.followsGained,
      watchTimeSec: input.watchTimeSec,
      avgViewDurationSec: input.avgViewDurationSec,
      completionRateX100: input.completionRateX100,
      profileVisits: input.profileVisits,
      followersAtPublish: input.followersAtPublish,
    },
    platformMetrics: input.platformMetrics,
  });
}

export function registerAnalyticsRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/analytics', async (request) => {
    const { projectId, since = '1970-01-01' } = request.query as {
      projectId?: string;
      since?: string;
    };
    if (!projectId)
      throw new ValidationError('projectId est requis.', { code: 'PROJECT_REQUIRED' });
    const rows = context.metrics.listByProject(projectId, since);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows)
      if (!latest.has(row.publication_id)) latest.set(row.publication_id, row);
    const contents = [...latest.values()].map((row) => {
      const comparable = [...latest.values()].filter(
        (candidate) =>
          candidate.platform === row.platform && candidate.publication_id !== row.publication_id,
      );
      return {
        ...row,
        ...classifyPerformance(row.relative_performance_x100, comparable.length),
      };
    });
    const ordered = [...contents].sort(
      (left, right) =>
        (right.relative_performance_x100 ?? -1) - (left.relative_performance_x100 ?? -1),
    );
    return {
      snapshots: rows,
      contents: ordered,
      top: ordered.slice(0, 5),
      weak: ordered.filter((item) => item.classification === 'UNDERPERFORMING').slice(-5),
      byPlatform: Object.values(
        ordered.reduce<Record<string, { platform: string; publications: number; views: number }>>(
          (summary, item) => {
            const current = summary[item.platform] ?? {
              platform: item.platform,
              publications: 0,
              views: 0,
            };
            current.publications += 1;
            current.views += item.views ?? 0;
            summary[item.platform] = current;
            return summary;
          },
          {},
        ),
      ),
    };
  });

  app.post('/analytics/metrics', async (request, reply) => {
    const body = parseOrThrow(metricInput, request.body, 'METRIC_SNAPSHOT_INVALID');
    const snapshot = manualSnapshot(context, body);
    reply.status(201);
    return { snapshot };
  });

  app.post('/analytics/metrics/import', async (request, reply) => {
    const body = parseOrThrow(
      z.object({ rows: z.array(metricInput).min(1).max(500) }),
      request.body,
      'METRIC_IMPORT_INVALID',
    );
    const snapshots = body.rows.map((row) => manualSnapshot(context, row));
    reply.status(201);
    return { snapshots, imported: snapshots.length };
  });

  app.post('/analytics/collect', async (request, reply) => {
    const body = parseOrThrow(
      z.object({ projectId: z.string().min(1), publicationId: z.string().min(1).optional() }),
      request.body,
      'METRIC_COLLECTION_INVALID',
    );
    const jobId = await context.editorial.queue.enqueue(COLLECT_METRICS_JOB, body, {
      projectId: body.projectId,
    });
    reply.status(202);
    return { jobId };
  });

  app.post('/analytics/analyze', async (request, reply) => {
    const body = parseOrThrow(
      z.object({ projectId: z.string().min(1), publicationId: z.string().min(1).optional() }),
      request.body,
      'PERFORMANCE_ANALYSIS_INVALID',
    );
    const analyzeJobId = await context.editorial.queue.enqueue(ANALYZE_PERFORMANCE_JOB, body, {
      projectId: body.projectId,
    });
    let featureJobId: string | null = null;
    if (body.publicationId) {
      featureJobId = await context.editorial.queue.enqueue(
        EXTRACT_CONTENT_FEATURES_JOB,
        { projectId: body.projectId, publicationId: body.publicationId },
        { projectId: body.projectId, parentJobId: analyzeJobId },
      );
    }
    reply.status(202);
    return { analyzeJobId, featureJobId };
  });

  app.post('/analytics/patterns/rebuild', async (request, reply) => {
    const body = parseOrThrow(
      z.object({ projectId: z.string().min(1) }),
      request.body,
      'PATTERN_REBUILD_INVALID',
    );
    const jobId = await context.editorial.queue.enqueue(REBUILD_PATTERNS_JOB, body, {
      projectId: body.projectId,
    });
    reply.status(202);
    return { jobId };
  });

  app.get('/analytics/patterns', async (request) => {
    const { projectId } = request.query as { projectId?: string };
    if (!projectId)
      throw new ValidationError('projectId est requis.', { code: 'PROJECT_REQUIRED' });
    return {
      patterns: context.patterns.listByProject(projectId),
      learnings: context.learnings.listActive(projectId),
    };
  });

  app.post('/analytics/patterns/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    const pattern = context.patterns.reject(id);
    if (!pattern) throw new NotFoundError('Pattern introuvable.', { code: 'PATTERN_NOT_FOUND' });
    return { pattern };
  });

  app.get('/analytics/advice', async (request) => {
    const query = request.query as {
      projectId?: string;
      platform?: string;
      niche?: string;
      contentType?: string;
    };
    if (!query.projectId || !query.platform) {
      throw new ValidationError('projectId et platform sont requis.', {
        code: 'ADVICE_CONTEXT_REQUIRED',
      });
    }
    const patterns = context.patterns.listByProject(query.projectId).map((pattern) => ({
      id: pattern.id,
      platform: pattern.platform,
      niche: pattern.niche,
      contentType: pattern.content_type,
      feature: pattern.value,
      dimension: pattern.dimension,
      observedEffectPercent: pattern.delta_percent,
      confidenceX100: pattern.confidence_x100,
      sampleSize: pattern.sample_size,
      status: pattern.status as 'EXPERIMENTAL' | 'LIKELY' | 'SUPPORTED' | 'REJECTED',
    }));
    const recommendations = new PerformanceAdvisor().advise({
      platform: query.platform,
      niche: query.niche,
      contentType: query.contentType,
      patterns,
    });
    return { recommendations };
  });

  app.get('/analytics/external', async (request) => {
    const { projectId } = request.query as { projectId?: string };
    if (!projectId)
      throw new ValidationError('projectId est requis.', { code: 'PROJECT_REQUIRED' });
    return { examples: context.externalContent.list(projectId) };
  });

  app.post('/analytics/external', async (request, reply) => {
    const body = parseOrThrow(externalInput, request.body, 'EXTERNAL_EXAMPLE_INVALID');
    const example = context.externalContent.upsert(body);
    const jobId = await context.editorial.queue.enqueue(
      EXTRACT_CONTENT_FEATURES_JOB,
      { projectId: body.projectId, externalExampleId: example.id },
      { projectId: body.projectId },
    );
    reply.status(201);
    return { example, jobId };
  });

  app.patch('/analytics/external/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(
      z.object({ projectId: z.string().min(1), included: z.boolean() }),
      request.body,
      'EXTERNAL_EXAMPLE_UPDATE_INVALID',
    );
    const existing = context.externalContent.list(body.projectId).find((item) => item.id === id);
    if (!existing)
      throw new NotFoundError('Exemple externe introuvable.', {
        code: 'EXTERNAL_EXAMPLE_NOT_FOUND',
      });
    return { example: context.externalContent.setIncluded(id, body.included) };
  });

  app.post('/analytics/calendar-proposal', async (request, reply) => {
    const body = parseOrThrow(
      z.object({
        calendarSlotId: z.string().min(1),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        localTime: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1),
        patternId: z.string().min(1),
      }),
      request.body,
      'ANALYTICS_CALENDAR_PROPOSAL_INVALID',
    );
    const slot = context.scheduling.getSlot(body.calendarSlotId);
    if (!slot) throw new NotFoundError('Créneau introuvable.', { code: 'CALENDAR_SLOT_NOT_FOUND' });
    const proposed = localDateTimeToEpochMs({
      localDate: body.localDate,
      localTime: body.localTime,
      timeZone: body.timezone,
    });
    if (proposed <= context.clock.nowMs())
      throw new ValidationError('La date proposée doit être future.', {
        code: 'CALENDAR_DATE_IN_PAST',
      });
    const current = epochMsToLocalDateTime(slot.scheduledFor, slot.timezone);
    const pattern = context.patterns
      .listByProject(slot.projectId)
      .find((item) => item.id === body.patternId);
    if (!pattern)
      throw new ConflictError('Le pattern doit appartenir au projet du créneau.', {
        code: 'PATTERN_PROJECT_MISMATCH',
      });
    const proposal = context.scheduling.createProposal({
      calendarSlotId: slot.id,
      proposedScheduledFor: proposed,
      proposedTimezone: body.timezone,
      reason: `Association observée ${pattern.dimension}=${pattern.value} (${pattern.confidence_x100}% de confiance). Créneau actuel ${current.localDate} ${current.localTime}. Validation humaine requise.`,
    });
    reply.status(201);
    return { proposal };
  });
}
