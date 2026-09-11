import { createManualClock, type Clock, type InterviewerOutput } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import type { ProjectMemoryStore } from '../projects/types';
import {
  applyEditPlan,
  isQuoteGrounded,
  normalizeQuote,
  pendingProposalCount,
  planFromInterviewerOutput,
} from './edit-plan';
import {
  buildBriefRecord,
  briefGaps,
  nextBriefVersion,
  planBriefSupersession,
  planBriefValidation,
} from './master-brief';
import type { Conversation, ConversationPorts, MasterBrief } from './types';

/**
 * Règles de la conversation, testées **sans base ni modèle** : la citation qui
 * fonde une proposition, l'immutabilité de la fiche maître, la création d'une
 * version. Ce sont les invariants qui rendent la mémoire fiable.
 */

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);
const USER_MESSAGE = 'J’ai automatisé 12 factures avec n8n, je code en TypeScript.';

function ports(): ConversationPorts {
  let counter = 0;
  const clock: Clock = createManualClock(NOW);
  const project = {
    id: 'p1',
    ownerId: 'owner-1',
    name: 'Projet',
    slug: 'projet',
    positioning: null,
    status: 'discovery',
    targetGoal: null,
    startDate: NOW,
    timezone: null,
    language: 'fr',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  };
  const store = {
    projects: {
      insert: () => undefined,
      patch: () => 1,
      byId: (id: string) => (id === project.id ? project : undefined),
      bySlug: () => undefined,
      list: () => [project],
    },
    facts: { insert: () => undefined, patch: () => 1, byId: () => undefined, list: () => [] },
    skillFacts: {
      insert: () => undefined,
      patch: () => 1,
      byId: () => undefined,
      list: () => [],
      byProjectAndSkill: () => undefined,
    },
    audienceProfiles: { insert: () => undefined, byId: () => undefined, list: () => [] },
    styleProfiles: { insert: () => undefined, byId: () => undefined, list: () => [] },
    owner: { currentId: () => 'owner-1' },
    transaction: <T>(operation: () => T): T => operation(),
  } as unknown as ProjectMemoryStore;

  return {
    store: {
      conversations: {
        insert: () => undefined,
        patch: () => 1,
        byId: () => undefined,
        byProject: () => [],
      },
      messages: {
        insert: () => undefined,
        patch: () => 1,
        byId: () => undefined,
        list: () => [],
        count: () => 0,
      },
      summaries: { insert: () => undefined, list: () => [] },
      briefs: {
        insert: () => undefined,
        patch: () => 1,
        byId: () => undefined,
        list: () => [],
        latest: () => undefined,
        current: () => undefined,
      },
      memory: { snapshot: () => undefined },
      transaction: <T>(operation: () => T): T => operation(),
    },
    memory: store,
    clock,
    newId: () => `n-${(counter += 1)}`,
  };
}

function conversation(): Conversation {
  return {
    id: 'c1',
    projectId: 'p1',
    title: null,
    kind: 'interview',
    stage: 'fact_extraction',
    missingSlots: ['facts'],
    modelUsed: null,
    messageCount: 2,
    lastMessageAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    closedAt: null,
  };
}

function output(overrides: Partial<InterviewerOutput> = {}): InterviewerOutput {
  return {
    reply: 'Merci, c’est noté.',
    message_type: 'question',
    question_options: null,
    extracted_facts: [],
    skill_deltas: [],
    project_edits: [],
    proposed_audiences: [],
    proposed_style: null,
    open_questions: [],
    suggested_next: 'continue',
    ...overrides,
  };
}

describe('propositions d’écriture (docs/05 §3.2, docs/04 §6.3)', () => {
  it('normalise les citations sans devenir permissif', () => {
    expect(normalizeQuote('  J’AI   automatisé ')).toBe("j'ai automatisé");
    expect(isQuoteGrounded('j’ai automatisé 12 factures', USER_MESSAGE)).toBe(true);
    expect(isQuoteGrounded('j’ai automatisé 500 factures', USER_MESSAGE)).toBe(false);
    expect(isQuoteGrounded('', USER_MESSAGE)).toBe(false);
  });

  it('marque refusée une proposition dont la citation n’est pas dans le message', () => {
    const plan = planFromInterviewerOutput(ports(), {
      assistantMessageId: 'm2',
      sourceMessageId: 'm1',
      sourceText: USER_MESSAGE,
      output: output({
        extracted_facts: [
          {
            category: 'chiffre',
            statement: '12 factures automatisées',
            detail: null,
            importance: 4,
            source_quote: 'automatisé 12 factures',
          },
          {
            category: 'chiffre',
            statement: '500 clients servis',
            detail: null,
            importance: 5,
            source_quote: 'j’ai 500 clients',
          },
        ],
      }),
    });

    expect(plan.facts[0]?.status).toBe('pending');
    expect(plan.facts[1]?.status).toBe('rejected');
    expect(plan.facts[1]?.rejectedReason).toContain('citation introuvable');
    expect(pendingProposalCount(plan)).toBe(1);
  });

  it('n’écrit rien quand aucune proposition n’est acceptée', () => {
    const plan = planFromInterviewerOutput(ports(), {
      assistantMessageId: 'm2',
      sourceMessageId: 'm1',
      sourceText: USER_MESSAGE,
      output: output({
        extracted_facts: [
          {
            category: 'chiffre',
            statement: '12 factures automatisées',
            detail: null,
            importance: 4,
            source_quote: 'automatisé 12 factures',
          },
        ],
      }),
    });

    const result = applyEditPlan(ports(), conversation(), plan, { accept: [] });
    expect(result.facts).toHaveLength(0);
    expect(plan.facts[0]?.status).toBe('pending');
  });

  it('applique compétence, public, voix et édition de projet acceptées', () => {
    const p = ports();
    const plan = planFromInterviewerOutput(p, {
      assistantMessageId: 'm2',
      sourceMessageId: 'm1',
      sourceText: USER_MESSAGE,
      output: output({
        skill_deltas: [
          {
            skill: 'n8n',
            level: 'avance',
            is_learning: false,
            evidence: null,
            source_quote: 'automatisé 12 factures avec n8n',
          },
        ],
        project_edits: [
          {
            positioning: 'Automatiser les factures des indépendants',
            target_goal: '500 abonnés LinkedIn',
            source_quote: 'automatisé 12 factures',
          },
        ],
        proposed_audiences: [
          {
            name: 'Indépendants débordés',
            description: null,
            knowledge_level: 'debutant',
            pain_points: ['facturation manuelle'],
            goals: [],
            platforms: ['linkedin'],
            source_quote: 'automatisé 12 factures',
          },
        ],
        proposed_style: {
          name: 'Direct et concret',
          tone: 'direct',
          formality: 3,
          sentence_length: 'courte',
          forbidden_words: [],
          signature_openings: [],
          signature_closings: [],
          source_quote: 'je code en TypeScript',
        },
      }),
    });

    const accepted = [
      plan.skills[0]!.id,
      plan.projectEdits[0]!.id,
      plan.audiences[0]!.id,
      plan.styles[0]!.id,
    ];
    const result = applyEditPlan(p, conversation(), plan, { accept: accepted });

    expect(result.skills[0]?.skill).toBe('n8n');
    expect(result.audiences[0]?.name).toBe('Indépendants débordés');
    expect(result.styles[0]?.name).toBe('Direct et concret');
    expect(result.refused).toHaveLength(0);
  });

  it('refuse une proposition non citée même acceptée, et explique pourquoi', () => {
    const p = ports();
    const plan = planFromInterviewerOutput(p, {
      assistantMessageId: 'm2',
      sourceMessageId: 'm1',
      sourceText: USER_MESSAGE,
      output: output({
        extracted_facts: [
          {
            category: 'chiffre',
            statement: '500 clients servis',
            detail: null,
            importance: 5,
            source_quote: 'j’ai 500 clients',
          },
        ],
      }),
    });

    const result = applyEditPlan(p, conversation(), plan, { accept: [plan.facts[0]!.id] });
    expect(result.facts).toHaveLength(0);
    expect(result.refused[0]?.reason).toContain('citation introuvable');
  });
});

const BRIEF_CONTENT = {
  summary: 'Un projet d’automatisation de facturation.',
  positioning: 'Automatiser les factures des indépendants',
  target_audience: 'Indépendants débordés, débutants en automatisation',
  content_pillars: ['Automatisation', 'Retours d’expérience'],
  themes: ['n8n', 'facturation'],
  formats: null,
  skill_map: null,
  gaps: ['Aucune expertise comptable'],
  cadence: null,
  success_criteria: null,
  open_questions: null,
};

describe('fiche maître : immuabilité et versions (docs/03 §8.1)', () => {
  it('crée un brouillon version 1 et signale ses trous', () => {
    const p = ports();
    const brief = buildBriefRecord(
      p,
      {
        projectId: 'p1',
        conversationId: 'c1',
        llmCallId: null,
        sourceMessageIds: ['m1'],
        version: 1,
      },
      BRIEF_CONTENT,
    );

    expect(brief.status).toBe('draft');
    expect(brief.version).toBe(1);
    expect(brief.validatedAt).toBeNull();
    // Un trou visible vaut mieux qu'une invention : l'écran l'affiche.
    expect(briefGaps(brief)).toEqual(['formats', 'cadence', 'success_criteria']);
  });

  it('refuse une fiche sans positionnement (le domaine, pas le modèle)', () => {
    const p = ports();
    expect(() =>
      buildBriefRecord(
        p,
        {
          projectId: 'p1',
          conversationId: 'c1',
          llmCallId: null,
          sourceMessageIds: [],
          version: 1,
        },
        { ...BRIEF_CONTENT, positioning: '' },
      ),
    ).toThrow();
  });

  it('corriger une fiche validée crée une nouvelle version, jamais une réécriture', () => {
    const p = ports();
    const first = buildBriefRecord(
      p,
      { projectId: 'p1', conversationId: 'c1', llmCallId: null, sourceMessageIds: [], version: 1 },
      BRIEF_CONTENT,
    );
    const validated: MasterBrief = { ...first, ...planBriefValidation(first, NOW) };
    expect(validated.validatedAt).toBe(NOW);

    const second = nextBriefVersion(p, validated, {
      positioning: 'Automatiser et documenter la facturation',
    });
    expect(second.version).toBe(2);
    expect(second.status).toBe('draft');
    expect(second.summary).toBe(first.summary);
    expect(second.positioning).toBe('Automatiser et documenter la facturation');

    const superseded = planBriefSupersession(first, second.id, NOW);
    expect(superseded.status).toBe('superseded');
    expect(superseded.supersededById).toBe(second.id);
  });

  it('ne valide pas deux fois la même version, et ne rouvre pas une version remplacée', () => {
    const p = ports();
    const first = buildBriefRecord(
      p,
      { projectId: 'p1', conversationId: 'c1', llmCallId: null, sourceMessageIds: [], version: 1 },
      BRIEF_CONTENT,
    );
    const validated: MasterBrief = { ...first, ...planBriefValidation(first, NOW) };
    expect(() => planBriefValidation(validated, NOW)).toThrow();

    const superseded: MasterBrief = {
      ...validated,
      ...planBriefSupersession(validated, 'other', NOW),
    };
    expect(() => nextBriefVersion(p, superseded, { thesis: undefined } as never)).toThrow();
    expect(() => planBriefSupersession(superseded, 'other-2', NOW)).toThrow();
  });
});
