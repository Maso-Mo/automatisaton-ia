import type { Agent, InterviewerInput, StrategistInput, LLMUsage } from '@aia/ai';
import { syncPrompts } from '@aia/ai';
import { createConversationStore, createProjectMemoryStore } from '@aia/database';
import { createProject } from '@aia/core';
import type { ConversationPorts, ProjectMemoryPorts } from '@aia/core';
import type { InterviewerOutput, MasterBriefOutput } from '@aia/shared';
import { uuidv7 } from '@aia/shared';
import type { ConversationFeatureDeps } from '../../apps/api/src/features/conversation';
import { REPO_PROMPTS_DIR, type TestContext } from './harness';

/**
 * Empile la conversation de l'étape 3 sur une base **réelle** : prompts
 * synchronisés, dépôts SQLite, agents branchés sur un provider **scripté**
 * (aucun réseau, aucun coût). C'est le même code que la production ; seul le
 * fournisseur change — exactement comme le job `noop` de l'étape 1.
 */

const USAGE: LLMUsage = {
  provider: 'scripted',
  model: 'scripted-model',
  inputTokens: 800,
  outputTokens: 200,
  cachedTokens: 0,
  costUsd: 0.0004,
  costMicroUsd: 400,
  latencyMs: 12,
};

/** Intervieweur scripté : la sortie est fournie par le test, tour par tour. */
export function scriptedInterviewer(
  outputs: readonly InterviewerOutput[],
): Agent<InterviewerInput, InterviewerOutput> {
  let turn = 0;
  return {
    name: 'interviewer',
    task: 'converse',
    promptFile: 'interviewer/converse.md',
    estimateTokens: () => ({ input: 100, output: 100 }),
    run: async () => {
      const output = outputs[Math.min(turn, outputs.length - 1)];
      turn += 1;
      if (!output) throw new Error('aucune sortie scriptée disponible');
      return { output, repaired: false, usage: USAGE };
    },
  };
}

export function scriptedStrategist(
  output: MasterBriefOutput,
): Agent<StrategistInput, MasterBriefOutput> {
  return {
    name: 'strategist',
    task: 'master_brief',
    promptFile: 'strategist/master_brief.md',
    estimateTokens: () => ({ input: 200, output: 400 }),
    run: async () => ({
      output,
      repaired: false,
      usage: { ...USAGE, model: 'scripted-strategist', costMicroUsd: 1_000 },
    }),
  };
}

export interface ConversationStack {
  memory: ProjectMemoryPorts;
  ports: ConversationPorts;
  deps: ConversationFeatureDeps;
  projectId: string;
}

export interface ConversationStackOptions {
  interviewer?: Agent<InterviewerInput, InterviewerOutput>;
  strategist?: Agent<StrategistInput, MasterBriefOutput>;
  projectName?: string;
}

export function createConversationStack(
  context: TestContext,
  options: ConversationStackOptions = {},
): ConversationStack {
  const { handle, clock, logger } = context;
  syncPrompts({ handle, promptsDir: REPO_PROMPTS_DIR, clock, logger, gitCommit: null });

  const store = createProjectMemoryStore(handle, { nowMs: () => clock.nowMs() });
  const memory: ProjectMemoryPorts = { store, clock, newId: () => uuidv7(clock.nowMs()) };
  const ports: ConversationPorts = {
    store: createConversationStore(handle, { nowMs: () => clock.nowMs() }),
    memory: store,
    clock,
    newId: () => uuidv7(clock.nowMs()),
  };

  const project = createProject(memory, { name: options.projectName ?? 'Projet de test' });

  const interviewer = options.interviewer ?? scriptedInterviewer([defaultInterviewerOutput()]);
  const strategist = options.strategist ?? scriptedStrategist(defaultBriefOutput());

  const deps: ConversationFeatureDeps = {
    memory,
    ports,
    agents: {
      interviewer: () => ({
        agent: interviewer,
        prompt: { promptVersionId: 'prompt-interviewer', filePath: 'interviewer/converse.md' },
        // Aucun `llm_calls` réel n'est écrit par un agent scripté : la colonne
        // est une clé étrangère, donc on ne ment pas avec un identifiant factice.
        lastCallId: () => null,
      }),
      strategist: () => ({
        agent: strategist,
        prompt: { promptVersionId: 'prompt-strategist', filePath: 'strategist/master_brief.md' },
        lastCallId: () => null,
      }),
    },
    logger,
  };

  return { memory, ports, deps, projectId: project.id };
}

/**
 * Sortie d'entretien par défaut : les citations sont **contenues** dans le
 * message utilisateur de référence (voir `USER_TURN` dans le test), comme le
 * ferait un modèle correctement cadré.
 */
export const USER_TURN = 'J’ai automatisé 12 factures avec n8n, je code en TypeScript.';

export function defaultInterviewerOutput(
  overrides: Partial<InterviewerOutput> = {},
): InterviewerOutput {
  return {
    reply: 'Merci, c’est noté. Comment décrirais-tu ton public ?',
    message_type: 'question',
    question_options: null,
    extracted_facts: [
      {
        category: 'chiffre',
        statement: '12 factures automatisées',
        detail: null,
        importance: 4,
        source_quote: 'automatisé 12 factures',
      },
    ],
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
        positioning: 'Automatiser la facturation des indépendants',
        target_goal: null,
        source_quote: 'automatisé 12 factures',
      },
    ],
    proposed_audiences: [
      {
        name: 'Indépendants débordés',
        description: null,
        knowledge_level: 'debutant',
        pain_points: [],
        goals: [],
        platforms: ['linkedin'],
        source_quote: 'automatisé 12 factures',
      },
    ],
    proposed_style: null,
    open_questions: ['Quel rythme de publication ?'],
    suggested_next: 'continue',
    ...overrides,
  };
}

export function defaultBriefOutput(): MasterBriefOutput {
  return {
    master_brief: {
      summary: 'Un projet d’automatisation de la facturation.',
      positioning: 'Automatiser la facturation des indépendants',
      target_audience: 'Indépendants débordés, débutants',
      content_pillars: ['Automatisation', 'Retours d’expérience'],
      themes: ['n8n', 'facturation'],
      formats: null,
      skill_map: null,
      gaps: ['Comptabilité'],
      cadence: null,
      success_criteria: null,
      open_questions: null,
    },
  };
}
