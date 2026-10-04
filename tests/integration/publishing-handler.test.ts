import { afterEach, describe, expect, it } from 'vitest';
import { createProject } from '@aia/core';
import {
  createEditorialStore,
  createProjectMemoryStore,
  createPublishingStore,
} from '@aia/database';
import {
  createSimulatedConnector,
  type SimulatedPublishBehaviour,
  type SimulatedVerification,
} from '@aia/publishing';
import { PUBLISH_CONTENT_JOB, type JobContext, type JobEventInput } from '@aia/queue';
import { uuidv7 } from '@aia/shared';
import {
  createPublishContentHandler,
  type PublicationContentSource,
} from '../../apps/worker/src/handlers/publish-content';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Le handler `publish_content` (étape 8), exercé avec le **connecteur simulé** au
 * lieu d'un appel réseau (docs/06 §11.3). C'est le seul moyen d'éprouver le cas le
 * plus dangereux du produit — *l'envoi dont on ne connaît pas l'issue* — sans
 * publier quoi que ce soit, et de compter les publications **réellement** émises.
 *
 * Ce que ce fichier protège, dans l'ordre où ça compte :
 *
 * 1. **aucun doublon après une reprise forcée** : le critère de sortie n° 1 de
 *    l'étape 8 (docs/10 §4.8). Le connecteur simulé **compte** ses posts ; un
 *    second passage ne doit pas en ajouter ;
 * 2. **une ambiguïté se vérifie, ne se rejoue pas** : `timeout_after_send` →
 *    `verifyPublished` → publié si retrouvé, décision humaine sinon ;
 * 3. **un dépassement de budget retient** la publication (reprogrammée), au lieu
 *    de la détruire (docs/11 §2.7) ;
 * 4. **chaque issue de la table de décision** (docs/06 §9.1) produit l'état
 *    attendu : refus → `failed`, 429 → reporté, niveau B → brouillon.
 */

interface Bench {
  context: TestContext;
  publications: ReturnType<typeof createPublishingStore>;
  publicationId: string;
  connector: ReturnType<typeof createSimulatedConnector>;
  events: JobEventInput[];
  reschedules: Array<{ publicationId: string; delayMs: number; reason: string }>;
  settled: Array<{ publicationId: string; outcome: string }>;
  accountStates: Array<{ accountId: string; state: string }>;
  run(): Promise<{ outcome: string; reason: string; remoteId?: string }>;
}

let created: TestContext[] = [];

afterEach(() => {
  for (const context of created) context.cleanup();
  created = [];
});

/** Un contenu **approuvé** : la version gelée que la publication doit employer. */
function seedApprovedContent(
  context: TestContext,
  projectId: string,
): { itemId: string; versionId: string } {
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
    body: 'Voici comment j’automatise ma facturation, étape par étape.',
    title: 'Automatiser sa facturation',
    hook: 'Trois étapes, dix minutes.',
    hashtags: ['#automatisation'],
    mentions: [],
    charCount: 60,
    wordCount: 10,
    readingTimeSec: 15,
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
    approvedAt: context.clock.nowMs(),
  });
  return { itemId: item.id, versionId: version.id };
}

function makeBench(
  options: {
    behaviour?: SimulatedPublishBehaviour;
    verification?: SimulatedVerification;
    level?: 'A' | 'B';
    budgetHeld?: boolean;
  } = {},
): Bench {
  const context = createTestContext();
  created.push(context);

  const memoryStore = createProjectMemoryStore(context.handle, {
    nowMs: () => context.clock.nowMs(),
  });
  const project = createProject(
    { store: memoryStore, clock: context.clock, newId: () => uuidv7(context.clock.nowMs()) },
    { name: 'Publication par API' },
  );

  const editorial = createEditorialStore(context.handle, { nowMs: () => context.clock.nowMs() });
  const { itemId, versionId } = seedApprovedContent(context, project.id);

  const publications = createPublishingStore(context.handle, () => context.clock.nowMs());
  const account = publications.createAccount({
    projectId: project.id,
    platform: 'linkedin',
    accountLabel: 'LinkedIn perso',
    remoteAccountId: 'urn:li:person:12345',
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    capabilities: { level: options.level ?? 'A', directPublish: options.level !== 'B' },
  });
  const { publication } = publications.ensurePublication({
    projectId: project.id,
    contentItemId: itemId,
    contentVersionId: versionId,
    platformAccountId: account.id,
    platform: 'linkedin',
    idempotencyKey: 'idem-test-1',
  });

  const connector = createSimulatedConnector({
    platform: 'linkedin',
    level: options.level ?? 'A',
    ...(options.behaviour ? { behaviour: options.behaviour } : {}),
    ...(options.verification ? { verification: options.verification } : {}),
  });

  const content: PublicationContentSource = {
    item: (id) => {
      const found = editorial.getContentItem(id);
      return found
        ? {
            id: found.id,
            projectId: found.projectId,
            platform: found.platform,
            target: found.target,
            state: found.state,
            approvedVersionId: found.approvedVersionId,
          }
        : null;
    },
    version: (id) => {
      const found = editorial.getVersion(id);
      return found
        ? {
            id: found.id,
            body: found.body,
            title: found.title,
            hook: found.hook,
            hashtags: found.hashtags,
            mentions: found.mentions,
            mediaAssetIds: found.mediaAssetIds,
            approvedAt: found.approvedAt,
          }
        : null;
    },
  };

  const reschedules: Bench['reschedules'] = [];
  const settled: Bench['settled'] = [];
  const accountStates: Bench['accountStates'] = [];

  const handler = createPublishContentHandler({
    publications,
    content,
    // Le niveau est décidé **avant** l'appel (docs/10 §4.8) : ici, le banc le
    // fixe plutôt que de dérouler le parcours de capacités.
    resolveConnector: () => ({ level: options.level ?? 'A', connector, reason: 'banc de test' }),
    budgetBrake: () =>
      options.budgetHeld
        ? { held: true, allowed: false, reason: 'Budget journalier atteint : test.', evaluated: 1 }
        : { held: false, allowed: true, evaluated: 1 },
    reschedule: async (input) => {
      reschedules.push(input);
    },
    onSettled: (publicationId, outcome) => {
      settled.push({ publicationId, outcome });
    },
    onAccountState: (input) => {
      accountStates.push({ accountId: input.accountId, state: input.state });
    },
    estimatedCostMicroUsd: 0,
    clock: context.clock,
    logger: context.logger,
  });

  const events: JobEventInput[] = [];
  const jobContext: JobContext = {
    jobId: 'job-publish-1',
    type: PUBLISH_CONTENT_JOB,
    attempt: 1,
    workerId: 'worker-publish-test',
    signal: new AbortController().signal,
    emitEvent: async (event) => {
      events.push(event);
    },
    setStep: async () => undefined,
    recordCost: async () => undefined,
    logger: context.logger,
  };

  return {
    context,
    publications,
    publicationId: publication.id,
    connector,
    events,
    reschedules,
    settled,
    accountStates,
    run: () =>
      handler.handler({ publicationId: publication.id }, jobContext) as Promise<{
        outcome: string;
        reason: string;
        remoteId?: string;
      }>,
  };
}

describe('publish_content — publication idempotente', () => {
  it('publie une fois, règle la publication en « published » et n’appelle la plateforme qu’une fois', async () => {
    const bench = makeBench({ behaviour: 'success' });

    const result = await bench.run();

    expect(result.outcome).toBe('published');
    expect(result.remoteId).toBeDefined();
    expect(bench.connector.remotePosts).toHaveLength(1);
    expect(bench.publications.getPublication(bench.publicationId)?.status).toBe('published');
    expect(bench.settled).toEqual([{ publicationId: bench.publicationId, outcome: 'published' }]);
  });

  it('ne republie pas sur une reprise forcée : l’état tranché interdit tout nouvel appel distant', async () => {
    const bench = makeBench({ behaviour: 'success' });

    await bench.run();
    const second = await bench.run();

    expect(second.outcome).toBe('skipped');
    // **Le cœur du critère de sortie n° 1** : une seconde exécution n’émet rien.
    expect(bench.connector.remotePosts).toHaveLength(1);
    expect(bench.connector.publishCalls).toHaveLength(1);
  });
});

describe('publish_content — le cas ambigu', () => {
  it('vérifie auprès de la plateforme et règle « published » si le contenu est retrouvé', async () => {
    const bench = makeBench({ behaviour: 'timeout_after_send', verification: 'found' });

    const result = await bench.run();

    expect(result.outcome).toBe('published');
    expect(bench.publications.getPublication(bench.publicationId)?.status).toBe('published');
    expect(bench.connector.remotePosts).toHaveLength(1);
  });

  it('ne devine pas quand la plateforme ne sait pas répondre : décision humaine, aucun doublon', async () => {
    const bench = makeBench({ behaviour: 'timeout_after_send', verification: 'unsupported' });

    const result = await bench.run();

    expect(result.outcome).toBe('ambiguous');
    const stored = bench.publications.getPublication(bench.publicationId);
    expect(stored?.status).toBe('ambiguous');
    expect(stored?.needsHumanDecision).toBe(true);

    // Une reprise forcée retrouve une publication marquée « décision humaine » :
    // elle ne repose pas la question à la plateforme.
    const second = await bench.run();
    expect(second.outcome).toBe('skipped');
    expect(bench.connector.remotePosts).toHaveLength(1);
  });

  it('reprogramme (sans publier) quand la vérification confirme que le contenu n’est PAS en ligne', async () => {
    const bench = makeBench({ behaviour: 'timeout_after_send', verification: 'not_found' });

    const result = await bench.run();

    expect(result.outcome).toBe('postponed');
    expect(bench.publications.getPublication(bench.publicationId)?.status).toBe('planned');
    expect(bench.reschedules).toHaveLength(1);
  });
});

describe('publish_content — budget, refus et report', () => {
  it('retient la publication quand le budget est atteint, au lieu de la détruire', async () => {
    const bench = makeBench({ behaviour: 'success', budgetHeld: true });

    const result = await bench.run();

    expect(result.outcome).toBe('held');
    expect(bench.publications.getPublication(bench.publicationId)?.status).toBe('planned');
    expect(bench.reschedules).toHaveLength(1);
    // **Aucun appel distant** : le budget est opposable *avant* l’envoi.
    expect(bench.connector.publishCalls).toHaveLength(0);
  });

  it('marque la publication « failed » et explique le refus de la plateforme', async () => {
    const bench = makeBench({ behaviour: 'rejected' });

    const result = await bench.run();

    expect(result.outcome).toBe('failed');
    const stored = bench.publications.getPublication(bench.publicationId);
    expect(stored?.status).toBe('failed');
    expect(stored?.decisionNote).toContain('refusé');
  });

  it('reporte un 429 et marque le compte en « rate_limited »', async () => {
    const bench = makeBench({ behaviour: 'rate_limited' });

    const result = await bench.run();

    expect(result.outcome).toBe('postponed');
    expect(bench.accountStates).toEqual([{ accountId: expect.any(String), state: 'rate_limited' }]);
    expect(bench.reschedules).toHaveLength(1);
    expect(bench.publications.getPublication(bench.publicationId)?.status).toBe('planned');
  });
});

describe('publish_content — niveau B', () => {
  it('crée un brouillon distant et laisse la publication finale à l’humain', async () => {
    const bench = makeBench({ behaviour: 'success', level: 'B' });

    const result = await bench.run();

    expect(result.outcome).toBe('draft_created');
    expect(bench.publications.getPublication(bench.publicationId)?.status).toBe('manual_required');
    expect(bench.connector.remotePosts).toHaveLength(1);
    expect(bench.connector.remotePosts[0]?.lifecycle).toBe('DRAFT');
  });
});
