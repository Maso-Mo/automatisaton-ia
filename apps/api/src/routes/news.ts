import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  canProposeAutomaticMove,
  epochMsToLocalDateTime,
  localDateTimeToEpochMs,
  parseOrThrow,
  type CalendarRigidity,
} from '@aia/core';
import { createEditorialSuggestion, type NewsScore, type NormalizedNewsItem } from '@aia/news';
import { COLLECT_NEWS_JOB } from '@aia/queue';
import { ConflictError, NotFoundError, ValidationError } from '@aia/shared';
import type { ApiContext } from '../bootstrap';

const sourceInput = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(2).max(120),
  type: z.enum(['rss', 'atom', 'web']),
  url: z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  categories: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  keywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  excludeKeywords: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  trustLevel: z.number().int().min(1).max(5).default(3),
  refreshHours: z.number().int().min(2).max(168).default(12),
  language: z.string().trim().min(2).max(12).nullable().optional(),
});

const sourcePatch = sourceInput
  .omit({ projectId: true, type: true })
  .partial()
  .extend({ enabled: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'Aucune modification demandée.');

function itemOrThrow(context: ApiContext, id: string) {
  const item = context.news.itemById(id);
  if (!item) throw new NotFoundError('Actualité introuvable.', { code: 'NEWS_ITEM_NOT_FOUND' });
  return item;
}

function suggestionFor(context: ApiContext, id: string) {
  const item = itemOrThrow(context, id);
  const source = context.news.sourceById(item.sourceId);
  const normalized: NormalizedNewsItem = {
    sourceId: item.sourceId,
    externalId: item.externalId,
    url: item.url,
    canonicalUrl: item.canonicalUrl ?? item.url,
    title: item.title,
    summary: item.summary,
    publishedAt: item.publishedAt,
    author: item.author,
    categories: item.categories,
    language: item.language,
    contentHash: item.contentHash,
  };
  const score: NewsScore = {
    relevance: item.relevanceScore ?? 0,
    freshness: item.freshnessScore ?? 0,
    trust: item.trustScore ?? (source?.authority ?? 0) * 20,
    projectMatch: item.projectMatchScore ?? 0,
    audienceMatch: item.audienceMatchScore ?? 0,
    final: item.finalScore ?? 0,
    urgency: item.urgency,
    explanation: item.scoreExplanation,
  };
  return createEditorialSuggestion({ item: normalized, score, projectId: item.projectId });
}

export function registerNewsRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/news/sources', async (request) => {
    const query = request.query as { projectId?: string };
    return { sources: context.news.listSources(query.projectId) };
  });

  app.post('/news/sources', async (request, reply) => {
    const body = parseOrThrow(sourceInput, request.body, 'NEWS_SOURCE_INVALID');
    const project = context.memory.store.projects.byId(body.projectId);
    if (!project || project.archivedAt !== null) {
      throw new NotFoundError('Projet actif introuvable.', { code: 'PROJECT_NOT_FOUND' });
    }
    const source = context.news.createSource({
      projectId: body.projectId,
      name: body.name,
      kind: body.type,
      url: body.url,
      categories: body.categories,
      keywords: body.keywords,
      excludeKeywords: body.excludeKeywords,
      authority: body.trustLevel,
      refreshHours: body.refreshHours,
      language: body.language,
    });
    reply.status(201);
    return { source };
  });

  app.patch('/news/sources/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(sourcePatch, request.body, 'NEWS_SOURCE_UPDATE_INVALID');
    const source = context.news.updateSource(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.url !== undefined ? { url: body.url } : {}),
      ...(body.categories !== undefined ? { categories: body.categories } : {}),
      ...(body.keywords !== undefined ? { keywords: body.keywords } : {}),
      ...(body.excludeKeywords !== undefined ? { excludeKeywords: body.excludeKeywords } : {}),
      ...(body.language !== undefined ? { language: body.language } : {}),
      ...(body.trustLevel !== undefined ? { authority: body.trustLevel } : {}),
      ...(body.refreshHours !== undefined ? { refreshHours: body.refreshHours } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    });
    if (!source) throw new NotFoundError('Source introuvable.', { code: 'NEWS_SOURCE_NOT_FOUND' });
    return { source };
  });

  app.post('/news/sources/:id/collect', async (request, reply) => {
    const { id } = request.params as { id: string };
    const source = context.news.sourceById(id);
    if (!source) throw new NotFoundError('Source introuvable.', { code: 'NEWS_SOURCE_NOT_FOUND' });
    if (!source.enabled) {
      throw new ConflictError('Cette source est désactivée.', { code: 'NEWS_SOURCE_DISABLED' });
    }
    const jobId = await context.editorial.queue.enqueue(
      COLLECT_NEWS_JOB,
      { sourceId: id },
      { projectId: source.projectId },
    );
    reply.status(202);
    return { jobId };
  });

  app.get('/news', async (request) => {
    const query = request.query as {
      projectId?: string;
      status?: 'new' | 'shortlisted' | 'used' | 'dismissed' | 'expired';
      urgency?: 'BREAKING' | 'HIGH' | 'NORMAL' | 'EVERGREEN';
      minScore?: string;
      limit?: string;
    };
    return {
      items: context.news.listItems({
        projectId: query.projectId,
        status: query.status,
        urgency: query.urgency,
        minScore: query.minScore === undefined ? undefined : Number(query.minScore),
        limit: query.limit === undefined ? 50 : Math.min(Number(query.limit) || 50, 100),
      }),
    };
  });

  app.get('/news/summary', async () => {
    const since = context.clock.nowMs() - 24 * 60 * 60_000;
    const relevant = context.news.listItems({ since, minScore: 60, limit: 5 });
    return { count: relevant.length, items: relevant };
  });

  app.get('/news/:id', async (request) => {
    const { id } = request.params as { id: string };
    const item = itemOrThrow(context, id);
    return { item, source: context.news.sourceById(item.sourceId) };
  });

  app.post('/news/:id/dismiss', async (request) => {
    const { id } = request.params as { id: string };
    itemOrThrow(context, id);
    const body = parseOrThrow(
      z.object({ reason: z.string().trim().min(3).max(500).default('Ignorée par l’utilisateur.') }),
      request.body ?? {},
      'NEWS_DISMISS_INVALID',
    );
    return { item: context.news.setItemStatus(id, 'dismissed', body.reason) };
  });

  app.post('/news/:id/verification', async (request) => {
    const { id } = request.params as { id: string };
    itemOrThrow(context, id);
    const body = parseOrThrow(
      z.object({ status: z.enum(['needs_review', 'confirmed', 'disputed']) }),
      request.body,
      'NEWS_VERIFICATION_INVALID',
    );
    return { item: context.news.setVerification(id, body.status) };
  });

  app.post('/news/:id/suggestion', async (request, reply) => {
    const { id } = request.params as { id: string };
    const suggestion = suggestionFor(context, id);
    const item = context.news.setSuggestion(id, suggestion);
    reply.status(201);
    return { suggestion, item };
  });

  app.post('/news/:id/calendar-proposal', async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = itemOrThrow(context, id);
    const body = parseOrThrow(
      z.object({
        calendarSlotId: z.string().min(1),
        localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        localTime: z.string().regex(/^\d{2}:\d{2}$/),
        timezone: z.string().min(1),
      }),
      request.body,
      'NEWS_CALENDAR_PROPOSAL_INVALID',
    );
    const slot = context.scheduling.getSlot(body.calendarSlotId);
    if (!slot || slot.projectId !== item.projectId) {
      throw new ConflictError('Le créneau doit appartenir au projet associé à la news.', {
        code: 'NEWS_CALENDAR_PROJECT_MISMATCH',
      });
    }
    if (!canProposeAutomaticMove(slot.rigidity as CalendarRigidity)) {
      throw new ConflictError('Un créneau LOCKED ne peut pas être proposé au déplacement.', {
        code: 'CALENDAR_LOCKED_PROPOSAL_REFUSED',
      });
    }
    const proposed = localDateTimeToEpochMs({
      localDate: body.localDate,
      localTime: body.localTime,
      timeZone: body.timezone,
    });
    if (proposed <= context.clock.nowMs()) {
      throw new ValidationError('Le déplacement proposé doit être dans le futur.', {
        code: 'NEWS_CALENDAR_DATE_IN_PAST',
      });
    }
    const current = epochMsToLocalDateTime(slot.scheduledFor, slot.timezone);
    const proposal = context.scheduling.createProposal({
      calendarSlotId: slot.id,
      proposedScheduledFor: proposed,
      proposedTimezone: body.timezone,
      reason: `Actualité ${item.urgency} « ${item.title} » : déplacer le créneau du ${current.localDate} ${current.localTime}. News ${item.id}.`,
    });
    if (!item.suggestion) context.news.setSuggestion(id, suggestionFor(context, id));
    reply.status(201);
    return { proposal, item: context.news.itemById(id) };
  });

  app.get('/events/news', async (request, reply) => {
    const query = request.query as { intervalMs?: string };
    const intervalMs = Math.min(Math.max(Number(query.intervalMs ?? 1_000) || 1_000, 500), 10_000);
    let revision = context.news.latestRevision();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();
    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    send('snapshot', { revision });
    const interval = setInterval(() => {
      const latest = context.news.latestRevision();
      if (latest > revision) {
        revision = latest;
        send('news_changed', { revision });
      }
    }, intervalMs);
    request.raw.on('close', () => clearInterval(interval));
  });
}
