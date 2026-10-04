import { afterEach, describe, expect, it } from 'vitest';
import {
  createEditorialStore,
  createNewsStore,
  createSchedulingStore,
  getJob,
} from '@aia/database';
import { normalizeRawNewsItem, type NewsProvider, type NormalizedNewsItem } from '@aia/news';
import { publishContentSpec } from '@aia/queue';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createCollectNewsHandler } from '../../apps/worker/src/handlers/collect-news';
import { createWorkerLoop } from '../../apps/worker/src/loop';
import { createTestContext, type TestContext } from '../support/harness';

let contexts: TestContext[] = [];

afterEach(() => {
  for (const context of contexts) context.cleanup();
  contexts = [];
});

function scriptedProvider(
  itemFactory: (sourceId: string, sourceUrl: string) => NormalizedNewsItem[],
): NewsProvider<NormalizedNewsItem[]> {
  return {
    type: 'rss',
    fetchLatest: async (source) => itemFactory(source.id, source.url),
    normalize: (payload) => payload,
    healthCheck: async () => ({ ok: true, detail: 'scripté', checkedAt: 0 }),
  };
}

function workerFor(context: TestContext, workerId: string) {
  return createWorkerLoop({
    handle: context.handle,
    queue: context.queue,
    registry: context.registry,
    logger: context.logger,
    clock: context.clock,
    workerId,
    pollMs: 60_000,
    heartbeatMs: 10_000,
    batchSize: 1,
    offline: false,
  });
}

function makeStack(provider?: NewsProvider) {
  const context = createTestContext();
  contexts.push(context);
  const news = createNewsStore(context.handle, () => context.clock.nowMs());
  // Le calendrier crée ses jobs futurs ; ce test n'a pas à les exécuter, mais
  // le producteur doit connaître leur contrat comme dans l'API de production.
  context.registry.registerSpec(publishContentSpec);
  const selected =
    provider ??
    scriptedProvider((sourceId, sourceUrl) => [
      normalizeRawNewsItem(
        {
          externalId: 'react-20',
          url: `${sourceUrl.replace(/\/feed\.xml$/, '')}/react-20?utm_source=rss`,
          title: 'React 20 améliore TypeScript pour les développeurs',
          summary: 'Une nouvelle API aide les équipes frontend et les outils IA.',
          publishedAt: context.clock.nowMs() - 2 * 60 * 60_000,
          author: 'Équipe React',
        },
        {
          id: sourceId,
          name: 'Scriptée',
          type: 'rss',
          url: sourceUrl,
          categories: ['react', 'typescript', 'dev'],
          trustLevel: 5,
          language: 'fr',
        },
      ),
    ]);
  context.registry.register(
    createCollectNewsHandler({
      news,
      provider: () => selected,
      projectContext: (projectId) => ({
        name: `Projet ${projectId}`,
        terms: ['react', 'typescript', 'frontend', 'ia'],
        audienceTerms: ['développeurs', 'équipes'],
      }),
      clock: context.clock,
    }),
  );
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    editorialQueue: context.queue,
  });
  const worker = workerFor(context, 'news-test');
  return { context, news, app: buildServer(api), worker, api };
}

async function project(stack: ReturnType<typeof makeStack>, name = 'Frontend Finance') {
  const response = await stack.app.inject({ method: 'POST', url: '/projects', payload: { name } });
  return (response.json() as { project: { id: string } }).project.id;
}

async function source(stack: ReturnType<typeof makeStack>, projectId: string, suffix = 'a') {
  return stack.app.inject({
    method: 'POST',
    url: '/news/sources',
    payload: {
      projectId,
      name: `Flux React ${suffix}`,
      type: 'rss',
      url: `https://${suffix}.example.test/feed.xml`,
      categories: ['react', 'typescript', 'dev'],
      keywords: ['frontend', 'ia'],
      excludeKeywords: [],
      trustLevel: 5,
      refreshHours: 6,
      language: 'fr',
    },
  });
}

describe('veille étape 10 : collecte, reprise et déduplication', () => {
  it('collecte, score, explique et ne duplique ni une relecture ni une autre source', async () => {
    const stack = makeStack();
    const projectId = await project(stack);
    const first = await source(stack, projectId, 'premier');
    expect(first.statusCode).toBe(201);
    const firstId = (first.json() as { source: { id: string } }).source.id;

    const collect = await stack.app.inject({
      method: 'POST',
      url: `/news/sources/${firstId}/collect`,
    });
    expect(collect.statusCode).toBe(202);
    // Une nouvelle boucle construite après l'enqueue reprend le job persistant :
    // aucune minuterie du processus qui l'a créé n'est nécessaire.
    const restartedWorker = workerFor(stack.context, 'news-restarted');
    expect(await restartedWorker.runOnce()).toBe(1);
    const firstJob = getJob(stack.context.handle, (collect.json() as { jobId: string }).jobId);
    expect(firstJob?.status).toBe('completed');

    const listed = await stack.app.inject({ method: 'GET', url: `/news?projectId=${projectId}` });
    const items = (
      listed.json() as {
        items: Array<{ finalScore: number; scoreExplanation: string[]; urgency: string }>;
      }
    ).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.finalScore).toBeGreaterThan(60);
    expect(items[0]!.scoreExplanation.join(' ')).toContain('Confiance source');
    expect(['BREAKING', 'HIGH']).toContain(items[0]!.urgency);

    await stack.app.inject({ method: 'POST', url: `/news/sources/${firstId}/collect` });
    expect(await restartedWorker.runOnce()).toBe(1);
    const second = await source(stack, projectId, 'second');
    const secondId = (second.json() as { source: { id: string } }).source.id;
    await stack.app.inject({ method: 'POST', url: `/news/sources/${secondId}/collect` });
    expect(await restartedWorker.runOnce()).toBe(1);
    expect(stack.news.listItems({ projectId })).toHaveLength(1);
    expect(stack.news.latestRevision()).toBeGreaterThan(0);
  });

  it('respecte source désactivée, fréquence et auto-désactivation après cinq erreurs', async () => {
    const failing: NewsProvider = {
      type: 'rss',
      fetchLatest: async () => {
        throw new Error('timeout simulé');
      },
      normalize: () => [],
      healthCheck: async () => ({ ok: false, detail: 'timeout', checkedAt: 0 }),
    };
    const stack = makeStack(failing);
    const projectId = await project(stack);
    const created = await source(stack, projectId);
    const sourceId = (created.json() as { source: { id: string } }).source.id;
    const collected = await stack.app.inject({
      method: 'POST',
      url: `/news/sources/${sourceId}/collect`,
    });
    const jobId = (collected.json() as { jobId: string }).jobId;
    expect(await stack.worker.runOnce()).toBe(1);
    expect(getJob(stack.context.handle, jobId)?.status).toBe('queued');
    expect(stack.news.sourceById(sourceId)?.consecutiveFailures).toBe(1);

    for (let attempt = 1; attempt < 5; attempt += 1) {
      stack.news.recordSourceFailure(sourceId, 'timeout simulé');
    }
    expect(stack.news.sourceById(sourceId)).toMatchObject({
      enabled: false,
      consecutiveFailures: 5,
    });
    expect(stack.news.listDueSources()).toHaveLength(0);
    const refused = await stack.app.inject({
      method: 'POST',
      url: `/news/sources/${sourceId}/collect`,
    });
    expect(refused.statusCode).toBe(409);
  });

  it('émet une révision monotone par SSE après une modification', async () => {
    const stack = makeStack();
    const projectId = await project(stack);
    await stack.app.listen({ host: '127.0.0.1', port: 0 });
    const address = stack.app.server.address();
    if (!address || typeof address === 'string') throw new Error('Adresse de test absente.');
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/events/news?intervalMs=500`, {
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Flux SSE absent.');
    const decoder = new TextDecoder();
    let stream = '';
    try {
      while (!stream.includes('event: snapshot')) {
        const next = await reader.read();
        if (next.done) throw new Error('Flux SSE fermé avant le snapshot.');
        stream += decoder.decode(next.value, { stream: true });
      }
      await source(stack, projectId, 'sse');
      const deadline = Date.now() + 3_000;
      while (!stream.includes('event: news_changed') && Date.now() < deadline) {
        const next = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error('SSE news_changed non reçu.')), 1_000),
          ),
        ]);
        if (next.done) break;
        stream += decoder.decode(next.value, { stream: true });
      }
      expect(stream).toContain('event: news_changed');
      expect(stack.news.latestRevision()).toBeGreaterThan(0);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await stack.app.close();
    }
  });
});

async function approvedFixture(
  stack: ReturnType<typeof makeStack>,
  projectId: string,
  title: string,
) {
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
    body: `${title} approuvé.`,
    title,
    hook: null,
    hashtags: [],
    mentions: [],
    charCount: 20,
    wordCount: 3,
    readingTimeSec: 2,
    generation: 'initial',
    promptVersionHash: null,
    llmCallId: null,
    modelUsed: null,
    temperatureX100: null,
  });
  store.approveVersion(version.id, null);
  store.updateContentItem(item.id, {
    state: 'approved',
    currentVersionId: version.id,
    approvedVersionId: version.id,
    approvedAt: stack.context.clock.nowMs(),
  });
  return { item, version };
}

describe('veille étape 10 : suggestion et proposition calendrier', () => {
  it('protège LOCKED et ne déplace FLEXIBLE/EVERGREEN qu’après acceptation', async () => {
    const stack = makeStack();
    const projectId = await project(stack, 'Finance React');
    const accountResponse = await stack.app.inject({
      method: 'POST',
      url: `/projects/${projectId}/platform-accounts`,
      payload: { platform: 'linkedin', accountLabel: 'Compte veille' },
    });
    const accountId = (accountResponse.json() as { account: { id: string } }).account.id;
    const rigidities = ['LOCKED', 'FLEXIBLE', 'EVERGREEN'] as const;
    const slots: Array<{ id: string; scheduledFor: number; rigidity: string }> = [];
    for (const [index, rigidity] of rigidities.entries()) {
      const fixture = await approvedFixture(stack, projectId, rigidity);
      const response = await stack.app.inject({
        method: 'POST',
        url: '/calendar/slots',
        payload: {
          contentVersionId: fixture.version.id,
          platformAccountId: accountId,
          localDate: '2026-03-10',
          localTime: `${15 + index}:00`,
          timezone: 'UTC',
          rigidity,
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      slots.push(
        (response.json() as { slot: { id: string; scheduledFor: number; rigidity: string } }).slot,
      );
    }

    const createdSource = await source(stack, projectId);
    const sourceId = (createdSource.json() as { source: { id: string } }).source.id;
    await stack.app.inject({ method: 'POST', url: `/news/sources/${sourceId}/collect` });
    await stack.worker.runOnce();
    const newsItem = stack.news.listItems({ projectId })[0]!;
    const needsReview = await stack.app.inject({
      method: 'POST',
      url: `/news/${newsItem.id}/verification`,
      payload: { status: 'needs_review' },
    });
    expect(needsReview.statusCode).toBe(200);
    expect(stack.news.itemById(newsItem.id)?.verificationStatus).toBe('needs_review');
    await stack.app.inject({
      method: 'POST',
      url: `/news/${newsItem.id}/verification`,
      payload: { status: 'confirmed' },
    });
    expect(stack.news.itemById(newsItem.id)).toMatchObject({
      verificationStatus: 'confirmed',
      verified: true,
    });
    const idea = await stack.app.inject({ method: 'POST', url: `/news/${newsItem.id}/suggestion` });
    expect(idea.statusCode).toBe(201);
    expect(stack.news.itemById(newsItem.id)?.suggestion).toMatchObject({
      verificationRequired: true,
    });

    const propose = (slotId: string, hour: string) =>
      stack.app.inject({
        method: 'POST',
        url: `/news/${newsItem.id}/calendar-proposal`,
        payload: {
          calendarSlotId: slotId,
          localDate: '2026-03-11',
          localTime: hour,
          timezone: 'UTC',
        },
      });
    expect((await propose(slots[0]!.id, '10:00')).statusCode).toBe(409);

    const flexible = await propose(slots[1]!.id, '11:00');
    expect(flexible.statusCode).toBe(201);
    expect(
      createSchedulingStore(stack.context.handle, () => stack.context.clock.nowMs()).getSlot(
        slots[1]!.id,
      )?.scheduledFor,
    ).toBe(slots[1]!.scheduledFor);
    const flexibleProposal = (flexible.json() as { proposal: { id: string } }).proposal.id;
    await stack.app.inject({
      method: 'POST',
      url: `/calendar/proposals/${flexibleProposal}/decision`,
      payload: { decision: 'accepted' },
    });
    expect(
      createSchedulingStore(stack.context.handle, () => stack.context.clock.nowMs()).getSlot(
        slots[1]!.id,
      )?.scheduledFor,
    ).toBe(Date.UTC(2026, 2, 11, 11));

    const evergreen = await propose(slots[2]!.id, '12:00');
    expect(evergreen.statusCode).toBe(201);
    const evergreenProposal = (evergreen.json() as { proposal: { id: string } }).proposal.id;
    await stack.app.inject({
      method: 'POST',
      url: `/calendar/proposals/${evergreenProposal}/decision`,
      payload: { decision: 'rejected' },
    });
    expect(
      createSchedulingStore(stack.context.handle, () => stack.context.clock.nowMs()).getSlot(
        slots[2]!.id,
      )?.scheduledFor,
    ).toBe(slots[2]!.scheduledFor);
  });
});
