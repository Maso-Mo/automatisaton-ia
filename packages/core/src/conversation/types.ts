import type {
  Clock,
  ConversationKind,
  ConversationStage,
  ConversationSummaryScope,
  MasterBriefStatus,
  MessageInputMode,
  MessageRole,
  MessageType,
  PlatformId,
  SkillLevel,
} from '@aia/shared';
import type { ProjectMemoryPorts, ProjectMemoryStore } from '../projects/types';
import type { ConversationSlot } from './stages';

/**
 * Domaine « conversation » — étape 3 : discuter par **texte** avec l'assistant à
 * propos d'un projet, et construire progressivement la **fiche maître**
 * (docs/10 §4.2, docs/03 §7 et §8.1, docs/05 §3).
 *
 * Deux invariants structurent ces types :
 *
 * 1. **Le modèle propose, le domaine dispose.** Rien de ce qui sort d'un modèle
 *    n'écrit directement en base : `extracted_facts` devient une proposition que
 *    l'utilisateur valide (docs/05 §3.2, étape 8).
 * 2. **L'état de la conversation est explicite.** `stage` et `missingSlots` sont
 *    des colonnes, pas une inférence : une conversation interrompue reprend
 *    exactement au bon endroit (docs/03 §7.1).
 *
 * Comme pour les projets, ces types sont indépendants de la base : le paquet de
 * persistance les produit **structurellement** (mêmes noms de champs) sans
 * importer le domaine (docs/02 §5).
 */

export interface Conversation {
  id: string;
  projectId: string;
  title: string | null;
  kind: ConversationKind;
  stage: ConversationStage;
  /** Ce qui manque encore à la mémoire : la liste qui pilote les questions. */
  missingSlots: ConversationSlot[];
  modelUsed: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface ConversationPatch {
  title?: string | null;
  kind?: ConversationKind;
  stage?: ConversationStage;
  missingSlots?: ConversationSlot[];
  modelUsed?: string | null;
  messageCount?: number;
  lastMessageAt?: number | null;
  closedAt?: number | null;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string | null;
  /**
   * Message structuré : question à options, proposition de faits, erreur. C'est
   * ce que l'interface affiche en plus du texte (docs/03 §7.2).
   */
  contentJson: unknown;
  messageType: MessageType;
  agent: string | null;
  inputMode: MessageInputMode | null;
  audioAssetId: string | null;
  transcriptStatus: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costMicroUsd: number;
  llmCallId: string | null;
  parentMessageId: string | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

export interface MessagePatch {
  content?: string | null;
  contentJson?: unknown;
  messageType?: MessageType;
  editedAt?: number | null;
  deletedAt?: number | null;
}

/** Résumé par paliers : un résumé couvre 20 messages (docs/03 §7.4). */
export interface ConversationSummary {
  id: string;
  conversationId: string;
  scope: ConversationSummaryScope;
  fromMessageIndex: number;
  toMessageIndex: number;
  summary: string;
  decisions: unknown;
  factsExtracted: unknown;
  tokensSavedEstimate: number | null;
  createdAt: number;
}

export interface MasterBrief {
  id: string;
  projectId: string;
  conversationId: string;
  version: number;
  status: MasterBriefStatus;
  summary: string;
  positioning: string;
  targetAudience: string;
  /** 2 à 5 piliers : au-delà, aucun contenu ne s'y rattache vraiment. */
  contentPillars: string[];
  themes: string[];
  formats: { platform: PlatformId; formats: string[] }[] | null;
  skillMap: { skill: string; level: SkillLevel; isLearning: boolean }[] | null;
  /**
   * Ce que l'utilisateur **ne maîtrise pas**. Utilisé en négatif : un sujet qui
   * tombe dans un trou est signalé, jamais présenté comme une expertise
   * (docs/03 §8.1 — « la colonne la plus importante et la plus souvent oubliée »).
   */
  gaps: string[] | null;
  cadence: { platform: PlatformId; perWeek: number }[] | null;
  successCriteria: string[] | null;
  sourceMessageIds: string[];
  llmCallId: string | null;
  validatedAt: number | null;
  supersededById: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MasterBriefPatch {
  status?: MasterBriefStatus;
  validatedAt?: number | null;
  supersededById?: string | null;
  updatedAt: number;
}

/**
 * Photographie de la mémoire d'un projet, réduite à ce dont la conversation a
 * besoin pour calculer ce qui manque (docs/03 §7.1) : compter les profils, les
 * compétences et les faits confirmés. Des requêtes de comptage, aucune IA.
 */
export interface ConversationMemorySnapshot {
  projectId: string;
  projectName: string;
  positioning: string | null;
  targetGoal: string | null;
  verifiedFacts: number;
  skillFacts: number;
  audienceProfiles: number;
  styleProfiles: number;
  goals: number;
}

/** Port de persistance de la conversation : il stocke, il ne décide jamais. */
export interface ConversationStore {
  conversations: {
    insert(record: Conversation): void;
    patch(id: string, patch: ConversationPatch): number;
    byId(id: string): Conversation | undefined;
    byProject(projectId: string, limit?: number): Conversation[];
  };
  messages: {
    insert(record: Message): void;
    patch(id: string, patch: MessagePatch): number;
    byId(id: string): Message | undefined;
    list(conversationId: string, options?: { limit?: number; includeDeleted?: boolean }): Message[];
    count(conversationId: string): number;
  };
  summaries: {
    insert(record: ConversationSummary): void;
    list(conversationId: string): ConversationSummary[];
  };
  briefs: {
    insert(record: MasterBrief): void;
    patch(id: string, patch: MasterBriefPatch): number;
    byId(id: string): MasterBrief | undefined;
    list(conversationId: string): MasterBrief[];
    latest(conversationId: string): MasterBrief | undefined;
    current(projectId: string): MasterBrief | undefined;
  };
  memory: { snapshot(projectId: string): ConversationMemorySnapshot | undefined };
  transaction<T>(operation: () => T): T;
}

export interface ConversationPorts {
  store: ConversationStore;
  /** Mémoire du projet : la conversation lit le contexte, écrit des propositions. */
  memory: ProjectMemoryStore;
  clock: Clock;
  newId(): string;
}

/** Ports à passer aux cas d'usage de la mémoire de projet (réutilisation exacte). */
export function projectMemoryPorts(ports: ConversationPorts): ProjectMemoryPorts {
  return { store: ports.memory, clock: ports.clock, newId: () => ports.newId() };
}
