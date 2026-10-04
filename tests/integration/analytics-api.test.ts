import { afterEach, describe, expect, it } from 'vitest';
import { createEditorialStore, createPublishingStore } from '@aia/database';
import {
  analyzePerformanceSpec,
  collectMetricsSpec,
  extractContentFeaturesSpec,
  rebuildPatternsSpec,
} from '@aia/queue';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createTestContext, type TestContext } from '../support/harness';

let contexts: TestContext[] = [];

afterEach(() => {
  for (const context of contexts) context.cleanup();
  contexts = [];
});

async function fixture() {
  const context = createTestContext();
  contexts.push(context);
  for (const spec of [
    collectMetricsSpec,
    analyzePerformanceSpec,
    extractContentFeaturesSpec,
    rebuildPatternsSpec,
  ])
    context.registry.registerSpec(spec);
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    editorialQueue: context.queue,
  });
  const app = buildServer(api);
  const projectResponse = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: { name: 'Analytics local' },
  });
  const projectId = (projectResponse.json() as { project: { id: string } }).project.id;
  const editorial = createEditorialStore(context.handle, { nowMs: () => context.clock.nowMs() });
  const item = editorial.createContentItem({
    projectId,
    subjectId: null,
    angleId: null,
    platform: 'linkedin',
    target: 'linkedin_post',
    format: 'post_texte',
    contentHash: null,
  });
  const version = editorial.addVersion({
    contentItemId: item.id,
    versionNumber: 1,
    body: 'Voici le résultat. Trois étapes concrètes. Et vous, qu’en pensez-vous ?',
    title: null,
    hook: 'Voici le résultat.',
    hashtags: [],
    mentions: [],
    charCount: 70,
    wordCount: 11,
    readingTimeSec: 6,
    generation: 'initial',
    promptVersionHash: null,
    llmCallId: null,
    modelUsed: null,
    temperatureX100: null,
  });
  editorial.approveVersion(version.id, null);
  editorial.updateContentItem(item.id, {
    state: 'approved',
    currentVersionId: version.id,
    approvedVersionId: version.id,
    approvedAt: context.clock.nowMs(),
  });
  const publishing = createPublishingStore(context.handle, () => context.clock.nowMs());
  const account = publishing.createAccount({
    projectId,
    platform: 'linkedin',
    accountLabel: 'Manuel',
    remoteAccountId: null,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    capabilities: { level: 'C', analytics: false },
  });
  const { publication } = publishing.ensurePublication({
    projectId,
    contentItemId: item.id,
    contentVersionId: version.id,
    platformAccountId: account.id,
    platform: 'linkedin',
    idempotencyKey: 'analytics-fixture',
    status: 'published',
  });
  publishing.settlePublication(publication.id, {
    status: 'published',
    publishedAt: context.clock.nowMs() - 3_600_000,
  });
  return { app, context, projectId, publicationId: publication.id };
}

describe('API analytics étape 11', () => {
  it('historise sans inventer, puis remplace idempotemment le snapshot du jour', async () => {
    const { app, projectId, publicationId } = await fixture();
    const first = await app.inject({
      method: 'POST',
      url: '/analytics/metrics',
      payload: { publicationId, views: 1_400, likes: 30, provenance: 'export LinkedIn' },
    });
    expect(first.statusCode).toBe(201);
    expect((first.json() as { snapshot: { shares: number | null } }).snapshot.shares).toBeNull();

    const second = await app.inject({
      method: 'POST',
      url: '/analytics/metrics',
      payload: { publicationId, views: 1_600, likes: 35, provenance: 'export LinkedIn' },
    });
    expect(second.statusCode).toBe(201);

    const analytics = await app.inject({ method: 'GET', url: `/analytics?projectId=${projectId}` });
    const body = analytics.json() as { snapshots: Array<{ views: number; shares: null }> };
    expect(body.snapshots).toHaveLength(1);
    expect(body.snapshots[0]).toMatchObject({ views: 1_600, shares: null });
  });

  it('reste utilisable manuellement et enfile les jobs observables sans API sociale', async () => {
    const { app, context, projectId, publicationId } = await fixture();
    await app.inject({
      method: 'POST',
      url: '/analytics/metrics',
      payload: { publicationId, views: 300 },
    });
    const analyze = await app.inject({
      method: 'POST',
      url: '/analytics/analyze',
      payload: { projectId, publicationId },
    });
    expect(analyze.statusCode).toBe(202);
    const jobs = context.handle.sqlite
      .prepare(
        "select type, idempotent, max_attempts from jobs where type in ('analyze_performance','extract_content_features') order by type",
      )
      .all() as Array<{ type: string; idempotent: number; max_attempts: number }>;
    expect(jobs.map((job) => job.type)).toEqual([
      'analyze_performance',
      'extract_content_features',
    ]);
    expect(jobs.every((job) => job.idempotent === 1 && job.max_attempts > 1)).toBe(true);
  });

  it('importe un exemple public minimal, conserve sa provenance et déduplique son URL', async () => {
    const { app, projectId } = await fixture();
    const payload = {
      projectId,
      platform: 'tiktok',
      url: 'https://example.com/public/42',
      title: 'Démonstration result-first',
      views: 50_000,
      followers: 2_000,
      provenance: 'URL fournie par utilisateur',
    };
    const first = await app.inject({ method: 'POST', url: '/analytics/external', payload });
    const second = await app.inject({
      method: 'POST',
      url: '/analytics/external',
      payload: { ...payload, views: 55_000 },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    const listed = await app.inject({
      method: 'GET',
      url: `/analytics/external?projectId=${projectId}`,
    });
    const examples = (listed.json() as { examples: Array<{ views: number; provenance: string }> })
      .examples;
    expect(examples).toHaveLength(1);
    expect(examples[0]).toMatchObject({ views: 55_000, provenance: 'URL fournie par utilisateur' });
  });
});
