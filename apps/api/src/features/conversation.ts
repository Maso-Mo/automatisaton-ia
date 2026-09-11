import { buildMemoryPack, type Agent, type MemoryPack, type MemoryPackFact } from '@aia/ai';
import {
  appendUserMessage,
  buildTurnContext,
  createMasterBrief,
  currentBrief,
  getConversation,
  getProjectContext,
  readStoredPlan,
  recordAssistantTurn,
  refreshProgress,
  type Conversation,
  type ConversationEditPlan,
  type ConversationPorts,
  type MasterBrief,
  type Message,
  type ProjectMemoryPorts,
} from '@aia/core';
import type { AppLogger } from '@aia/observability';
import type { InterviewerInput, StrategistInput, LLMUsage } from '@aia/ai';
import type { InterviewerOutput, MasterBriefOutput } from '@aia/shared';
import { ValidationError } from '@aia/shared';

/**
 * Orchestration d'un tour de conversation — le **cœur de l'étape 3**.
 *
 * Ce module est le seul endroit où le domaine (`@aia/core`) rencontre les agents
 * (`@aia/ai`). Les deux paquets s'ignorent : le domaine définit les cas d'usage et
 * les ports, l'IA fournit des agents et un paquet de mémoire, et c'est ici — dans
 * le point de composition de l'application — que les deux se rejoignent.
 *
 * L'ordre est celui de docs/05 §3.2, et il compte :
 *
 * 1. le message utilisateur est **persisté avant tout appel** (un échec ne fait
 *    rien perdre à l'utilisateur) ;
 * 2. la complétude de la phase est calculée **localement** (aucun coût) ;
 * 3. le paquet de mémoire est construit par **sélection déterministe** (aucun RAG) ;
 * 4. l'agent propose une écriture ; le domaine la garde en attente ;
 * 5. rien n'entre en mémoire sans que l'utilisateur l'accepte.
 */

export interface ConversationAgentBundle<TIn, TOut> {
  agent: Agent<TIn, TOut>;
  prompt: { promptVersionId: string; filePath: string };
  /** Identifiant de la dernière ligne `llm_calls` écrite (traçabilité). */
  lastCallId(): string | null;
}

export interface ConversationFeatureDeps {
  /** Mémoire du projet : la conversation lit et propose. */
  memory: ProjectMemoryPorts;
  /** Conversation et fiche maître : le domaine décide. */
  ports: ConversationPorts;
  agents: {
    interviewer(): ConversationAgentBundle<InterviewerInput, InterviewerOutput>;
    strategist(): ConversationAgentBundle<StrategistInput, MasterBriefOutput>;
  };
  logger: AppLogger;
}

export interface RunTurnResult {
  conversation: Conversation;
  userMessage: Message;
  assistantMessage: Message;
  plan: ConversationEditPlan;
  usage: LLMUsage;
  repaired: boolean;
}

/**
 * Paquet de mémoire d'une conversation : projet, compétences, faits **sélectionnés
 * par le domaine**, public et voix. Vide quand l'entretien n'a rien encore — et
 * c'est exactement ce que l'intervieweur doit aller chercher.
 */
export function memoryPackForProject(deps: ConversationFeatureDeps, projectId: string): MemoryPack {
  const project = deps.memory.store.projects.byId(projectId);
  if (!project) {
    throw new ValidationError(`Projet introuvable : ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }

  // La sélection est faite par `@aia/core` (importance × récence ÷ usages) : elle
  // est gratuite, reproductible et explicable, et **seuls les faits confirmés**
  // entrent dans un prompt (docs/03 §6.1). Aucun embedding, aucun RAG en V1.
  const context = getProjectContext(deps.memory, projectId);

  return buildMemoryPack({
    project: {
      id: project.id,
      name: project.name,
      status: project.status,
      positioning: project.positioning,
      targetGoal: project.targetGoal,
      language: project.language,
    },
    facts: context.facts.map((item): MemoryPackFact => ({
      id: item.fact.id,
      category: item.fact.category,
      statement: item.fact.statement,
      detail: item.fact.detail,
      importance: item.fact.importance,
      verificationStatus: item.fact.verificationStatus,
    })),
    skillFacts: deps.memory.store.skillFacts.list(projectId).map((skill) => ({
      skill: skill.skill,
      level: skill.level,
      evidence: skill.evidence,
    })),
    audience: firstAudience(deps, projectId),
    style: firstStyle(deps, projectId),
  });
}

function firstAudience(deps: ConversationFeatureDeps, projectId: string) {
  const profile = deps.memory.store.audienceProfiles.list(projectId)[0];
  if (!profile) return null;
  return {
    name: profile.name,
    description: profile.description,
    knowledgeLevel: profile.knowledgeLevel,
    painPoints: profile.painPoints,
  };
}

function firstStyle(deps: ConversationFeatureDeps, projectId: string) {
  const profile = deps.memory.store.styleProfiles.list(projectId)[0];
  if (!profile) return null;
  return {
    name: profile.name,
    tone: profile.tone,
    formality: profile.formality,
    forbiddenWords: profile.forbiddenWords,
  };
}

/**
 * Un tour complet : du texte de l'utilisateur au message de l'assistant, avec son
 * plan d'écriture. L'appel LLM est **synchrone** — c'est le choix documenté
 * (docs/05 §10.1 : « Conversation | synchrone (pas un job) »), parce qu'un
 * échange de 2 à 8 secondes se vit dans la requête, alors qu'un rendu vidéo non.
 */
export async function runConversationTurn(
  deps: ConversationFeatureDeps,
  conversationId: string,
  input: { content: string },
): Promise<RunTurnResult> {
  // 1. Le message utilisateur entre en base **avant** l'appel.
  const { message: userMessage } = appendUserMessage(deps.ports, conversationId, {
    content: input.content,
    inputMode: 'text',
  });

  // 2 et 3. Complétude recalculée localement, puis paquet de mémoire borné.
  const turn = buildTurnContext(deps.ports, conversationId);
  const memoryPack = memoryPackForProject(deps, turn.conversation.projectId);

  const bundle = deps.agents.interviewer();
  const result = await bundle.agent.run(
    {
      memoryPack,
      window: turn.window.verbatim.map((message) => ({
        role: message.role,
        content: message.content,
        messageType: message.messageType,
      })),
      summaries: turn.summaries.map((summary) => summary.summary),
      slot: turn.slot,
      guidance: turn.guidance,
      openQuestions: lastOpenQuestions(deps, conversationId),
      userMessage: userMessage.content ?? '',
      projectName: turn.projectContext.projectName,
    },
    {
      callContext: {
        agent: 'interviewer',
        task: 'converse',
        projectId: turn.conversation.projectId,
        conversationId,
      },
    },
  );

  // 9. Le message de l'assistant et son plan sont persistés ensemble ; rien
  // n'entre en mémoire tant que l'utilisateur n'a pas accepté.
  const recorded = recordAssistantTurn(deps.ports, conversationId, {
    output: result.output,
    sourceMessage: userMessage,
    agent: 'interviewer',
    model: result.usage.model,
    llmCallId: bundle.lastCallId(),
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
    costMicroUsd: result.usage.costMicroUsd,
  });

  deps.logger.info(
    {
      conversationId,
      projectId: turn.conversation.projectId,
      slot: turn.slot,
      stage: recorded.conversation.stage,
      costMicroUsd: result.usage.costMicroUsd,
      repaired: result.repaired,
      proposals: recorded.plan.facts.length + recorded.plan.skills.length,
    },
    'tour de conversation enregistré',
  );

  return {
    conversation: recorded.conversation,
    userMessage,
    assistantMessage: recorded.message,
    plan: recorded.plan,
    usage: result.usage,
    repaired: result.repaired,
  };
}

/** Questions restées ouvertes du dernier tour : elles ne doivent pas être oubliées. */
function lastOpenQuestions(deps: ConversationFeatureDeps, conversationId: string): string[] {
  const messages = deps.ports.store.messages.list(conversationId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    try {
      return readStoredPlan(message).openQuestions;
    } catch {
      continue;
    }
  }
  return [];
}

export interface MasterBriefResult {
  brief: MasterBrief;
  usage: LLMUsage;
  repaired: boolean;
  conversation: Conversation;
}

/**
 * Génère (ou régénère) la fiche maître à partir de tout l'entretien.
 *
 * « Aucun pipeline ne se déclenche automatiquement depuis la conversation »
 * (docs/05 §3.4) : cette fonction n'est appelée que par une action explicite de
 * l'utilisateur, et `createMasterBrief` refuse une fiche si le positionnement ou
 * le public manquent encore.
 */
export async function generateMasterBrief(
  deps: ConversationFeatureDeps,
  conversationId: string,
): Promise<MasterBriefResult> {
  const turn = buildTurnContext(deps.ports, conversationId);
  const memoryPack = memoryPackForProject(deps, turn.conversation.projectId);
  const messages = deps.ports.store.messages.list(conversationId);

  const bundle = deps.agents.strategist();
  const result = await bundle.agent.run(
    {
      memoryPack,
      summaries: turn.summaries.map((summary) => summary.summary),
      window: messages
        .filter((message) => message.content !== null)
        .slice(-20)
        .map(
          (message) =>
            `${message.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${message.content ?? ''}`,
        ),
      openQuestions: lastOpenQuestions(deps, conversationId),
    },
    {
      callContext: {
        agent: 'strategist',
        task: 'master_brief',
        projectId: turn.conversation.projectId,
        conversationId,
      },
    },
  );

  const brief = createMasterBrief(deps.ports, conversationId, result.output.master_brief, {
    llmCallId: bundle.lastCallId(),
    sourceMessageIds: messages.map((message) => message.id).slice(-40),
  });

  deps.logger.info(
    {
      conversationId,
      briefId: brief.id,
      version: brief.version,
      costMicroUsd: result.usage.costMicroUsd,
      repaired: result.repaired,
    },
    'fiche maître générée',
  );

  return {
    brief,
    usage: result.usage,
    repaired: result.repaired,
    conversation: refreshProgress(deps.ports, getConversation(deps.ports, conversationId)),
  };
}

/** Fiche courante du projet : ce que l'écran affiche en haut de la conversation. */
export function projectBrief(deps: ConversationFeatureDeps, projectId: string): MasterBrief | null {
  return currentBrief(deps.ports, projectId) ?? null;
}
