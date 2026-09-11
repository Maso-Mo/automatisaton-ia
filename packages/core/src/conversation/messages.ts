import type { MessageInputMode, MessageRole, MessageType } from '@aia/shared';
import type { Conversation, ConversationSummary, Message } from './types';

/**
 * Messages et **fenêtre de contexte** (docs/03 §7.2, §7.4 ; docs/05 §3.4).
 *
 * La règle qui borne le coût d'un entretien : on n'envoie **jamais** toute la
 * conversation au modèle. On envoie les 10 derniers messages verbatim, plus les
 * résumés des blocs de 20 déjà couverts, plus la mémoire structurée. Un
 * entretien de 80 messages ne coûte donc pas huit fois plus cher qu'un entretien
 * de 10.
 */

/** Nombre de messages envoyés verbatim (docs/03 §6.6, ligne 6 : « 10 messages »). */
export const CONVERSATION_WINDOW_MESSAGES = 10;

/** Taille d'un bloc couvert par un résumé (docs/03 §7.4). */
export const SUMMARY_BLOCK_SIZE = 20;

/** Le titre n'est proposé qu'après quelques échanges : avant, il n'a aucun sens. */
export const TITLE_AFTER_MESSAGES = 3;

export interface MessageInput {
  conversationId: string;
  role: MessageRole;
  content?: string | null;
  contentJson?: unknown;
  messageType?: MessageType;
  agent?: string | null;
  inputMode?: MessageInputMode | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costMicroUsd?: number;
  llmCallId?: string | null;
  parentMessageId?: string | null;
}

/** Fabrique un message complet. Le domaine remplit tout : aucun champ implicite. */
export function buildMessage(
  ports: { newId(): string; clock: { nowMs(): number } },
  input: MessageInput,
): Message {
  const now = ports.clock.nowMs();
  return {
    id: ports.newId(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content ?? null,
    contentJson: input.contentJson ?? null,
    messageType: input.messageType ?? 'text',
    agent: input.agent ?? null,
    inputMode: input.inputMode ?? null,
    audioAssetId: null,
    transcriptStatus: null,
    tokensIn: input.tokensIn ?? null,
    tokensOut: input.tokensOut ?? null,
    costMicroUsd: input.costMicroUsd ?? 0,
    llmCallId: input.llmCallId ?? null,
    parentMessageId: input.parentMessageId ?? null,
    createdAt: now,
    editedAt: null,
    deletedAt: null,
  };
}

export interface ConversationWindow {
  /** Messages envoyés au modèle tels quels, du plus ancien au plus récent. */
  verbatim: Message[];
  /** Messages antérieurs, couverts par un résumé : jamais renvoyés verbatim. */
  summarizedCount: number;
  summaries: ConversationSummary[];
}

/**
 * Fenêtre glissante : les `CONVERSATION_WINDOW_MESSAGES` derniers messages
 * **visibles** (un message marqué supprimé reste en base pour l'audit, mais ne
 * part pas chez le fournisseur), plus les résumés existants.
 */
export function buildConversationWindow(
  messages: readonly Message[],
  summaries: readonly ConversationSummary[] = [],
): ConversationWindow {
  const visible = messages.filter((message) => message.deletedAt === null);
  const verbatim = visible.slice(-CONVERSATION_WINDOW_MESSAGES);
  return {
    verbatim,
    summarizedCount: Math.max(0, visible.length - verbatim.length),
    summaries: [...summaries].sort((a, b) => a.fromMessageIndex - b.fromMessageIndex),
  };
}

/**
 * Le prochain bloc de 20 messages n'est pas encore résumé ? Un résumé par bloc,
 * jamais un résumé par message : le résumé coûte un appel, il doit en économiser
 * beaucoup plus qu'il n'en coûte.
 */
export function nextSummaryBlock(
  messageCount: number,
  summaries: readonly ConversationSummary[],
): { fromMessageIndex: number; toMessageIndex: number } | undefined {
  const covered = summaries.reduce((max, item) => Math.max(max, item.toMessageIndex), 0);
  if (messageCount - covered < SUMMARY_BLOCK_SIZE) return undefined;
  return { fromMessageIndex: covered, toMessageIndex: covered + SUMMARY_BLOCK_SIZE };
}

/** Titre lisible déduit du premier message : aucune invention, une troncature. */
export function titleFromMessage(message: Pick<Message, 'content'>): string {
  const text = (message.content ?? '').replace(/\s+/g, ' ').trim();
  if (text.length === 0) return 'Entretien de projet';
  return text.length <= 60 ? text : `${text.slice(0, 57).trimEnd()}…`;
}

export function shouldTitleConversation(
  conversation: Pick<Conversation, 'title' | 'messageCount'>,
): boolean {
  return conversation.title === null && conversation.messageCount >= TITLE_AFTER_MESSAGES;
}

/**
 * Un tour doit-il changer de phase, et peut-il ? Rien ne dépend du message
 * assistant : seuls les champs obligatoires réellement en base décident
 * (docs/05 §3.1). Cette fonction ne fait que refuser une transition interdite.
 */
export function isConversationOpen(conversation: Pick<Conversation, 'stage'>): boolean {
  return conversation.stage !== 'closed';
}
