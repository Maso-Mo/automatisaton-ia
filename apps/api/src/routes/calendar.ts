import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CALENDAR_CONFLICT_WINDOW_MS,
  CALENDAR_RIGIDITIES,
  addLocalDays,
  cadenceWarning,
  calendarRange,
  canProposeAutomaticMove,
  detectCalendarConflicts,
  epochMsToLocalDateTime,
  isValidTimeZone,
  localDateTimeToEpochMs,
  parseOrThrow,
  type CalendarRigidity,
} from '@aia/core';
import { getSetting, resolveTimeZone, setSetting, type CalendarSlotRecord } from '@aia/database';
import { PUBLISH_CONTENT_JOB } from '@aia/queue';
import { ConflictError, NotFoundError, ValidationError, type PlatformId } from '@aia/shared';
import { publicationIdempotencyKey } from '@aia/publishing';
import type { ApiContext } from '../bootstrap';

const cadenceSchema = z.record(z.string(), z.number().int().min(1).max(20));
const rigiditySchema = z.enum(CALENDAR_RIGIDITIES);
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const localTimeSchema = z.string().regex(/^\d{2}:\d{2}$/);

const createSlotSchema = z.object({
  contentVersionId: z.string().min(1),
  platformAccountId: z.string().min(1),
  localDate: localDateSchema,
  localTime: localTimeSchema,
  timezone: z.string().min(1),
  rigidity: rigiditySchema,
});

const updateSlotSchema = z
  .object({
    localDate: localDateSchema.optional(),
    localTime: localTimeSchema.optional(),
    timezone: z.string().min(1).optional(),
    rigidity: rigiditySchema.optional(),
  })
  .refine(
    (value) =>
      value.rigidity !== undefined ||
      value.localDate !== undefined ||
      value.localTime !== undefined ||
      value.timezone !== undefined,
    'Aucune modification demandée.',
  );

const proposalSchema = z
  .object({
    localDate: localDateSchema.optional(),
    localTime: localTimeSchema.optional(),
    timezone: z.string().min(1).optional(),
    rigidity: rigiditySchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (value) =>
      value.localDate !== undefined ||
      value.localTime !== undefined ||
      value.timezone !== undefined ||
      value.rigidity !== undefined,
    'La proposition ne contient aucun changement.',
  );

const DEFAULT_CADENCE: Record<string, number> = {
  linkedin: 1,
  tiktok: 1,
  youtube: 1,
  reddit: 1,
};

function cadenceSettings(context: ApiContext): Record<string, number> {
  return (
    getSetting(context.handle, 'calendar.cadence_per_day', cadenceSchema)?.value ?? {
      ...DEFAULT_CADENCE,
    }
  );
}

function slotView(context: ApiContext, slot: CalendarSlotRecord) {
  const item = context.editorial.ports.store.getContentItem(slot.contentItemId);
  const version = context.editorial.ports.store.getVersion(slot.contentVersionId);
  const project = context.memory.store.projects.byId(slot.projectId);
  const account = context.publishing.getAccount(slot.platformAccountId);
  const publication = slot.publicationId
    ? context.publishing.getPublication(slot.publicationId)
    : null;
  return {
    ...slot,
    local: epochMsToLocalDateTime(slot.scheduledFor, slot.timezone),
    content: {
      id: item?.id ?? slot.contentItemId,
      title:
        item?.title ?? version?.title ?? version?.hook ?? version?.body.slice(0, 80) ?? 'Contenu',
      body: version?.body ?? '',
      state: item?.state ?? 'unknown',
    },
    project: { id: slot.projectId, name: project?.name ?? 'Projet' },
    account: { id: slot.platformAccountId, label: account?.accountLabel ?? 'Compte' },
    publication: publication
      ? {
          id: publication.id,
          status: publication.status,
          remoteUrl: publication.remoteUrl,
          decisionNote: publication.decisionNote,
        }
      : null,
  };
}

function slotOrThrow(context: ApiContext, id: string): CalendarSlotRecord {
  const found = context.scheduling.getSlot(id);
  if (!found) {
    throw new NotFoundError('Créneau calendrier introuvable.', { code: 'CALENDAR_SLOT_NOT_FOUND' });
  }
  return found;
}

function localDayRange(epochMs: number, timeZone: string): { from: number; to: number } {
  const localDate = epochMsToLocalDateTime(epochMs, timeZone).localDate;
  return {
    from: localDateTimeToEpochMs({ localDate, localTime: '00:00', timeZone }),
    to: localDateTimeToEpochMs({
      localDate: addLocalDays(localDate, 1),
      localTime: '00:00',
      timeZone,
    }),
  };
}

function warningsFor(context: ApiContext, candidate: CalendarSlotRecord) {
  const conflicts = detectCalendarConflicts(
    {
      platformAccountId: candidate.platformAccountId,
      scheduledFor: candidate.scheduledFor,
    },
    context.scheduling.listAllActive(),
    candidate.id,
  );
  const range = localDayRange(candidate.scheduledFor, candidate.timezone);
  const count = context.scheduling.countByPlatformDay(candidate.platform, range.from, range.to);
  const recommended = cadenceSettings(context)[candidate.platform] ?? 1;
  const cadence = cadenceWarning({
    platform: candidate.platform,
    countForLocalDay: count,
    recommendedPerDay: recommended,
  });
  return { conflicts, cadence: cadence ? [cadence] : [] };
}

export function registerCalendarRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/calendar/settings', async () => ({
    timezone: resolveTimeZone(context.handle),
    cadencePerDay: cadenceSettings(context),
    conflictWindowMinutes: CALENDAR_CONFLICT_WINDOW_MS / 60_000,
  }));

  app.patch('/calendar/settings', async (request) => {
    const body = parseOrThrow(
      z.object({ timezone: z.string().min(1).optional(), cadencePerDay: cadenceSchema.optional() }),
      request.body,
      'CALENDAR_SETTINGS_INVALID',
    );
    if (body.timezone !== undefined) {
      if (!isValidTimeZone(body.timezone)) {
        throw new ValidationError('Fuseau horaire IANA invalide.', {
          code: 'CALENDAR_TIMEZONE_INVALID',
        });
      }
      setSetting(context.handle, 'timezone', body.timezone, 'string', context.clock.nowMs());
    }
    if (body.cadencePerDay !== undefined) {
      setSetting(
        context.handle,
        'calendar.cadence_per_day',
        body.cadencePerDay,
        'json',
        context.clock.nowMs(),
      );
    }
    return {
      timezone: resolveTimeZone(context.handle),
      cadencePerDay: cadenceSettings(context),
    };
  });

  app.get('/calendar', async (request) => {
    const query = request.query as {
      view?: 'today' | 'tomorrow' | 'week';
      from?: string;
      to?: string;
      projectId?: string;
    };
    const timezone = resolveTimeZone(context.handle);
    const defaultRange = calendarRange(context.clock.nowMs(), timezone, query.view ?? 'week');
    const from = query.from === undefined ? defaultRange.from : Number(query.from);
    const to = query.to === undefined ? defaultRange.to : Number(query.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
      throw new ValidationError('Fenêtre de calendrier invalide.', {
        code: 'CALENDAR_RANGE_INVALID',
      });
    }
    const records = context.scheduling.list({ from, to, projectId: query.projectId });
    const active = context.scheduling.listAllActive();
    return {
      timezone,
      from,
      to,
      slots: records.map((record) => ({
        ...slotView(context, record),
        conflicts: detectCalendarConflicts(
          { platformAccountId: record.platformAccountId, scheduledFor: record.scheduledFor },
          active,
          record.id,
        ),
      })),
    };
  });

  app.get('/calendar/summary', async () => {
    const timezone = resolveTimeZone(context.handle);
    const today = calendarRange(context.clock.nowMs(), timezone, 'today');
    const slots = context.scheduling.list({ ...today });
    const active = context.scheduling.listAllActive();
    const conflicts = active.flatMap((slot) =>
      detectCalendarConflicts(
        { platformAccountId: slot.platformAccountId, scheduledFor: slot.scheduledFor },
        active,
        slot.id,
      ),
    );
    let contentToValidate = 0;
    let approvedUnscheduled = 0;
    for (const project of context.memory.store.projects.list({ includeArchived: false })) {
      for (const item of context.editorial.ports.store.listContentItems(project.id)) {
        if (['draft', 'generated', 'in_review'].includes(item.state)) contentToValidate += 1;
        if (
          item.state === 'approved' &&
          !active.some((calendarSlot) => calendarSlot.contentItemId === item.id)
        ) {
          approvedUnscheduled += 1;
        }
      }
    }
    const upcoming = active
      .filter((slot) => slot.scheduledFor >= context.clock.nowMs())
      .sort((a, b) => a.scheduledFor - b.scheduledFor)[0];
    return {
      timezone,
      today: slots.length,
      next: upcoming ? slotView(context, upcoming) : null,
      missed: context.scheduling
        .list({ from: 0, to: context.clock.nowMs() + 1, includeCancelled: true })
        .filter((slot) => slot.status === 'missed').length,
      conflicts: new Set(conflicts.map((conflict) => conflict.slotId)).size,
      contentToValidate,
      approvedUnscheduled,
    };
  });

  app.post('/calendar/slots', async (request, reply) => {
    const body = parseOrThrow(createSlotSchema, request.body, 'CALENDAR_SLOT_INVALID');
    const version = context.editorial.ports.store.getVersion(body.contentVersionId);
    if (!version) {
      throw new NotFoundError('Version de contenu introuvable.', {
        code: 'CONTENT_VERSION_NOT_FOUND',
      });
    }
    const item = context.editorial.ports.store.getContentItem(version.contentItemId);
    if (!item) {
      throw new NotFoundError('Contenu introuvable.', { code: 'CONTENT_NOT_FOUND' });
    }
    if (
      item.archivedAt !== null ||
      item.approvedVersionId !== version.id ||
      version.approvedAt === null
    ) {
      throw new ConflictError('Seule la version approuvée courante peut être planifiée.', {
        code: 'CALENDAR_REQUIRES_APPROVAL',
      });
    }
    const account = context.publishing.getAccount(body.platformAccountId);
    if (!account) {
      throw new NotFoundError('Compte plateforme introuvable.', {
        code: 'PLATFORM_ACCOUNT_NOT_FOUND',
      });
    }
    if (account.projectId !== item.projectId || account.platform !== item.platform) {
      throw new ConflictError('Le compte est incompatible avec ce contenu.', {
        code: 'CALENDAR_ACCOUNT_MISMATCH',
      });
    }
    if (context.scheduling.findActiveForVersionAccount(version.id, account.id)) {
      throw new ConflictError('Cette version est déjà planifiée pour ce compte.', {
        code: 'CALENDAR_SLOT_DUPLICATE',
      });
    }
    const scheduledFor = localDateTimeToEpochMs({
      localDate: body.localDate,
      localTime: body.localTime,
      timeZone: body.timezone,
    });
    if (scheduledFor <= context.clock.nowMs()) {
      throw new ValidationError('Le créneau doit être dans le futur.', {
        code: 'CALENDAR_DATE_IN_PAST',
      });
    }
    const idempotencyKey = publicationIdempotencyKey({
      contentVersionId: version.id,
      platformAccountId: account.id,
      scheduledFor,
    });
    const ensured = context.publishing.ensurePublication({
      projectId: item.projectId,
      contentItemId: item.id,
      contentVersionId: version.id,
      platformAccountId: account.id,
      platform: item.platform,
      scheduledFor,
      idempotencyKey,
      status: 'planned',
    });
    if (!ensured.created) {
      throw new ConflictError(
        `Cette version possède déjà une publication « ${ensured.publication.status} ».`,
        { code: 'CALENDAR_PUBLICATION_ALREADY_SETTLED' },
      );
    }
    const jobId = await context.editorial.queue.enqueue(
      PUBLISH_CONTENT_JOB,
      { publicationId: ensured.publication.id },
      {
        delayMs: scheduledFor - context.clock.nowMs(),
        projectId: item.projectId,
        contentItemId: item.id,
      },
    );
    const created = context.scheduling.createSlot({
      projectId: item.projectId,
      contentItemId: item.id,
      contentVersionId: version.id,
      platformAccountId: account.id,
      platform: item.platform as PlatformId,
      scheduledFor,
      timezone: body.timezone,
      rigidity: body.rigidity,
      publicationId: ensured.publication.id,
      jobId,
    });
    reply.status(201);
    return { slot: slotView(context, created), warnings: warningsFor(context, created) };
  });

  app.patch('/calendar/slots/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(updateSlotSchema, request.body, 'CALENDAR_SLOT_UPDATE_INVALID');
    const current = slotOrThrow(context, id);
    if (!['scheduled', 'due', 'missed'].includes(current.status)) {
      throw new ConflictError(`Le créneau « ${current.status} » n’est plus modifiable.`, {
        code: 'CALENDAR_SLOT_TERMINAL',
      });
    }
    let changed = current;
    const changesDate =
      body.localDate !== undefined || body.localTime !== undefined || body.timezone !== undefined;
    if (changesDate) {
      const local = epochMsToLocalDateTime(current.scheduledFor, current.timezone);
      const scheduledFor = localDateTimeToEpochMs({
        localDate: body.localDate ?? local.localDate,
        localTime: body.localTime ?? local.localTime,
        timeZone: body.timezone ?? current.timezone,
      });
      if (scheduledFor <= context.clock.nowMs()) {
        throw new ValidationError('Le nouveau créneau doit être dans le futur.', {
          code: 'CALENDAR_DATE_IN_PAST',
        });
      }
      changed =
        context.scheduling.updateSchedule(id, {
          scheduledFor,
          timezone: body.timezone ?? current.timezone,
          ...(body.rigidity ? { rigidity: body.rigidity } : {}),
        }) ?? current;
    } else if (body.rigidity) {
      changed = context.scheduling.setRigidity(id, body.rigidity) ?? current;
    }
    return { slot: slotView(context, changed), warnings: warningsFor(context, changed) };
  });

  app.post('/calendar/slots/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(
      z.object({ reason: z.string().trim().min(3).max(500).optional() }),
      request.body ?? {},
      'CALENDAR_CANCEL_INVALID',
    );
    slotOrThrow(context, id);
    const cancelled = context.scheduling.cancel(
      id,
      body.reason ?? 'Créneau annulé par l’utilisateur.',
    );
    if (!cancelled) {
      throw new ConflictError('Ce créneau ne peut plus être annulé.', {
        code: 'CALENDAR_CANCEL_REFUSED',
      });
    }
    return { slot: slotView(context, cancelled) };
  });

  app.post('/calendar/slots/:id/publish-now', async (request) => {
    const { id } = request.params as { id: string };
    slotOrThrow(context, id);
    const due = context.scheduling.publishNow(id);
    if (!due) {
      throw new ConflictError('Ce créneau ne peut plus être publié maintenant.', {
        code: 'CALENDAR_PUBLISH_NOW_REFUSED',
      });
    }
    return { slot: slotView(context, due), jobId: due.jobId };
  });

  app.post('/calendar/slots/:id/proposals', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(proposalSchema, request.body, 'CALENDAR_PROPOSAL_INVALID');
    const current = slotOrThrow(context, id);
    if (!canProposeAutomaticMove(current.rigidity as CalendarRigidity)) {
      throw new ConflictError('Un créneau LOCKED ne peut pas être proposé au déplacement.', {
        code: 'CALENDAR_LOCKED_PROPOSAL_REFUSED',
      });
    }
    const local = epochMsToLocalDateTime(current.scheduledFor, current.timezone);
    const changesDate =
      body.localDate !== undefined || body.localTime !== undefined || body.timezone !== undefined;
    const proposedScheduledFor = changesDate
      ? localDateTimeToEpochMs({
          localDate: body.localDate ?? local.localDate,
          localTime: body.localTime ?? local.localTime,
          timeZone: body.timezone ?? current.timezone,
        })
      : null;
    const created = context.scheduling.createProposal({
      calendarSlotId: id,
      proposedScheduledFor,
      proposedTimezone: body.timezone ?? null,
      proposedRigidity: body.rigidity ?? null,
      reason: body.reason,
    });
    reply.status(201);
    return { proposal: created };
  });

  app.get('/calendar/proposals', async (request) => {
    const query = request.query as { slotId?: string };
    return { proposals: context.scheduling.listProposals(query.slotId) };
  });

  app.post('/calendar/proposals/:id/decision', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(
      z.object({ decision: z.enum(['accepted', 'rejected']) }),
      request.body,
      'CALENDAR_PROPOSAL_DECISION_INVALID',
    );
    const resolved = context.scheduling.resolveProposal(id, body.decision);
    if (!resolved) {
      throw new ConflictError('Cette proposition est absente ou déjà tranchée.', {
        code: 'CALENDAR_PROPOSAL_ALREADY_RESOLVED',
      });
    }
    return {
      proposal: resolved,
      slot: slotView(context, slotOrThrow(context, resolved.calendarSlotId)),
    };
  });

  /** SSE du calendrier : snapshot initial puis invalidations, sans polling navigateur. */
  app.get('/events/calendar', async (request, reply) => {
    const query = request.query as { intervalMs?: string };
    const intervalMs = Math.min(Math.max(Number(query.intervalMs ?? 1_000) || 1_000, 500), 10_000);
    let revision = context.scheduling.latestUpdatedAt();
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
      const latest = context.scheduling.latestUpdatedAt();
      if (latest > revision) {
        revision = latest;
        send('calendar_changed', { revision });
      }
    }, intervalMs);
    request.raw.on('close', () => clearInterval(interval));
  });
}
