import { afterEach, describe, expect, it } from 'vitest';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import {
  defaultBriefOutput,
  defaultInterviewerOutput,
  scriptedInterviewer,
  scriptedStrategist,
  USER_TURN,
} from '../support/conversation';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * API de la conversation et de la fiche maître : la **vraie** instance Fastify,
 * sur une base SQLite réelle, avec un fournisseur scripté (aucun réseau).
 *
 * Ce que ces tests protègent et qu'aucun test unitaire ne protège : le contrat
 * HTTP (statuts, corps, erreurs typées) et l'ordre réel
 * `route → domaine → mémoire → base`.
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function makeApi() {
  context = createTestContext();
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    agents: {
      interviewer: () => ({
        agent: scriptedInterviewer([defaultInterviewerOutput()]),
        prompt: { promptVersionId: 'test', filePath: 'interviewer/converse.md' },
        lastCallId: () => null,
      }),
      strategist: () => ({
        agent: scriptedStrategist(defaultBriefOutput()),
        prompt: { promptVersionId: 'test-brief', filePath: 'strategist/master_brief.md' },
        lastCallId: () => null,
      }),
    },
  });
  return { api, app: buildServer(api), context: context as TestContext };
}

type App = ReturnType<typeof makeApi>['app'];

interface PlanBody {
  facts: Array<{ id: string }>;
  skills: Array<{ id: string }>;
  audiences: Array<{ id: string }>;
  projectEdits: Array<{ id: string }>;
}

async function createProject(app: App, name = 'Automatisation IA'): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/projects', payload: { name } });
  expect(response.statusCode).toBe(201);
  return (response.json() as { project: { id: string } }).project.id;
}

async function createConversation(app: App, projectId: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/conversations',
    payload: { projectId },
  });
  expect(response.statusCode).toBe(201);
  return (response.json() as { conversation: { id: string } }).conversation.id;
}

async function sendTurn(
  app: App,
  conversationId: string,
  content = USER_TURN,
): Promise<{ messageId: string; plan: PlanBody }> {
  const response = await app.inject({
    method: 'POST',
    url: `/conversations/${conversationId}/messages`,
    payload: { content },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { message: { id: string }; plan: PlanBody };
  return { messageId: body.message.id, plan: body.plan };
}

function allIds(plan: PlanBody): string[] {
  return [
    ...plan.facts.map((entry) => entry.id),
    ...plan.skills.map((entry) => entry.id),
    ...plan.audiences.map((entry) => entry.id),
    ...plan.projectEdits.map((entry) => entry.id),
  ];
}

describe('API de la conversation (docs/10 §4.2, docs/05 §3)', () => {
  it('annonce l’étape courante et ses points d’entrée', async () => {
    const { app } = makeApi();
    const body = (await app.inject({ method: 'GET', url: '/' })).json() as {
      step: string;
      endpoints: string[];
    };
    expect(body.step).toContain('étape 4');
    expect(body.endpoints).toContain('POST /conversations/:id/messages');
    expect(body.endpoints).toContain('POST /briefs/:briefId/validation');
    expect(body.endpoints).toContain('GET /events/conversations/:id');
  });

  it('crée un entretien, joue un tour et n’écrit rien sans acceptation', async () => {
    const { app } = makeApi();
    const projectId = await createProject(app);
    const conversationId = await createConversation(app, projectId);

    const before = (
      await app.inject({ method: 'GET', url: `/conversations/${conversationId}` })
    ).json() as {
      conversation: { missingSlots: string[] };
      nextSlot: string | null;
      slotLabels: Record<string, string>;
    };
    expect(before.conversation.missingSlots).toContain('positioning');
    expect(before.nextSlot).toBe('skills');
    expect(before.slotLabels['skills']).toBeTruthy();

    const countFacts = async (): Promise<number> =>
      (
        (await app.inject({ method: 'GET', url: `/projects/${projectId}/facts` })).json() as {
          facts: unknown[];
        }
      ).facts.length;

    expect(await countFacts()).toBe(0);
    const { messageId, plan } = await sendTurn(app, conversationId);
    expect(plan.facts).toHaveLength(1);
    // Le tour a produit une **proposition** : la mémoire du projet est intacte.
    expect(await countFacts()).toBe(0);

    const accepted = await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages/${messageId}/proposals`,
      payload: { accept: allIds(plan), confirmFacts: true },
    });
    expect(accepted.statusCode).toBe(200);
    const applied = accepted.json() as {
      facts: Array<{ verificationStatus: string; source: string }>;
      conversation: { missingSlots: string[] };
    };
    expect(applied.facts[0]?.verificationStatus).toBe('verified');
    expect(applied.facts[0]?.source).toBe('conversation');
    expect(applied.conversation.missingSlots).not.toContain('positioning');
    expect(await countFacts()).toBe(1);
  });

  it('refuse une entrée invalide et un entretien inconnu avec des erreurs typées', async () => {
    const { app } = makeApi();
    const projectId = await createProject(app);

    const invalid = await app.inject({
      method: 'POST',
      url: '/conversations',
      payload: { projectId: '' },
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: { category: string } }).error.category).toBe('validation');

    const missing = await app.inject({ method: 'GET', url: '/conversations/inconnu' });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe(
      'CONVERSATION_NOT_FOUND',
    );

    const empty = await app.inject({
      method: 'POST',
      url: `/conversations/${await createConversation(app, projectId)}/messages`,
      payload: { content: '' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('refuse une fiche maître tant que le positionnement et le public manquent', async () => {
    const { app } = makeApi();
    const projectId = await createProject(app);
    const conversationId = await createConversation(app, projectId);

    const refused = await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/brief`,
    });
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as { error: { code: string } }).error.code).toBe('PROJECT_NOT_READY');
  });

  it('génère, corrige puis valide la fiche maître — et l’expose au projet', async () => {
    const { app } = makeApi();
    const projectId = await createProject(app);
    const conversationId = await createConversation(app, projectId);
    const { messageId, plan } = await sendTurn(app, conversationId);

    await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/messages/${messageId}/proposals`,
      payload: { accept: allIds(plan), confirmFacts: true },
    });

    const generated = await app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/brief`,
    });
    expect(generated.statusCode).toBe(201);
    const brief = (generated.json() as { brief: { id: string; version: number; status: string } })
      .brief;
    expect(brief.version).toBe(1);
    expect(brief.status).toBe('draft');

    const corrected = await app.inject({
      method: 'PATCH',
      url: `/briefs/${brief.id}`,
      payload: { targetAudience: 'Indépendants en solo, plutôt débutants' },
    });
    expect(corrected.statusCode).toBe(201);
    const v2 = (corrected.json() as { brief: { id: string; version: number } }).brief;
    expect(v2.version).toBe(2);

    const validated = await app.inject({ method: 'POST', url: `/briefs/${v2.id}/validation` });
    expect(validated.statusCode).toBe(200);
    expect(
      (validated.json() as { brief: { status: string; validatedAt: number | null } }).brief.status,
    ).toBe('validated');

    const projectBrief = await app.inject({ method: 'GET', url: `/projects/${projectId}/brief` });
    expect((projectBrief.json() as { brief: { id: string } }).brief.id).toBe(v2.id);

    const history = (await app.inject({ method: 'GET', url: `/briefs/${brief.id}` })).json() as {
      history: Array<{ version: number; status: string }>;
    };
    expect(history.history.map((item) => item.version)).toEqual([1, 2]);
    expect(history.history[0]?.status).toBe('superseded');
  });
});
