import { afterEach, describe, expect, it } from 'vitest';
import {
  createEditorialStore,
  createSchedulingStore,
  getJob,
  type CalendarSlotRecord,
} from '@aia/database';
import { createJobRegistry, publishContentSpec } from '@aia/queue';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createWorkerLoop } from '../../apps/worker/src/loop';
import { CALENDAR_LATE_TOLERANCE_MS } from '@aia/core';
import { createTestContext, type TestContext } from '../support/harness';

let created: TestContext[] = [];

afterEach(() => {
  for (const context of created) context.cleanup();
  created = [];
});

function makeStack() {
  const context = createTestContext();
  created.push(context);
  context.registry.registerSpec(publishContentSpec);
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    editorialQueue: context.queue,
  });
  return { context, api, app: buildServer(api) };
}

async function seed(
  stack: ReturnType<typeof makeStack>,
  options: { approved?: boolean; name?: string } = {},
) {
  const projectResponse = await stack.app.inject({
    method: 'POST',
    url: '/projects',
    payload: { name: options.name ?? 'Calendrier' },
  });
  const projectId = (projectResponse.json() as { project: { id: string } }).project.id;
  const store = createEditorialStore(stack.context.handle, {
    nowMs: () => stack.context.clock.nowMs(),
  });
  const item = store.createContentItem({
    projectId,
    subjectId: null,
    angleId: null,
    platform: 'linkedin',
    target: 'linkedin_post',
    format: 'post_texte',
    contentHash: null,
  });
  const version = store.addVersion({
    contentItemId: item.id,
    versionNumber: 1,
    body: 'Une publication planifiée et approuvée.',
    title: options.name ?? 'Finance App',
    hook: 'Planifier sans doubler',
    hashtags: [],
    mentions: [],
    charCount: 38,
    wordCount: 5,
    readingTimeSec: 5,
    generation: 'initial',
    promptVersionHash: null,
    llmCallId: null,
    modelUsed: null,
    temperatureX100: null,
  });
  if (options.approved !== false) {
    store.approveVersion(version.id, null);
    store.updateContentItem(item.id, {
      state: 'approved',
      currentVersionId: version.id,
      approvedVersionId: version.id,
      approvedAt: stack.context.clock.nowMs(),
    });
  }
  const accountResponse = await stack.app.inject({
    method: 'POST',
    url: `/projects/${projectId}/platform-accounts`,
    payload: { platform: 'linkedin', accountLabel: 'LinkedIn principal' },
  });
  const accountId = (accountResponse.json() as { account: { id: string } }).account.id;
  return { projectId, itemId: item.id, versionId: version.id, accountId };
}

async function schedule(
  stack: ReturnType<typeof makeStack>,
  fixture: Awaited<ReturnType<typeof seed>>,
  input: Partial<{
    localDate: string;
    localTime: string;
    rigidity: 'LOCKED' | 'FLEXIBLE' | 'EVERGREEN';
  }> = {},
) {
  return stack.app.inject({
    method: 'POST',
    url: '/calendar/slots',
    payload: {
      contentVersionId: fixture.versionId,
      platformAccountId: fixture.accountId,
      localDate: input.localDate ?? '2026-03-10',
      localTime: input.localTime ?? '13:00',
      timezone: 'UTC',
      rigidity: input.rigidity ?? 'FLEXIBLE',
    },
  });
}

function bodySlot(response: Awaited<ReturnType<typeof schedule>>): CalendarSlotRecord {
  return (response.json() as { slot: CalendarSlotRecord }).slot;
}

describe('calendrier éditorial (étape 9)', () => {
  it('crée, affiche, déplace et annule un créneau sans supprimer le contenu', async () => {
    const stack = makeStack();
    const fixture = await seed(stack);
    const created = await schedule(stack, fixture);
    expect(created.statusCode).toBe(201);
    const slot = bodySlot(created);
    expect(slot.rigidity).toBe('FLEXIBLE');
    expect(slot.status).toBe('scheduled');
    const scheduling = createSchedulingStore(stack.context.handle, () =>
      stack.context.clock.nowMs(),
    );
    const revisionBeforeMove = scheduling.latestUpdatedAt();

    const week = await stack.app.inject({ method: 'GET', url: '/calendar?view=week' });
    expect(week.statusCode).toBe(200);
    expect((week.json() as { slots: unknown[] }).slots).toHaveLength(1);

    const moved = await stack.app.inject({
      method: 'PATCH',
      url: `/calendar/slots/${slot.id}`,
      payload: { localDate: '2026-03-10', localTime: '14:00', rigidity: 'EVERGREEN' },
    });
    expect(moved.statusCode).toBe(200);
    expect((moved.json() as { slot: CalendarSlotRecord }).slot).toMatchObject({
      rigidity: 'EVERGREEN',
      scheduledFor: Date.UTC(2026, 2, 10, 14),
    });
    // La révision SSE est monotone même avec une horloge figée à la même ms.
    expect(scheduling.latestUpdatedAt()).toBeGreaterThan(revisionBeforeMove);

    const cancelled = await stack.app.inject({
      method: 'POST',
      url: `/calendar/slots/${slot.id}/cancel`,
      payload: { reason: 'Changement éditorial.' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { slot: CalendarSlotRecord }).slot.status).toBe('cancelled');
    expect(
      createEditorialStore(stack.context.handle, { nowMs: () => 0 }).getContentItem(fixture.itemId),
    ).not.toBeNull();
    expect(getJob(stack.context.handle, slot.jobId!)?.status).toBe('cancelled');
  });

  it('refuse le contenu non approuvé, une date passée et un compte incompatible', async () => {
    const stack = makeStack();
    const draft = await seed(stack, { approved: false });
    const refused = await schedule(stack, draft);
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      'CALENDAR_REQUIRES_APPROVAL',
    );

    const approved = await seed(stack, { name: 'Deuxième projet' });
    const past = await schedule(stack, approved, { localTime: '11:00' });
    expect(past.statusCode).toBe(400);
    expect((past.json() as { error: { code: string } }).error.code).toBe('CALENDAR_DATE_IN_PAST');
    const mismatch = await stack.app.inject({
      method: 'POST',
      url: '/calendar/slots',
      payload: {
        contentVersionId: approved.versionId,
        platformAccountId: draft.accountId,
        localDate: '2026-03-10',
        localTime: '15:00',
        timezone: 'UTC',
        rigidity: 'LOCKED',
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect((mismatch.json() as { error: { code: string } }).error.code).toBe(
      'CALENDAR_ACCOUNT_MISMATCH',
    );
  });

  it('avertit sur les conflits et la cadence sans empêcher la décision finale', async () => {
    const stack = makeStack();
    const first = await seed(stack);
    const secondStore = createEditorialStore(stack.context.handle, {
      nowMs: () => stack.context.clock.nowMs(),
    });
    const item = secondStore.createContentItem({
      projectId: first.projectId,
      subjectId: null,
      angleId: null,
      platform: 'linkedin',
      target: 'linkedin_post',
      format: 'post_texte',
      contentHash: null,
    });
    const version = secondStore.addVersion({
      contentItemId: item.id,
      versionNumber: 1,
      body: 'Deuxième contenu.',
      title: 'AI Team',
      hook: null,
      hashtags: [],
      mentions: [],
      charCount: 17,
      wordCount: 2,
      readingTimeSec: 2,
      generation: 'initial',
      promptVersionHash: null,
      llmCallId: null,
      modelUsed: null,
      temperatureX100: null,
    });
    secondStore.approveVersion(version.id, null);
    secondStore.updateContentItem(item.id, {
      state: 'approved',
      currentVersionId: version.id,
      approvedVersionId: version.id,
      approvedAt: stack.context.clock.nowMs(),
    });
    expect((await schedule(stack, first, { localTime: '13:00' })).statusCode).toBe(201);
    const conflict = await schedule(
      stack,
      { ...first, itemId: item.id, versionId: version.id },
      { localTime: '13:20' },
    );
    expect(conflict.statusCode).toBe(201);
    const warnings = conflict.json() as {
      warnings: { conflicts: unknown[]; cadence: string[] };
    };
    expect(warnings.warnings.conflicts).toHaveLength(1);
    expect(warnings.warnings.cadence[0]).toContain('2 publications');
  });

  it('ne déplace jamais LOCKED par proposition et applique seulement une proposition acceptée', async () => {
    const stack = makeStack();
    const flexible = await seed(stack);
    const created = await schedule(stack, flexible, { rigidity: 'FLEXIBLE' });
    const slot = bodySlot(created);
    const proposed = await stack.app.inject({
      method: 'POST',
      url: `/calendar/slots/${slot.id}/proposals`,
      payload: {
        localDate: '2026-03-10',
        localTime: '15:00',
        reason: 'Insérer un contenu prioritaire plus tard.',
      },
    });
    expect(proposed.statusCode).toBe(201);
    const proposalId = (proposed.json() as { proposal: { id: string } }).proposal.id;
    expect(stack.api.scheduling.getSlot(slot.id)?.scheduledFor).toBe(Date.UTC(2026, 2, 10, 13));
    const accepted = await stack.app.inject({
      method: 'POST',
      url: `/calendar/proposals/${proposalId}/decision`,
      payload: { decision: 'accepted' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(stack.api.scheduling.getSlot(slot.id)?.scheduledFor).toBe(Date.UTC(2026, 2, 10, 15));

    const rejectedProposal = await stack.app.inject({
      method: 'POST',
      url: `/calendar/slots/${slot.id}/proposals`,
      payload: {
        localTime: '18:00',
        reason: 'Proposition à refuser explicitement.',
      },
    });
    const rejectedId = (rejectedProposal.json() as { proposal: { id: string } }).proposal.id;
    const rejected = await stack.app.inject({
      method: 'POST',
      url: `/calendar/proposals/${rejectedId}/decision`,
      payload: { decision: 'rejected' },
    });
    expect(rejected.statusCode).toBe(200);
    expect(stack.api.scheduling.getSlot(slot.id)?.scheduledFor).toBe(Date.UTC(2026, 2, 10, 15));

    const lockedFixture = await seed(stack, { name: 'Locked' });
    const locked = await schedule(stack, lockedFixture, { rigidity: 'LOCKED', localTime: '16:00' });
    const refused = await stack.app.inject({
      method: 'POST',
      url: `/calendar/slots/${bodySlot(locked).id}/proposals`,
      payload: { localTime: '17:00', reason: 'Déplacement automatique.' },
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe(
      'CALENDAR_LOCKED_PROPOSAL_REFUSED',
    );
  });

  it('n’exécute jamais avant l’heure, promeut à T0 et ne publie qu’une fois avec retry', async () => {
    const stack = makeStack();
    const fixture = await seed(stack);
    const response = await schedule(stack, fixture, { localTime: '13:00' });
    const slot = bodySlot(response);
    let executions = 0;
    const workerRegistry = createJobRegistry();
    workerRegistry.register({
      ...publishContentSpec,
      handler: async () => {
        executions += 1;
        return { ok: true };
      },
    });
    const scheduling = createSchedulingStore(stack.context.handle, () =>
      stack.context.clock.nowMs(),
    );
    const worker = createWorkerLoop({
      handle: stack.context.handle,
      queue: stack.context.queue,
      registry: workerRegistry,
      logger: stack.context.logger,
      clock: stack.context.clock,
      workerId: 'calendar-test',
      pollMs: 60_000,
      heartbeatMs: 10_000,
      batchSize: 1,
      offline: false,
      promoteCalendar: (now) => scheduling.promoteDue(now, CALENDAR_LATE_TOLERANCE_MS),
    });
    expect(await worker.runOnce()).toBe(0);
    stack.context.clock.set(Date.UTC(2026, 2, 10, 12, 59));
    expect(await worker.runOnce()).toBe(0);
    stack.context.clock.set(Date.UTC(2026, 2, 10, 13));
    expect(await worker.runOnce()).toBe(1);
    expect(executions).toBe(1);
    expect(scheduling.getSlot(slot.id)?.status).toBe('due');
    stack.context.clock.set(Date.UTC(2026, 2, 10, 13, 5));
    expect(await worker.runOnce()).toBe(0);
    expect(executions).toBe(1);
  });

  it('au redémarrage publie un léger retard, mais classe un retard important en missed', async () => {
    const slightlyLate = makeStack();
    const dueFixture = await seed(slightlyLate);
    const dueResponse = await schedule(slightlyLate, dueFixture, { localTime: '13:00' });
    const dueSlot = bodySlot(dueResponse);
    let executions = 0;
    const restartedRegistry = createJobRegistry();
    restartedRegistry.register({
      ...publishContentSpec,
      handler: async () => {
        executions += 1;
        return { ok: true };
      },
    });
    // Le worker est reconstruit après dix minutes d'arrêt : SQLite suffit à
    // retrouver et promouvoir le travail, sans minuterie restée en mémoire.
    slightlyLate.context.clock.set(Date.UTC(2026, 2, 10, 13, 10));
    const restartedScheduling = createSchedulingStore(slightlyLate.context.handle, () =>
      slightlyLate.context.clock.nowMs(),
    );
    const restartedWorker = createWorkerLoop({
      handle: slightlyLate.context.handle,
      queue: slightlyLate.context.queue,
      registry: restartedRegistry,
      logger: slightlyLate.context.logger,
      clock: slightlyLate.context.clock,
      workerId: 'calendar-restarted-test',
      pollMs: 60_000,
      heartbeatMs: 10_000,
      batchSize: 1,
      offline: false,
      promoteCalendar: (now) => restartedScheduling.promoteDue(now, CALENDAR_LATE_TOLERANCE_MS),
    });
    expect(await restartedWorker.runOnce()).toBe(1);
    expect(executions).toBe(1);
    expect(restartedScheduling.getSlot(dueSlot.id)?.status).toBe('due');

    const stack = makeStack();
    const fixture = await seed(stack);
    const response = await schedule(stack, fixture, { localTime: '13:00' });
    const slot = bodySlot(response);
    const scheduling = createSchedulingStore(stack.context.handle, () =>
      stack.context.clock.nowMs(),
    );
    stack.context.clock.set(Date.UTC(2026, 2, 10, 13, 20));
    const result = scheduling.promoteDue(stack.context.clock.nowMs(), CALENDAR_LATE_TOLERANCE_MS);
    expect(result.missed).toEqual([slot.id]);
    expect(scheduling.getSlot(slot.id)?.status).toBe('missed');
    expect(getJob(stack.context.handle, slot.jobId!)?.status).toBe('cancelled');

    const publishNow = await stack.app.inject({
      method: 'POST',
      url: `/calendar/slots/${slot.id}/publish-now`,
      payload: {},
    });
    expect(publishNow.statusCode).toBe(200);
    expect((publishNow.json() as { slot: CalendarSlotRecord }).slot.status).toBe('due');
    expect(getJob(stack.context.handle, slot.jobId!)?.status).toBe('queued');
    const again = await stack.app.inject({
      method: 'POST',
      url: `/calendar/slots/${slot.id}/publish-now`,
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    const jobs = stack.context.handle.sqlite
      .prepare("select count(*) as total from jobs where type = 'publish_content'")
      .get() as { total: number };
    expect(jobs.total).toBe(1);
  });
});
