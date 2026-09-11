import {
  NotFoundError,
  type InterviewerOutput,
  type MasterBriefContent,
  type MessageInputMode,
} from '@aia/shared';
import { InvalidStateTransitionError, ProjectNotReadyError } from '../errors';
import { getProjectContext } from '../projects/service';
import {
  applyEditPlan,
  planFromInterviewerOutput,
  type ApplyEditPlanResult,
  type ConversationEditPlan,
  type ProposalDecisions,
} from './edit-plan';
import {
  applyBriefToProject,
  briefGaps,
  buildBriefRecord,
  nextBriefVersion,
  planBriefSupersession,
  planBriefValidation,
  type BriefEditInput,
} from './master-brief';
import {
  buildConversationWindow,
  buildMessage,
  shouldTitleConversation,
  titleFromMessage,
  type ConversationWindow,
} from './messages';
import {
  SLOT_GUIDANCE,
  assertStageTransition,
  computeMissingSlots,
  nextStage,
  type ConversationSlot,
} from './stages';
import {
  projectMemoryPorts,
  type Conversation,
  type ConversationPatch,
  type ConversationPorts,
  type ConversationSummary,
  type MasterBrief,
  type Message,
} from './types';

/**
 * Cas d'usage de la conversation et de la fiche maître (docs/05 §3).
 *
 * Le domaine **décide** : la phase courante, les lacunes, ce qui est accepté,
 * ce qui devient une nouvelle version de fiche. Le modèle ne décide rien — il
 * propose. Ce fichier ne connaît ni SQL ni HTTP, et reçoit ses ports.
 *
 * L'ordre d'un tour est celui de docs/05 §3.2 :
 * `message utilisateur → complétude calculée localement → phase → contexte →
 * (appel) → validation → écriture des propositions → réponse`.
 */

function requireConversation(ports: ConversationPorts, conversationId: string): Conversation {
  const conversation = ports.store.conversations.byId(conversationId);
  if (!conversation) {
    throw new NotFoundError(`Conversation introuvable : ${conversationId}`, {
      code: 'CONVERSATION_NOT_FOUND',
      details: { conversationId },
    });
  }
  return conversation;
}

function requireBrief(ports: ConversationPorts, briefId: string): MasterBrief {
  const brief = ports.store.briefs.byId(briefId);
  if (!brief) {
    throw new NotFoundError(`Fiche maître introuvable : ${briefId}`, {
      code: 'MASTER_BRIEF_NOT_FOUND',
      details: { briefId },
    });
  }
  return brief;
}

function requireMessage(
  ports: ConversationPorts,
  conversationId: string,
  messageId: string,
): Message {
  const message = ports.store.messages.byId(messageId);
  if (!message || message.conversationId !== conversationId) {
    throw new NotFoundError(`Message introuvable dans cette conversation : ${messageId}`, {
      code: 'MESSAGE_NOT_FOUND',
      details: { conversationId, messageId },
    });
  }
  return message;
}

function requireProjectSnapshot(ports: ConversationPorts, projectId: string) {
  const snapshot = ports.store.memory.snapshot(projectId);
  if (!snapshot) {
    throw new NotFoundError(`Projet introuvable : ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }
  return snapshot;
}

/** Les lacunes sont relues et **filtrées** : une valeur inconnue ne vient pas du domaine. */
export function readSlots(conversation: Conversation): ConversationSlot[] {
  return conversation.missingSlots.filter((slot): slot is ConversationSlot =>
    Object.prototype.hasOwnProperty.call(SLOT_GUIDANCE, slot),
  );
}

export interface CreateConversationOptions {
  kind?: Conversation['kind'];
  title?: string | null;
}

export function createConversation(
  ports: ConversationPorts,
  projectId: string,
  options: CreateConversationOptions = {},
): Conversation {
  const snapshot = requireProjectSnapshot(ports, projectId);
  const missingSlots = computeMissingSlots(snapshot);
  const now = ports.clock.nowMs();
  const hasBrief = ports.store.briefs.current(projectId) !== undefined;

  const conversation: Conversation = {
    id: ports.newId(),
    projectId,
    title: options.title ?? null,
    kind: options.kind ?? 'interview',
    stage: nextStage(missingSlots, { hasBrief }),
    missingSlots,
    modelUsed: null,
    messageCount: 0,
    lastMessageAt: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };

  ports.store.conversations.insert(conversation);
  return conversation;
}

export function getConversation(ports: ConversationPorts, conversationId: string): Conversation {
  return requireConversation(ports, conversationId);
}

export function listConversations(
  ports: ConversationPorts,
  filter: { projectId?: string; limit?: number } = {},
): Conversation[] {
  if (!filter.projectId) return [];
  requireProjectSnapshot(ports, filter.projectId);
  return ports.store.conversations.byProject(filter.projectId, filter.limit);
}

export function listMessages(
  ports: ConversationPorts,
  conversationId: string,
  options: { limit?: number; includeDeleted?: boolean } = {},
): Message[] {
  requireConversation(ports, conversationId);
  return ports.store.messages.list(conversationId, options);
}

export function listSummaries(
  ports: ConversationPorts,
  conversationId: string,
): ConversationSummary[] {
  requireConversation(ports, conversationId);
  return ports.store.summaries.list(conversationId);
}

/**
 * Recalcule les lacunes et la phase **localement** (aucun appel de modèle) :
 * c'est ce qui garantit qu'une question déjà répondue par la mémoire n'est pas
 * reposée (docs/03 §7.1).
 */
export function refreshProgress(
  ports: ConversationPorts,
  conversation: Conversation,
): Conversation {
  const snapshot = requireProjectSnapshot(ports, conversation.projectId);
  const missingSlots = computeMissingSlots(snapshot);
  const hasBrief = ports.store.briefs.latest(conversation.id) !== undefined;
  const stage = nextStage(missingSlots, { hasBrief, closed: conversation.stage === 'closed' });

  if (conversation.stage !== stage) assertStageTransition(conversation.stage, stage);

  const patch: ConversationPatch = {
    missingSlots,
    stage,
    updatedAt: ports.clock.nowMs(),
  };
  ports.store.conversations.patch(conversation.id, patch);
  return { ...conversation, ...patch };
}

export interface AppendUserMessageInput {
  content: string;
  inputMode?: MessageInputMode;
}

/**
 * Étape 1 du tour : **le message utilisateur est persisté avant tout appel**.
 * C'est ce qui rend « réessayer » gratuit : si l'appel échoue, la phrase de
 * l'utilisateur est encore là (docs/05 §3.4).
 */
export function appendUserMessage(
  ports: ConversationPorts,
  conversationId: string,
  input: AppendUserMessageInput,
): { conversation: Conversation; message: Message } {
  const conversation = requireConversation(ports, conversationId);
  if (conversation.stage === 'closed') {
    throw new InvalidStateTransitionError('closed', 'brief_ready', {
      entity: `conversation ${conversationId}`,
    });
  }

  const content = input.content.trim();
  const message = buildMessage(ports, {
    conversationId,
    role: 'user',
    content,
    messageType: 'text',
    inputMode: input.inputMode ?? 'text',
  });
  ports.store.messages.insert(message);

  const updated: Conversation = {
    ...conversation,
    messageCount: conversation.messageCount + 1,
    lastMessageAt: message.createdAt,
    updatedAt: message.createdAt,
    title: shouldTitleConversation({
      title: conversation.title,
      messageCount: conversation.messageCount + 1,
    })
      ? titleFromMessage(message)
      : conversation.title,
  };
  ports.store.conversations.patch(conversationId, {
    messageCount: updated.messageCount,
    lastMessageAt: updated.lastMessageAt,
    updatedAt: updated.updatedAt,
    title: updated.title,
  });

  return { conversation: refreshProgress(ports, updated), message };
}

export interface TurnContext {
  conversation: Conversation;
  /** Fenêtre glissante : 10 derniers messages + résumés des blocs couverts. */
  window: ConversationWindow;
  /** Contexte déterministe du projet : faits confirmés, catégories manquantes. */
  projectContext: ReturnType<typeof getProjectContext>;
  /** La phase courante et la trame qui en découle. Locales, donc gratuites. */
  slot: ConversationSlot | null;
  guidance: string | null;
  summaries: ConversationSummary[];
}

/**
 * Construit tout ce dont l'agent a besoin — et **rien de plus**. Ce paquet est
 * calculé par du code : ni embedding, ni RAG, ni sélection par le modèle
 * (docs/04 §5.3, docs/10 §4.2 « Interdits »).
 */
export function buildTurnContext(ports: ConversationPorts, conversationId: string): TurnContext {
  const conversation = refreshProgress(ports, requireConversation(ports, conversationId));
  const messages = ports.store.messages.list(conversationId);
  const summaries = ports.store.summaries.list(conversationId);
  const slot = readSlots(conversation)[0] ?? null;

  return {
    conversation,
    window: buildConversationWindow(messages, summaries),
    projectContext: getProjectContext(projectMemoryPorts(ports), conversation.projectId),
    slot,
    guidance: slot === null ? null : (SLOT_GUIDANCE[slot] ?? null),
    summaries,
  };
}

export interface RecordAssistantTurnParams {
  output: InterviewerOutput;
  /** Message de l'utilisateur qui a déclenché le tour : la source des citations. */
  sourceMessage: Message;
  agent: string;
  model: string | null;
  llmCallId: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costMicroUsd?: number;
}

/**
 * Étape 9 du tour : le message de l'assistant est écrit **avec son plan
 * d'écriture**, et rien d'autre. Aucun fait n'entre en mémoire ici : c'est
 * l'acceptation par l'utilisateur qui le fera (docs/05 §3.2).
 */
export function recordAssistantTurn(
  ports: ConversationPorts,
  conversationId: string,
  params: RecordAssistantTurnParams,
): { conversation: Conversation; message: Message; plan: ConversationEditPlan } {
  const conversation = requireConversation(ports, conversationId);
  const messageId = ports.newId();

  const plan = planFromInterviewerOutput(ports, {
    assistantMessageId: messageId,
    sourceMessageId: params.sourceMessage.id,
    sourceText: params.sourceMessage.content ?? '',
    output: params.output,
  });

  const message = buildMessage(ports, {
    conversationId,
    role: 'assistant',
    content: params.output.reply,
    contentJson: { plan },
    messageType: params.output.message_type,
    agent: params.agent,
    tokensIn: params.tokensIn ?? null,
    tokensOut: params.tokensOut ?? null,
    costMicroUsd: params.costMicroUsd ?? 0,
    llmCallId: params.llmCallId,
    parentMessageId: params.sourceMessage.id,
  });

  ports.store.messages.insert({
    ...message,
    id: messageId,
    contentJson: { plan: { ...plan, assistantMessageId: messageId } },
  });

  const updated: Conversation = {
    ...conversation,
    messageCount: conversation.messageCount + 1,
    lastMessageAt: message.createdAt,
    updatedAt: message.createdAt,
    modelUsed: params.model,
  };
  ports.store.conversations.patch(conversationId, {
    messageCount: updated.messageCount,
    lastMessageAt: updated.lastMessageAt,
    updatedAt: updated.updatedAt,
    modelUsed: updated.modelUsed,
  });

  return {
    conversation: refreshProgress(ports, updated),
    message: {
      ...message,
      id: messageId,
      contentJson: { plan: { ...plan, assistantMessageId: messageId } },
    },
    plan: { ...plan, assistantMessageId: messageId },
  };
}

/** Relecture d'un plan stocké : une colonne JSON n'est jamais crue sur parole. */
export function readStoredPlan(message: Message): ConversationEditPlan {
  const payload = message.contentJson as { plan?: unknown } | null;
  const plan = payload?.plan as ConversationEditPlan | undefined;
  if (
    !plan ||
    typeof plan !== 'object' ||
    !Array.isArray(plan.facts) ||
    !Array.isArray(plan.skills) ||
    typeof plan.assistantMessageId !== 'string' ||
    typeof plan.sourceMessageId !== 'string'
  ) {
    throw new InvalidStateTransitionError('aucun plan', 'plan exploitable', {
      entity: `message ${message.id}`,
    });
  }
  return plan;
}

/**
 * Applique les décisions de l'utilisateur et **réécrit le plan** dans le message :
 * l'interface sait ainsi, au rechargement, ce qui a déjà été accepté.
 */
export function applyProposals(
  ports: ConversationPorts,
  conversationId: string,
  messageId: string,
  decisions: ProposalDecisions,
): ApplyEditPlanResult & { conversation: Conversation; message: Message } {
  const conversation = requireConversation(ports, conversationId);
  const message = requireMessage(ports, conversationId, messageId);
  const plan = readStoredPlan(message);

  const result = applyEditPlan(ports, conversation, plan, decisions);
  const stored = { ...message, contentJson: { plan: result.plan } };
  ports.store.messages.patch(message.id, { contentJson: { plan: result.plan } });

  return {
    ...result,
    message: stored,
    conversation: refreshProgress(ports, conversation),
  };
}

export function getMessage(
  ports: ConversationPorts,
  conversationId: string,
  messageId: string,
): Message {
  requireConversation(ports, conversationId);
  return requireMessage(ports, conversationId, messageId);
}

/** Fermer un entretien : un état explicite, jamais une inférence (docs/03 §7.1). */
export function closeConversation(ports: ConversationPorts, conversationId: string): Conversation {
  const conversation = requireConversation(ports, conversationId);
  const now = ports.clock.nowMs();
  const patch: ConversationPatch = {
    stage: nextStage(readSlots(conversation), { hasBrief: true, closed: true }),
    closedAt: conversation.closedAt ?? now,
    updatedAt: now,
  };
  if (conversation.stage !== patch.stage) {
    assertStageTransition(conversation.stage, patch.stage as Conversation['stage']);
  }
  ports.store.conversations.patch(conversationId, patch);
  return { ...conversation, ...patch };
}

/** Rouvrir un entretien : la seule transition autorisée depuis `closed`. */
export function reopenConversation(ports: ConversationPorts, conversationId: string): Conversation {
  const conversation = requireConversation(ports, conversationId);
  assertStageTransition(conversation.stage, 'brief_ready');
  const reopened: Conversation = { ...conversation, stage: 'brief_ready', closedAt: null };
  ports.store.conversations.patch(conversationId, {
    stage: 'brief_ready',
    closedAt: null,
    updatedAt: ports.clock.nowMs(),
  });
  return refreshProgress(ports, reopened);
}

// --- Fiche maître (docs/03 §8.1) -------------------------------------------

export interface BriefDetail {
  brief: MasterBrief;
  /** Ce qui reste « à compléter » : l'interface l'affiche, l'intervieweur le redemande. */
  missing: string[];
  /** Historique complet, du plus ancien au plus récent : une version ne disparaît pas. */
  history: MasterBrief[];
}

export function getMasterBrief(ports: ConversationPorts, briefId: string): MasterBrief {
  return requireBrief(ports, briefId);
}

export function briefDetail(ports: ConversationPorts, briefId: string): BriefDetail {
  const brief = requireBrief(ports, briefId);
  return {
    brief,
    missing: briefGaps(brief),
    history: ports.store.briefs.list(brief.conversationId),
  };
}

export function listMasterBriefs(ports: ConversationPorts, conversationId: string): MasterBrief[] {
  requireConversation(ports, conversationId);
  return ports.store.briefs.list(conversationId);
}

/** Fiche courante d'un projet : ce que les étapes suivantes consommeront. */
export function currentBrief(ports: ConversationPorts, projectId: string): MasterBrief | undefined {
  return ports.store.briefs.current(projectId);
}

/**
 * Une fiche maître ne se génère pas sur du vide : sans positionnement ni public,
 * le modèle produirait des généralités. Le refus est **explicite** et nomme ce
 * qui manque (`ProjectNotReadyError`), plutôt que de renvoyer une fiche creuse
 * que l'utilisateur croirait complète.
 */
export function assertBriefGenerationReady(conversation: Conversation): void {
  const slots = readSlots(conversation);
  const blocking: ConversationSlot[] = slots.filter(
    (slot) => slot === 'positioning' || slot === 'audience',
  );
  if (blocking.length > 0) {
    throw new ProjectNotReadyError(conversation.projectId, blocking);
  }
}

export interface CreateMasterBriefParams {
  llmCallId: string | null;
  /** Messages ayant servi de matière : la traçabilité de la fiche. */
  sourceMessageIds: string[];
}

/**
 * Enregistre une fiche maître produite par le `strategist`. C'est une
 * **nouvelle version** : la précédente passe en `superseded` et pointe vers
 * celle-ci, dans la même transaction (docs/03 §8.1).
 */
export function createMasterBrief(
  ports: ConversationPorts,
  conversationId: string,
  content: MasterBriefContent,
  params: CreateMasterBriefParams,
): MasterBrief {
  const conversation = requireConversation(ports, conversationId);
  assertBriefGenerationReady(conversation);

  const previous = ports.store.briefs.latest(conversationId);
  const version = previous ? previous.version + 1 : 1;
  const record = buildBriefRecord(
    ports,
    {
      projectId: conversation.projectId,
      conversationId,
      llmCallId: params.llmCallId,
      sourceMessageIds: params.sourceMessageIds,
      version,
    },
    content,
  );

  return ports.store.transaction(() => {
    ports.store.briefs.insert(record);
    if (previous) {
      const patch = planBriefSupersession(previous, record.id, ports.clock.nowMs());
      ports.store.briefs.patch(previous.id, patch);
    }
    if (conversation.stage !== 'brief_ready') {
      ports.store.conversations.patch(conversationId, {
        stage: 'brief_ready',
        updatedAt: ports.clock.nowMs(),
      });
    }
    return record;
  });
}

/** Corriger la fiche = créer une version. L'ancienne reste lisible, intacte. */
export function updateMasterBrief(
  ports: ConversationPorts,
  briefId: string,
  edits: BriefEditInput,
): MasterBrief {
  const previous = requireBrief(ports, briefId);
  const next = nextBriefVersion(ports, previous, edits);

  return ports.store.transaction(() => {
    ports.store.briefs.insert(next);
    ports.store.briefs.patch(
      previous.id,
      planBriefSupersession(previous, next.id, ports.clock.nowMs()),
    );
    return next;
  });
}

/**
 * Valider la fiche : un acte humain, daté, qui fait autorité — et qui met à jour
 * le positionnement du projet, puisque la fiche est la synthèse de l'entretien.
 */
export function validateMasterBrief(ports: ConversationPorts, briefId: string): MasterBrief {
  const brief = requireBrief(ports, briefId);
  const patch = planBriefValidation(brief, ports.clock.nowMs());

  return ports.store.transaction(() => {
    ports.store.briefs.patch(brief.id, patch);
    const validated: MasterBrief = { ...brief, ...patch };
    applyBriefToProject(ports, validated);
    return validated;
  });
}
