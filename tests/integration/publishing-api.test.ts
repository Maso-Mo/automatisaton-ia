import { afterEach, describe, expect, it } from 'vitest';
import { createEditorialStore } from '@aia/database';
import { PUBLISH_CONTENT_JOB, publishContentSpec } from '@aia/queue';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Les routes HTTP de l'étape 8 : le **déclencheur** « publier maintenant », la
 * lecture des publications et leur **décision humaine** (docs/05 §8.1, §8.3,
 * §8.4). La file est **observée** (`editorialQueue` injecté) : rien n'est exécuté,
 * on vérifie seulement ce que l'API enfile et avec quels refus.
 *
 * Ce que ces tests protègent, qu'aucun test unitaire ne voit :
 *
 * - un contenu **non approuvé** ne peut pas être publié (409) ;
 * - un compte d'un autre projet ou d'une autre plateforme est refusé (409) ;
 * - deux appels identiques produisent **une** publication et **un** job ;
 * - une décision humaine est le seul chemin qui sort une publication d'`ambiguous`.
 */

let created: TestContext[] = [];

afterEach(() => {
  for (const context of created) context.cleanup();
  created = [];
});

function makeApi() {
  const context = createTestContext();
  created.push(context);
  // La **vraie** file : la déduplication (`publish:<id>`) est ainsi vérifiée pour
  // de bon — un second appel ne crée pas un second job. L'API est un
  // **producteur** : elle enregistre la spécification, pas le handler.
  context.registry.registerSpec(publishContentSpec);
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    editorialQueue: context.queue,
  });
  return { api, app: buildServer(api), context };
}

function countJobs(context: TestContext, type: string): number {
  const row = context.handle.sqlite
    .prepare('select count(*) as c from jobs where type = ?')
    .get(type) as { c: number };
  return row.c;
}

async function createProject(app: ReturnType<typeof makeApi>['app']): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: { name: 'Publication API' },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { project: { id: string } }).project.id;
}

function seedApprovedContent(context: TestContext, projectId: string, approved: boolean): string {
  const store = createEditorialStore(context.handle, { nowMs: () => context.clock.nowMs() });
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
    versionNumber: store.nextVersionNumber(item.id),
    body: 'Texte approuvé à publier.',
    title: 'Titre',
    hook: 'Hook',
    hashtags: [],
    mentions: [],
    charCount: 20,
    wordCount: 4,
    readingTimeSec: 5,
    generation: 'initial',
    promptVersionHash: null,
    llmCallId: null,
    modelUsed: null,
    temperatureX100: null,
  });
  if (approved) {
    store.approveVersion(version.id, null);
    store.updateContentItem(item.id, {
      state: 'approved',
      currentVersionId: version.id,
      approvedVersionId: version.id,
      approvedAt: context.clock.nowMs(),
    });
  }
  return item.id;
}

async function createAccount(
  app: ReturnType<typeof makeApi>['app'],
  projectId: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/platform-accounts`,
    payload: { platform: 'linkedin', accountLabel: 'LinkedIn perso' },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { account: { id: string } }).account.id;
}

describe('API de publication (docs/10 §4.8)', () => {
  it('publie un contenu approuvé, crée une publication et n’enfile qu’un seul job', async () => {
    const { app, context } = makeApi();
    const projectId = await createProject(app);
    const contentId = seedApprovedContent(context, projectId, true);
    const accountId = await createAccount(app, projectId);

    const first = await app.inject({
      method: 'POST',
      url: `/content/${contentId}/publications`,
      payload: { platformAccountId: accountId },
    });
    expect(first.statusCode).toBe(202);
    const firstBody = first.json() as {
      publication: { id: string; status: string };
      created: boolean;
      jobId: string;
    };
    expect(firstBody.created).toBe(true);
    expect(firstBody.publication.status).toBe('planned');
    expect(countJobs(context, PUBLISH_CONTENT_JOB)).toBe(1);

    // Deuxième clic : même publication, même job (déduplication).
    const second = await app.inject({
      method: 'POST',
      url: `/content/${contentId}/publications`,
      payload: { platformAccountId: accountId },
    });
    const secondBody = second.json() as {
      publication: { id: string };
      created: boolean;
      jobId: string;
    };
    expect(second.statusCode).toBe(202);
    expect(secondBody.created).toBe(false);
    expect(secondBody.publication.id).toBe(firstBody.publication.id);
    expect(secondBody.jobId).toBe(firstBody.jobId);
    expect(countJobs(context, PUBLISH_CONTENT_JOB)).toBe(1);

    const list = await app.inject({ method: 'GET', url: `/content/${contentId}/publications` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { publications: unknown[] }).publications).toHaveLength(1);
  });

  it('refuse un contenu non approuvé et un compte d’un autre projet, avant toute mise en file', async () => {
    const { app, context } = makeApi();
    const projectId = await createProject(app);
    const draftContentId = seedApprovedContent(context, projectId, false);
    const accountId = await createAccount(app, projectId);

    const notApproved = await app.inject({
      method: 'POST',
      url: `/content/${draftContentId}/publications`,
      payload: { platformAccountId: accountId },
    });
    expect(notApproved.statusCode).toBe(409);
    expect((notApproved.json() as { error: { code: string } }).error.code).toBe(
      'PUBLICATION_REQUIRES_APPROVAL',
    );
    expect(countJobs(context, PUBLISH_CONTENT_JOB)).toBe(0);

    const approvedId = seedApprovedContent(context, projectId, true);
    const otherProject = await createProject(app);
    const otherAccount = await createAccount(app, otherProject);
    const mismatch = await app.inject({
      method: 'POST',
      url: `/content/${approvedId}/publications`,
      payload: { platformAccountId: otherAccount },
    });
    expect(mismatch.statusCode).toBe(409);
    expect((mismatch.json() as { error: { code: string } }).error.code).toBe(
      'PLATFORM_ACCOUNT_MISMATCH',
    );
  });

  it('tranche une ambiguïté humainement, et refuse une décision sans ambiguïté', async () => {
    const { app, api, context } = makeApi();
    const projectId = await createProject(app);
    const contentId = seedApprovedContent(context, projectId, true);
    const accountId = await createAccount(app, projectId);

    const created = await app.inject({
      method: 'POST',
      url: `/content/${contentId}/publications`,
      payload: { platformAccountId: accountId },
    });
    const publicationId = (created.json() as { publication: { id: string } }).publication.id;

    // L'ambiguïté est écrite par le worker ; ici on la pose directement.
    api.publishing.settlePublication(publicationId, {
      status: 'ambiguous',
      needsHumanDecision: true,
    });

    const decided = await app.inject({
      method: 'POST',
      url: `/publications/${publicationId}/decision`,
      payload: { decision: 'published', note: 'Vérifié manuellement.' },
    });
    expect(decided.statusCode).toBe(200);
    const body = decided.json() as {
      publication: { status: string; needsHumanDecision: boolean };
    };
    expect(body.publication.status).toBe('published');
    expect(body.publication.needsHumanDecision).toBe(false);

    // Une publication déjà tranchée n'attend plus de décision.
    const again = await app.inject({
      method: 'POST',
      url: `/publications/${publicationId}/decision`,
      payload: { decision: 'retry' },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: { code: string } }).error.code).toBe(
      'PUBLICATION_NO_DECISION_PENDING',
    );
  });

  it('« abandonner » annule la publication sans republier', async () => {
    const { app, api, context } = makeApi();
    const projectId = await createProject(app);
    const contentId = seedApprovedContent(context, projectId, true);
    const accountId = await createAccount(app, projectId);

    const created = await app.inject({
      method: 'POST',
      url: `/content/${contentId}/publications`,
      payload: { platformAccountId: accountId },
    });
    const publicationId = (created.json() as { publication: { id: string } }).publication.id;
    api.publishing.settlePublication(publicationId, {
      status: 'ambiguous',
      needsHumanDecision: true,
    });

    const abandoned = await app.inject({
      method: 'POST',
      url: `/publications/${publicationId}/decision`,
      payload: { decision: 'abandon' },
    });
    expect(abandoned.statusCode).toBe(200);
    expect((abandoned.json() as { publication: { status: string } }).publication.status).toBe(
      'cancelled',
    );
    expect(countJobs(context, PUBLISH_CONTENT_JOB)).toBe(1);
  });
});
