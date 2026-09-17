import { applyProposals, createConversation, readStoredPlan, validateMasterBrief } from '@aia/core';
import type { EditorialPlanOutput } from '@aia/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { generateMasterBrief, runConversationTurn } from '../../apps/api/src/features/conversation';
import {
  USER_TURN,
  createConversationStack,
  defaultBriefOutput,
  defaultInterviewerOutput,
  scriptedInterviewer,
  scriptedStrategist,
  type ConversationStack,
} from '../support/conversation';
import {
  createEditorialStack,
  defaultDrafts,
  defaultPlanOutput,
  singleDraft,
  type EditorialStack,
} from '../support/editorial';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * L'étape 4 de bout en bout : la **vraie** API, la **vraie** file, le **vrai**
 * handler de worker, sur une base SQLite réelle. Seul le modèle est scripté
 * (docs/09 §1.1) — et c'est bien ce qu'on veut vérifier : rien de ce que ces
 * tests affirment ne dépend de la qualité du modèle.
 *
 * Ce que ce fichier protège, et qu'aucun test unitaire ne protège :
 *
 * 1. **l'API ne rédige pas** : après le `202`, les lignes de contenu existent
 *    mais **aucune version** n'est écrite. Le texte n'apparaît qu'après un tour
 *    de worker (docs/02 §5) ;
 * 2. **un appel, quatre plateformes** : le lot de quatre cibles coûte **un**
 *    appel au modèle, et chaque cible a sa version, ses limites et ses notes
 *    (docs/05 §4.3) ;
 * 3. **régénérer n'écrase pas**, et **approuver ne couvre que le texte approuvé**
 *    (docs/05 §4.4, §4.6) ;
 * 4. le chemin réel `route → domaine → file → job → domaine → base` laisse des
 *    traces : `llm_calls` avec le contexte, `content_versions` avec le modèle,
 *    l'appel et la version de prompt.
 */

let openContext: TestContext | null = null;

afterEach(() => {
  openContext?.cleanup();
  openContext = null;
});

interface Bench {
  context: TestContext;
  conversation: ConversationStack;
  editorial: EditorialStack;
  app: ReturnType<typeof buildServer>;
  projectId: string;
}

/** Les quatre cibles du critère de sortie : un lot, un appel (docs/05 §4.3). */
const BATCH = ['linkedin_post', 'reddit_post', 'tiktok_short', 'youtube_short'] as const;

async function makeBench(
  options: { approveBrief?: boolean; plan?: EditorialPlanOutput } = {},
): Promise<Bench> {
  const context = createTestContext();
  openContext = context;

  // --- L'étape 3 d'abord : une fiche maître validée, sinon rien ne se génère ---
  const conversation = createConversationStack(context, {
    interviewer: scriptedInterviewer([defaultInterviewerOutput()]),
    strategist: scriptedStrategist(defaultBriefOutput()),
  });
  const projectId = conversation.projectId;

  const talk = createConversation(conversation.ports, projectId);
  const turn = await runConversationTurn(conversation.deps, talk.id, { content: USER_TURN });
  acceptEverything(conversation, talk.id, turn.assistantMessage.id);
  const brief = await generateMasterBrief(conversation.deps, talk.id);
  if (options.approveBrief ?? true) {
    validateMasterBrief(conversation.ports, brief.brief.id);
  }

  // --- L'étape 4 : la file du worker, l'agent de plan, puis l'API qui écrit ---
  const editorial = createEditorialStack(context, {
    drafts: [defaultDrafts(), singleDraft('linkedin_post')],
    ...(options.plan ? { plan: options.plan } : {}),
  });

  const app = buildServer(
    buildApi({
      config: context.config,
      logger: context.logger,
      clock: context.clock,
      agents: {
        interviewer: () => ({
          agent: scriptedInterviewer([defaultInterviewerOutput()]),
          prompt: { promptVersionId: 'test-interviewer', filePath: 'interviewer/converse.md' },
          lastCallId: () => null,
        }),
        strategist: () => ({
          agent: scriptedStrategist(defaultBriefOutput()),
          prompt: { promptVersionId: 'test-brief', filePath: 'strategist/master_brief.md' },
          lastCallId: () => null,
        }),
      },
      editorialAgents: editorial.agents,
      // La **même** file que le worker : ce que l'API enfile, le worker le
      // réserve. Deux files sur la même base marcheraient aussi, mais ce n'est
      // pas le chemin de production.
      editorialQueue: editorial.queue,
    }),
  );

  return { context, conversation, editorial, app, projectId };
}

/**
 * Accepte **tout** ce que le tour a proposé : l'entretien « bien rempli » qui
 * donne à l'étape 4 une fiche maître validée et des faits ancrables.
 */
function acceptEverything(
  conversation: ConversationStack,
  conversationId: string,
  messageId: string,
): void {
  const stored = conversation.ports.store.messages.byId(messageId)!;
  const plan = readStoredPlan(stored);
  applyProposals(conversation.ports, conversationId, messageId, {
    accept: [
      ...plan.facts.map((entry) => entry.id),
      ...plan.skills.map((entry) => entry.id),
      ...plan.audiences.map((entry) => entry.id),
      ...plan.projectEdits.map((entry) => entry.id),
    ],
    confirmFacts: true,
  });
}

interface PlanBody {
  subjects: Array<{ id: string; title: string; status: string }>;
  angles: Array<{ id: string; subjectId: string; status: string; hook: string }>;
  accepted: number;
  rejected: Array<{ title: string; reasons: string[] }>;
  droppedAngles: number;
  usage: { costMicroUsd: number };
}

interface ContentPayload {
  item: {
    id: string;
    target: string;
    state: string;
    aiGenerated: boolean;
    currentVersionId: string | null;
    approvedVersionId: string | null;
    regeneratedCount: number;
  };
  version: {
    versionNumber: number;
    body: string;
    hook: string | null;
    title: string | null;
    hashtags: string[];
    llmCallId: string | null;
    modelUsed: string | null;
    promptVersionHash: string | null;
  } | null;
  notes: Array<{ author: string; noteType: string; message: string }>;
}

interface ContentBody {
  content: ContentPayload;
  history: { versions: Array<{ versionNumber: number; body: string }> };
  validation: {
    ok: boolean;
    blocking: Array<{ code: string }>;
    warnings: Array<{ code: string }>;
  } | null;
}

function jobRow(b: Bench, jobId: string) {
  const row = b.context.handle.sqlite
    .prepare('select type, status, cost_micro_usd, input_json from jobs where id = ?')
    .get(jobId) as { type: string; status: string; cost_micro_usd: number; input_json: string };
  return {
    type: row.type,
    status: row.status,
    costMicroUsd: row.cost_micro_usd,
    payload: JSON.parse(row.input_json) as {
      projectId: string;
      angleId: string;
      targets: string[];
      mode: string;
      contentItemId: string | null;
    },
  };
}

function llmCallsOf(b: Bench, jobId: string) {
  return b.context.handle.sqlite
    .prepare(
      'select agent, task, model, prompt_version_id, context_fingerprint, cost_micro_usd, content_item_id from llm_calls where job_id = ?',
    )
    .all(jobId) as Array<{
    agent: string | null;
    task: string;
    model: string;
    prompt_version_id: string | null;
    context_fingerprint: string | null;
    cost_micro_usd: number;
    content_item_id: string | null;
  }>;
}

function claimsCount(b: Bench): number {
  const row = b.context.handle.sqlite.prepare('select count(*) as n from content_claims').get() as {
    n: number;
  };
  return row.n;
}

/** `GET /content/:id` : l'écran de relecture n'a qu'un appel à faire. */
async function readContent(b: Bench, contentId: string): Promise<ContentBody> {
  const response = await b.app.inject({ method: 'GET', url: `/content/${contentId}` });
  expect(response.statusCode).toBe(200);
  return response.json() as ContentBody;
}

/** Le plan, puis la sélection du premier angle : le geste de l'utilisateur. */
async function pickAngle(b: Bench): Promise<string> {
  const created = await b.app.inject({ method: 'POST', url: `/projects/${b.projectId}/plan` });
  expect(created.statusCode).toBe(201);
  const angle = (created.json() as PlanBody).angles[0]!;

  const selected = await b.app.inject({
    method: 'POST',
    url: `/angles/${angle.id}/select`,
    payload: {},
  });
  expect(selected.statusCode).toBe(200);
  return angle.id;
}

describe('API éditoriale et génération de contenus (docs/10 §4.3, docs/05 §4)', () => {
  it('annonce l’étape courante et les points d’entrée éditoriaux', async () => {
    const context = createTestContext();
    openContext = context;
    const app = buildServer(
      buildApi({ config: context.config, logger: context.logger, clock: context.clock }),
    );

    const body = (await app.inject({ method: 'GET', url: '/' })).json() as {
      step: string;
      endpoints: string[];
    };
    expect(body.step).toContain('étape 4');
    expect(body.endpoints).toContain('POST /projects/:id/plan');
    expect(body.endpoints).toContain('POST /projects/:id/content');
    expect(body.endpoints).toContain('POST /content/:contentId/regenerate');
    expect(body.endpoints).toContain('POST /content/:contentId/approve');
  });

  it('refuse de planifier tant que la fiche maître n’est pas validée', async () => {
    const b = await makeBench({ approveBrief: false });

    const response = await b.app.inject({
      method: 'POST',
      url: `/projects/${b.projectId}/plan`,
    });

    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('BRIEF_NOT_APPROVED');
  });

  it('n’enregistre que les sujets dont l’ancrage est vérifiable', async () => {
    const plan = defaultPlanOutput();
    // Un sujet qui invente ses sources, et un angle qui fait de même.
    plan.subjects[2]!.evidence = ['je gère 400 clients'];
    plan.subjects[0]!.angles[1]!.evidence = ['un chiffre sorti de nulle part'];
    const b = await makeBench({ plan });

    const response = await b.app.inject({ method: 'POST', url: `/projects/${b.projectId}/plan` });
    expect(response.statusCode).toBe(201);
    const body = response.json() as PlanBody;

    expect(body.accepted).toBe(2);
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0]!.reasons.join(' ')).toContain('400 clients');
    // L'angle non ancré est **écarté**, pas publié en silence.
    expect(body.droppedAngles).toBe(1);
    expect(b.editorial.writerCallCount()).toBe(0);

    const stored = await b.app.inject({
      method: 'GET',
      url: `/projects/${b.projectId}/subjects`,
    });
    const subjects = (stored.json() as { subjects: Array<{ angles: unknown[] }> }).subjects;
    expect(subjects).toHaveLength(2);
    expect(subjects[0]!.angles).toHaveLength(1);
    expect(JSON.stringify(subjects)).not.toContain('400 clients');
  });

  it('un lot de quatre plateformes : un appel, quatre versions, rien avant le worker', async () => {
    const b = await makeBench();
    const angleId = await pickAngle(b);

    const created = await b.app.inject({
      method: 'POST',
      url: `/projects/${b.projectId}/content`,
      payload: { angleId, targets: [...BATCH] },
    });
    expect(created.statusCode).toBe(202);
    const body = created.json() as { content: ContentPayload[]; jobId: string };
    expect(body.content).toHaveLength(BATCH.length);

    // Les **lignes** existent, les **textes** non : l'API n'exécute rien.
    for (const entry of body.content) {
      expect(entry.item.currentVersionId).toBeNull();
      expect(entry.version).toBeNull();
    }

    const before = jobRow(b, body.jobId);
    expect(before.type).toBe('generate_content');
    expect(before.payload.mode).toBe('initial');
    expect([...before.payload.targets].sort()).toEqual([...BATCH].sort());

    // Un tour de worker : **un** appel au modèle pour les quatre cibles.
    expect(await b.editorial.loop.runOnce()).toBe(1);
    expect(b.editorial.writerCallCount()).toBe(1);

    const after = jobRow(b, body.jobId);
    expect(after.status).toBe('completed');
    expect(after.costMicroUsd).toBeGreaterThan(0);

    const calls = llmCallsOf(b, body.jobId);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.task).toBe('drafts');
    expect(calls[0]?.agent).toBe('platform_writer');
    expect(calls[0]?.model).toBe('deepseek-chat');
    expect(calls[0]?.prompt_version_id).toBeTruthy();
    expect(calls[0]?.context_fingerprint).toBeTruthy();

    const linkedin = body.content.find((entry) => entry.item.target === 'linkedin_post')!;
    const read = await readContent(b, linkedin.item.id);
    expect(read.content.item.state).toBe('generated');
    // Marquage IA : le contenu dit qu'il a été rédigé par un modèle (docs/07 §11.2).
    expect(read.content.item.aiGenerated).toBe(true);
    // Traçabilité : la version sait de quel appel, de quel modèle et de quel
    // prompt elle vient — sans quoi un texte publié ne serait pas auditable.
    expect(read.content.version?.llmCallId).toBeTruthy();
    expect(read.content.version?.modelUsed).toBe('deepseek-chat');
    expect(read.content.version?.promptVersionHash).toBeTruthy();
    // Le contrôle local est **recalculé à la lecture**, et il passe.
    expect(read.validation?.ok).toBe(true);
    expect(read.validation?.blocking).toEqual([]);

    const reddit = body.content.find((entry) => entry.item.target === 'reddit_post')!;
    const redditRead = await readContent(b, reddit.item.id);
    // Reddit : zéro mot-dièse (limite de la plateforme) et la note
    // opérationnelle est visible à côté du texte, jamais perdue dans un log.
    expect(redditRead.content.version?.hashtags).toEqual([]);
    expect(redditRead.content.version?.title).toBeTruthy();
    expect(redditRead.content.notes.map((note) => note.message)).toContain(
      'Subreddit choisi par l’utilisateur',
    );

    // Aucune affirmation n'est « vérifiée » à cette étape : la table est vide,
    // et c'est une propriété du produit (docs/05 §4.3).
    expect(claimsCount(b)).toBe(0);
  });

  it('régénérer n’écrase pas, et approuver ne couvre que le texte approuvé', async () => {
    const b = await makeBench();
    const angleId = await pickAngle(b);

    const created = await b.app.inject({
      method: 'POST',
      url: `/projects/${b.projectId}/content`,
      payload: { angleId, targets: ['linkedin_post'] },
    });
    const contentId = (created.json() as { content: ContentPayload[] }).content[0]!.item.id;
    expect(await b.editorial.loop.runOnce()).toBe(1);

    const first = await readContent(b, contentId);
    expect(first.content.version?.versionNumber).toBe(1);
    expect(first.content.item.state).toBe('generated');

    // `generated → approved` n'existe **pas** dans la machine à états : un
    // contenu ne s'approuve pas sans être passé par l'écran de relecture
    // (docs/05 §4.3, docs/03 §9.1).
    const skipped = await b.app.inject({
      method: 'POST',
      url: `/content/${contentId}/approve`,
      payload: {},
    });
    expect(skipped.statusCode).toBe(409);

    const review = await b.app.inject({ method: 'POST', url: `/content/${contentId}/review` });
    expect(review.statusCode).toBe(200);

    const approved = await b.app.inject({
      method: 'POST',
      url: `/content/${contentId}/approve`,
      payload: {},
    });
    expect(approved.statusCode).toBe(200);
    const approvedBody = approved.json() as { content: ContentPayload };
    expect(approvedBody.content.item.state).toBe('approved');
    expect(approvedBody.content.item.approvedVersionId).toBeTruthy();

    const regeneration = await b.app.inject({
      method: 'POST',
      url: `/content/${contentId}/regenerate`,
      payload: { instruction: 'Moins de jargon, un exemple concret.' },
    });
    expect(regeneration.statusCode).toBe(202);
    const job = jobRow(b, (regeneration.json() as { jobId: string }).jobId);
    // Le job ne porte **qu'une** cible : celle du contenu désigné, et il sait
    // quel contenu il réécrit (docs/05 §4.4).
    expect(job.payload.mode).toBe('regenerated');
    expect(job.payload.targets).toEqual(['linkedin_post']);
    expect(job.payload.contentItemId).toBe(contentId);

    expect(await b.editorial.loop.runOnce()).toBe(1);

    const second = await readContent(b, contentId);
    expect(second.history.versions.map((entry) => entry.versionNumber)).toEqual([1, 2]);
    expect(second.content.version?.versionNumber).toBe(2);
    // L'ancienne version reste lisible **entière** : rien n'a été écrasé.
    expect(second.history.versions[0]?.body).toBe(first.content.version?.body);
    expect(second.content.item.regeneratedCount).toBe(1);
    // Un nouveau texte n'est plus le texte approuvé : retour en relecture.
    expect(second.content.item.state).toBe('in_review');
    expect(second.content.item.approvedVersionId).toBeNull();
  });

  it('le rejet est une décision tracée, pas une suppression', async () => {
    const b = await makeBench();
    const angleId = await pickAngle(b);
    const created = await b.app.inject({
      method: 'POST',
      url: `/projects/${b.projectId}/content`,
      payload: { angleId, targets: ['tiktok_short'] },
    });
    const contentId = (created.json() as { content: ContentPayload[] }).content[0]!.item.id;
    expect(await b.editorial.loop.runOnce()).toBe(1);

    const rejected = await b.app.inject({
      method: 'POST',
      url: `/content/${contentId}/reject`,
      payload: { reason: 'Trop générique pour mon audience.' },
    });
    expect(rejected.statusCode).toBe(200);
    const body = rejected.json() as { content: ContentPayload };
    expect(body.content.item.state).toBe('archived');
    // Le motif est conservé : un rejet sans raison ne s'apprend pas (docs/05 §4.1).
    const decision = body.content.notes.find((note) => note.noteType === 'decision');
    expect(decision?.message).toContain('Trop générique');
    expect(decision?.author).toBe('user');
  });
});
