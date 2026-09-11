import {
  applyProposals,
  buildTurnContext,
  createConversation,
  currentBrief,
  getProject,
  ProjectNotReadyError,
  readStoredPlan,
  refreshProgress,
  updateMasterBrief,
  validateMasterBrief,
} from '@aia/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../support/harness';
import {
  USER_TURN,
  createConversationStack,
  defaultInterviewerOutput,
  scriptedInterviewer,
  type ConversationStack,
} from '../support/conversation';
import { generateMasterBrief, runConversationTurn } from '../../apps/api/src/features/conversation';

/**
 * Pipeline de conversation de bout en bout, sur une base SQLite **réelle** :
 * message utilisateur → propositions → acceptation → mémoire → fiche maître.
 *
 * Trois propriétés valent à elles seules ce fichier :
 *
 * 1. **aucun fait n'entre en mémoire sans approbation** (docs/05 §3.2) ;
 * 2. **le message utilisateur survit à un échec d'appel** (docs/05 §3.4) ;
 * 3. la fiche maître **ne se réécrit pas** : une correction crée une version
 *   (docs/03 §8.1).
 */

let context: TestContext;
let stack: ConversationStack;

beforeEach(() => {
  context = createTestContext();
  stack = createConversationStack(context, {
    interviewer: scriptedInterviewer([defaultInterviewerOutput()]),
  });
});

afterEach(() => {
  context.cleanup();
});

function factsCount(): number {
  return stack.memory.store.facts.list({ projectId: stack.projectId, includeInactive: true })
    .length;
}

describe('pipeline conversation (docs/05 §3)', () => {
  it('enregistre le tour, mais n’écrit **rien** en mémoire avant acceptation', async () => {
    const conversation = createConversation(stack.ports, stack.projectId);
    const before = factsCount();

    const turn = await runConversationTurn(stack.deps, conversation.id, { content: USER_TURN });

    expect(turn.userMessage.role).toBe('user');
    expect(turn.assistantMessage.role).toBe('assistant');
    expect(turn.plan.facts).toHaveLength(1);
    expect(turn.plan.facts[0]?.status).toBe('pending');
    expect(turn.assistantMessage.llmCallId).toBeNull();
    expect(factsCount()).toBe(before);
    // Le plan survit au rechargement : il est stocké dans le message assistant.
    expect(readStoredPlan(turn.assistantMessage).facts[0]?.id).toBe(turn.plan.facts[0]?.id);
  });

  it('accepte les propositions : faits, compétences, public et positionnement', async () => {
    const conversation = createConversation(stack.ports, stack.projectId);
    const turn = await runConversationTurn(stack.deps, conversation.id, { content: USER_TURN });
    const accepted = [
      ...turn.plan.facts.map((entry) => entry.id),
      ...turn.plan.skills.map((entry) => entry.id),
      ...turn.plan.audiences.map((entry) => entry.id),
      ...turn.plan.projectEdits.map((entry) => entry.id),
    ];

    const applied = applyProposals(stack.ports, conversation.id, turn.assistantMessage.id, {
      accept: accepted,
      confirmFacts: true,
    });

    expect(applied.facts).toHaveLength(1);
    expect(applied.facts[0]?.verificationStatus).toBe('verified');
    expect(applied.facts[0]?.source).toBe('conversation');
    expect(applied.facts[0]?.sourceMessageId).toBe(turn.userMessage.id);
    expect(applied.skills[0]?.skill).toBe('n8n');
    expect(applied.audiences[0]?.name).toBe('Indépendants débordés');
    expect(getProject(stack.memory, stack.projectId).positioning).toContain('facturation');
    expect(factsCount()).toBe(1);

    // Un second clic ne recrée rien : les propositions déjà acceptées portent
    // l'identifiant de ce qu'elles ont écrit.
    const again = applyProposals(stack.ports, conversation.id, turn.assistantMessage.id, {
      accept: accepted,
      confirmFacts: true,
    });
    expect(again.facts).toHaveLength(1);
    expect(factsCount()).toBe(1);
  });

  it('avance les lacunes et la phase à mesure que la mémoire se remplit', async () => {
    const conversation = createConversation(stack.ports, stack.projectId);
    expect(conversation.missingSlots).toContain('positioning');
    expect(conversation.stage).toBe('intake');

    const turn = await runConversationTurn(stack.deps, conversation.id, { content: USER_TURN });
    applyProposals(stack.ports, conversation.id, turn.assistantMessage.id, {
      accept: [
        ...turn.plan.projectEdits.map((entry) => entry.id),
        ...turn.plan.audiences.map((entry) => entry.id),
        ...turn.plan.skills.map((entry) => entry.id),
      ],
      confirmFacts: true,
    });
    applyProposals(stack.ports, conversation.id, turn.assistantMessage.id, {
      accept: turn.plan.facts.map((entry) => entry.id),
      confirmFacts: true,
    });

    const stored = stack.ports.store.conversations.byId(conversation.id)!;
    const refreshed = refreshProgress(stack.ports, stored);
    expect(refreshed.missingSlots).not.toContain('positioning');
    expect(refreshed.missingSlots).not.toContain('audience');
    // Il manque encore la voix et deux faits confirmés : la phase le dit.
    expect(refreshed.missingSlots).toContain('voice');
    expect(buildTurnContext(stack.ports, conversation.id).slot).toBe('voice');
  });

  it('conserve le message utilisateur quand l’appel échoue : réessayer ne coûte rien', async () => {
    const failing = createConversationStack(context, {
      interviewer: {
        name: 'interviewer',
        task: 'converse',
        promptFile: 'interviewer/converse.md',
        estimateTokens: () => ({ input: 1, output: 1 }),
        run: () => Promise.reject(new Error('panne du fournisseur')),
      },
    });
    const conversation = createConversation(failing.ports, failing.projectId);

    await expect(
      runConversationTurn(failing.deps, conversation.id, { content: USER_TURN }),
    ).rejects.toThrow('panne du fournisseur');

    const messages = failing.ports.store.messages.list(conversation.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toBe(USER_TURN);
  });
});

/** Accepte tout ce que le tour a proposé : l'entretien « bien rempli ». */
function acceptEverything(conversationId: string, messageId: string): void {
  const stored = stack.ports.store.messages.byId(messageId)!;
  const plan = readStoredPlan(stored);
  applyProposals(stack.ports, conversationId, messageId, {
    accept: [
      ...plan.facts.map((entry) => entry.id),
      ...plan.skills.map((entry) => entry.id),
      ...plan.audiences.map((entry) => entry.id),
      ...plan.projectEdits.map((entry) => entry.id),
    ],
    confirmFacts: true,
  });
}

describe('fiche maître de bout en bout (docs/03 §8.1)', () => {
  it('refuse de générer une fiche quand le positionnement ou le public manquent', async () => {
    const conversation = createConversation(stack.ports, stack.projectId);
    await expect(generateMasterBrief(stack.deps, conversation.id)).rejects.toBeInstanceOf(
      ProjectNotReadyError,
    );
  });

  it('génère un brouillon v1, le corrige en v2, puis le valide (jamais de réécriture)', async () => {
    const conversation = createConversation(stack.ports, stack.projectId);
    const turn = await runConversationTurn(stack.deps, conversation.id, { content: USER_TURN });
    acceptEverything(conversation.id, turn.assistantMessage.id);

    const first = await generateMasterBrief(stack.deps, conversation.id);
    expect(first.brief.version).toBe(1);
    expect(first.brief.status).toBe('draft');
    expect(currentBrief(stack.ports, stack.projectId)?.id).toBe(first.brief.id);

    // Corriger = créer une version, et **remplacer** l'ancienne explicitement.
    const second = updateMasterBrief(stack.ports, first.brief.id, {
      positioning: 'Automatiser et documenter la facturation',
    });
    expect(second.version).toBe(2);
    expect(stack.ports.store.briefs.byId(first.brief.id)?.status).toBe('superseded');
    expect(stack.ports.store.briefs.byId(first.brief.id)?.supersededById).toBe(second.id);
    expect(currentBrief(stack.ports, stack.projectId)?.id).toBe(second.id);

    const validated = validateMasterBrief(stack.ports, second.id);
    expect(validated.status).toBe('validated');
    expect(validated.validatedAt).not.toBeNull();
    // La fiche validée fait autorité sur le positionnement du projet.
    expect(getProject(stack.memory, stack.projectId).positioning).toBe(
      'Automatiser et documenter la facturation',
    );

    // **La base refuse** de modifier une fiche validée (docs/03 §15.1) : la règle
    // ne dépend pas de la discipline du code appelant.
    expect(() =>
      context.handle.sqlite
        .prepare('update master_briefs set summary = ? where id = ?')
        .run('réécriture silencieuse', second.id),
    ).toThrow(/brief_gele/);

    // Et un message ne se supprime jamais : la conversation reste auditable.
    expect(() =>
      context.handle.sqlite.prepare('delete from messages where id = ?').run(turn.userMessage.id),
    ).toThrow(/suppression_interdite/);
  });

  it('régénérer une fiche crée une nouvelle version, l’ancienne reste lisible', async () => {
    const conversation = createConversation(stack.ports, stack.projectId);
    const turn = await runConversationTurn(stack.deps, conversation.id, { content: USER_TURN });
    acceptEverything(conversation.id, turn.assistantMessage.id);

    const first = await generateMasterBrief(stack.deps, conversation.id);
    const second = await generateMasterBrief(stack.deps, conversation.id);

    expect(second.brief.version).toBe(2);
    const history = stack.ports.store.briefs.list(conversation.id);
    expect(history.map((brief) => brief.version)).toEqual([1, 2]);
    expect(history[0]?.status).toBe('superseded');
    expect(history[0]?.summary).toBe(first.brief.summary);
  });
});
