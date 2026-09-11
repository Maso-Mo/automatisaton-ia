import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import {
  conversationSlotSchema,
  encodeJson,
  parseJsonUnknown,
  platformIdSchema,
  skillLevelSchema,
  type ConversationKind,
  type ConversationSlot,
  type ConversationStage,
  type ConversationSummaryScope,
  type MasterBriefStatus,
  type MessageInputMode,
  type MessageRole,
  type MessageType,
  type PlatformId,
  type SkillLevel,
} from '@aia/shared';
import { z } from 'zod';
import type { DatabaseHandle } from '../client';
import { conversationSummaries, conversations, masterBriefs, messages, projects } from '../schema';

/**
 * Persistance de la conversation et de la fiche maître (docs/03 §7 et §8.1).
 *
 * Ce fichier **ne décide rien** : il stocke, filtre et rend des objets
 * structurellement identiques aux types du domaine (`@aia/core/src/conversation`).
 * Les règles — phases, lacunes, propositions validées par l'utilisateur,
 * immuabilité des fiches — vivent dans le domaine, où elles sont testables sans
 * base.
 *
 * Trois garanties viennent de la **base** et non d'ici (docs/03 §15.1) :
 * `trg_messages_no_delete`, `trg_master_briefs_frozen_when_validated` et
 * `trg_master_briefs_superseded_is_terminal`. Une écriture SQL directe les
 * respecte aussi.
 */

export interface ConversationRecord {
  id: string;
  projectId: string;
  title: string | null;
  kind: ConversationKind;
  stage: ConversationStage;
  missingSlots: ConversationSlot[];
  modelUsed: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface ConversationPatchRecord {
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

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string | null;
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

export interface MessagePatchRecord {
  content?: string | null;
  contentJson?: unknown;
  messageType?: MessageType;
  editedAt?: number | null;
  deletedAt?: number | null;
}

export interface ConversationSummaryRecord {
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

export interface MasterBriefRecord {
  id: string;
  projectId: string;
  conversationId: string;
  version: number;
  status: MasterBriefStatus;
  summary: string;
  positioning: string;
  targetAudience: string;
  contentPillars: string[];
  themes: string[];
  formats: { platform: PlatformId; formats: string[] }[] | null;
  skillMap: { skill: string; level: SkillLevel; isLearning: boolean }[] | null;
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

export interface MasterBriefPatchRecord {
  status?: MasterBriefStatus;
  validatedAt?: number | null;
  supersededById?: string | null;
  updatedAt: number;
}

export interface ConversationMemorySnapshotRecord {
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

const stringArraySchema = z.array(z.string());
const platformFormatsSchema = z.array(
  z.object({ platform: platformIdSchema, formats: z.array(z.string()) }),
);
const skillMapSchema = z.array(
  z.object({ skill: z.string(), level: skillLevelSchema, isLearning: z.boolean() }),
);
const cadenceSchema = z.array(z.object({ platform: platformIdSchema, perWeek: z.number() }));

/**
 * Lecture d'une colonne `_json` : jamais d'exception, jamais de valeur inventée.
 * Une colonne illisible devient `fallback` : le produit continue de fonctionner,
 * et l'anomalie reste visible en base (docs/03 §2.5).
 */
function decodeJsonColumn<T>(raw: string | null, schema: z.ZodType<T>, fallback: T): T {
  if (raw === null) return fallback;
  const parsed = parseJsonUnknown(raw);
  if (!parsed.ok) return fallback;
  const result = schema.safeParse(parsed.value);
  return result.success ? result.data : fallback;
}

const DEFAULT_CONVERSATION_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 500;
const DEFAULT_MESSAGE_LIMIT = 2_000;

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(Math.max(value, 1), max);
}

type ConversationRow = typeof conversations.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type SummaryRow = typeof conversationSummaries.$inferSelect;
type BriefRow = typeof masterBriefs.$inferSelect;

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    kind: row.kind as ConversationKind,
    stage: row.stage as ConversationStage,
    missingSlots: decodeJsonColumn(row.missing_slots_json, z.array(conversationSlotSchema), []),
    modelUsed: row.model_used,
    messageCount: row.message_count,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    content: row.content,
    contentJson: row.content_json === null ? null : parseColumn(row.content_json),
    messageType: row.message_type as MessageType,
    agent: row.agent,
    inputMode: (row.input_mode ?? null) as MessageInputMode | null,
    audioAssetId: row.audio_asset_id,
    transcriptStatus: row.transcript_status,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costMicroUsd: row.cost_micro_usd,
    llmCallId: row.llm_call_id,
    parentMessageId: row.parent_message_id,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  };
}

function parseColumn(raw: string): unknown {
  const parsed = parseJsonUnknown(raw);
  return parsed.ok ? parsed.value : null;
}

function toSummary(row: SummaryRow): ConversationSummaryRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    scope: row.scope as ConversationSummaryScope,
    fromMessageIndex: row.from_message_index,
    toMessageIndex: row.to_message_index,
    summary: row.summary,
    decisions: row.decisions_json === null ? null : parseColumn(row.decisions_json),
    factsExtracted:
      row.facts_extracted_json === null ? null : parseColumn(row.facts_extracted_json),
    tokensSavedEstimate: row.tokens_saved_estimate,
    createdAt: row.created_at,
  };
}

function toBrief(row: BriefRow): MasterBriefRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    version: row.version,
    status: row.status as MasterBriefStatus,
    summary: row.summary,
    positioning: row.positioning,
    targetAudience: row.target_audience,
    contentPillars: decodeJsonColumn(row.content_pillars_json, stringArraySchema, []),
    themes: decodeJsonColumn(row.themes_json, stringArraySchema, []),
    formats: decodeJsonColumn(row.formats_json, platformFormatsSchema, null),
    skillMap: decodeJsonColumn(row.skill_map_json, skillMapSchema, null),
    gaps: decodeJsonColumn(row.gaps_json, stringArraySchema, null),
    cadence: decodeJsonColumn(row.cadence_json, cadenceSchema, null),
    successCriteria: decodeJsonColumn(row.success_criteria_json, stringArraySchema, null),
    sourceMessageIds: decodeJsonColumn(row.source_message_ids_json, stringArraySchema, []),
    llmCallId: row.llm_call_id,
    validatedAt: row.validated_at,
    supersededById: row.superseded_by_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ConversationStoreOptions {
  /** Horloge injectée : jamais de `Date.now()` implicite (docs/09 §1.1). */
  nowMs(): number;
}

export function createConversationStore(
  handle: DatabaseHandle,
  _options: ConversationStoreOptions,
) {
  const countRows = (query: string, projectId: string): number => {
    const row = handle.sqlite.prepare(query).get(projectId) as { count: number } | undefined;
    return row?.count ?? 0;
  };

  return {
    conversations: {
      insert: (record: ConversationRecord): void => {
        handle.db
          .insert(conversations)
          .values({
            id: record.id,
            project_id: record.projectId,
            title: record.title,
            kind: record.kind,
            stage: record.stage,
            missing_slots_json: encodeJson(record.missingSlots),
            model_used: record.modelUsed,
            message_count: record.messageCount,
            last_message_at: record.lastMessageAt,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            closed_at: record.closedAt,
          })
          .run();
      },
      patch: (id: string, patch: ConversationPatchRecord): number => {
        const set: Partial<typeof conversations.$inferInsert> = { updated_at: patch.updatedAt };
        if (patch.title !== undefined) set.title = patch.title;
        if (patch.kind !== undefined) set.kind = patch.kind;
        if (patch.stage !== undefined) set.stage = patch.stage;
        if (patch.missingSlots !== undefined) {
          set.missing_slots_json = encodeJson(patch.missingSlots);
        }
        if (patch.modelUsed !== undefined) set.model_used = patch.modelUsed;
        if (patch.messageCount !== undefined) set.message_count = patch.messageCount;
        if (patch.lastMessageAt !== undefined) set.last_message_at = patch.lastMessageAt;
        if (patch.closedAt !== undefined) set.closed_at = patch.closedAt;
        return handle.db.update(conversations).set(set).where(eq(conversations.id, id)).run()
          .changes;
      },
      byId: (id: string): ConversationRecord | undefined => {
        const row = handle.db.select().from(conversations).where(eq(conversations.id, id)).get();
        return row ? toConversation(row) : undefined;
      },
      byProject: (projectId: string, limit?: number): ConversationRecord[] =>
        handle.db
          .select()
          .from(conversations)
          .where(eq(conversations.project_id, projectId))
          .orderBy(desc(conversations.created_at), asc(conversations.id))
          .limit(clampLimit(limit, DEFAULT_CONVERSATION_LIMIT, MAX_CONVERSATION_LIMIT))
          .all()
          .map(toConversation),
    },
    messages: {
      insert: (record: MessageRecord): void => {
        handle.db
          .insert(messages)
          .values({
            id: record.id,
            conversation_id: record.conversationId,
            role: record.role,
            content: record.content,
            content_json: record.contentJson === null ? null : encodeJson(record.contentJson),
            message_type: record.messageType,
            agent: record.agent,
            input_mode: record.inputMode,
            audio_asset_id: record.audioAssetId,
            transcript_status: record.transcriptStatus,
            tokens_in: record.tokensIn,
            tokens_out: record.tokensOut,
            cost_micro_usd: record.costMicroUsd,
            llm_call_id: record.llmCallId,
            parent_message_id: record.parentMessageId,
            created_at: record.createdAt,
            edited_at: record.editedAt,
            deleted_at: record.deletedAt,
          })
          .run();
      },
      patch: (id: string, patch: MessagePatchRecord): number => {
        const set: Partial<typeof messages.$inferInsert> = {};
        if (patch.content !== undefined) set.content = patch.content;
        if (patch.contentJson !== undefined) set.content_json = encodeJson(patch.contentJson);
        if (patch.messageType !== undefined) set.message_type = patch.messageType;
        if (patch.editedAt !== undefined) set.edited_at = patch.editedAt;
        if (patch.deletedAt !== undefined) set.deleted_at = patch.deletedAt;
        return handle.db.update(messages).set(set).where(eq(messages.id, id)).run().changes;
      },
      byId: (id: string): MessageRecord | undefined => {
        const row = handle.db.select().from(messages).where(eq(messages.id, id)).get();
        return row ? toMessage(row) : undefined;
      },
      list: (
        conversationId: string,
        options: { limit?: number; includeDeleted?: boolean } = {},
      ): MessageRecord[] => {
        const conditions = [eq(messages.conversation_id, conversationId)];
        if (options.includeDeleted !== true) conditions.push(isNull(messages.deleted_at));
        return handle.db
          .select()
          .from(messages)
          .where(and(...conditions))
          .orderBy(asc(messages.created_at), asc(messages.id))
          .limit(clampLimit(options.limit, DEFAULT_MESSAGE_LIMIT, DEFAULT_MESSAGE_LIMIT))
          .all()
          .map(toMessage);
      },
      count: (conversationId: string): number =>
        handle.db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.conversation_id, conversationId), isNull(messages.deleted_at)))
          .all().length,
    },
    summaries: {
      insert: (record: ConversationSummaryRecord): void => {
        handle.db
          .insert(conversationSummaries)
          .values({
            id: record.id,
            conversation_id: record.conversationId,
            scope: record.scope,
            from_message_index: record.fromMessageIndex,
            to_message_index: record.toMessageIndex,
            summary: record.summary,
            decisions_json: record.decisions === null ? null : encodeJson(record.decisions),
            facts_extracted_json:
              record.factsExtracted === null ? null : encodeJson(record.factsExtracted),
            tokens_saved_estimate: record.tokensSavedEstimate,
            created_at: record.createdAt,
          })
          .run();
      },
      list: (conversationId: string): ConversationSummaryRecord[] =>
        handle.db
          .select()
          .from(conversationSummaries)
          .where(eq(conversationSummaries.conversation_id, conversationId))
          .orderBy(asc(conversationSummaries.from_message_index), asc(conversationSummaries.id))
          .all()
          .map(toSummary),
    },
    briefs: {
      insert: (record: MasterBriefRecord): void => {
        handle.db
          .insert(masterBriefs)
          .values({
            id: record.id,
            project_id: record.projectId,
            conversation_id: record.conversationId,
            version: record.version,
            status: record.status,
            summary: record.summary,
            positioning: record.positioning,
            target_audience: record.targetAudience,
            content_pillars_json: encodeJson(record.contentPillars ?? []),
            themes_json: encodeJson(record.themes ?? []),
            formats_json: record.formats === null ? null : encodeJson(record.formats),
            skill_map_json: record.skillMap === null ? null : encodeJson(record.skillMap),
            gaps_json: record.gaps === null ? null : encodeJson(record.gaps),
            cadence_json: record.cadence === null ? null : encodeJson(record.cadence),
            success_criteria_json:
              record.successCriteria === null ? null : encodeJson(record.successCriteria),
            source_message_ids_json: encodeJson(record.sourceMessageIds ?? []),
            llm_call_id: record.llmCallId,
            validated_at: record.validatedAt,
            superseded_by_id: record.supersededById,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
          })
          .run();
      },
      patch: (id: string, patch: MasterBriefPatchRecord): number => {
        const set: Partial<typeof masterBriefs.$inferInsert> = { updated_at: patch.updatedAt };
        if (patch.status !== undefined) set.status = patch.status;
        if (patch.validatedAt !== undefined) set.validated_at = patch.validatedAt;
        if (patch.supersededById !== undefined) set.superseded_by_id = patch.supersededById;
        return handle.db.update(masterBriefs).set(set).where(eq(masterBriefs.id, id)).run().changes;
      },
      byId: (id: string): MasterBriefRecord | undefined => {
        const row = handle.db.select().from(masterBriefs).where(eq(masterBriefs.id, id)).get();
        return row ? toBrief(row) : undefined;
      },
      list: (conversationId: string): MasterBriefRecord[] =>
        handle.db
          .select()
          .from(masterBriefs)
          .where(eq(masterBriefs.conversation_id, conversationId))
          .orderBy(asc(masterBriefs.version))
          .all()
          .map(toBrief),
      latest: (conversationId: string): MasterBriefRecord | undefined => {
        const row = handle.db
          .select()
          .from(masterBriefs)
          .where(eq(masterBriefs.conversation_id, conversationId))
          .orderBy(desc(masterBriefs.version))
          .limit(1)
          .get();
        return row ? toBrief(row) : undefined;
      },
      /** Fiche courante d'un projet : la version vivante la plus haute. */
      current: (projectId: string): MasterBriefRecord | undefined => {
        const row = handle.db
          .select()
          .from(masterBriefs)
          .where(and(eq(masterBriefs.project_id, projectId), ne(masterBriefs.status, 'superseded')))
          .orderBy(desc(masterBriefs.version), desc(masterBriefs.created_at))
          .limit(1)
          .get();
        return row ? toBrief(row) : undefined;
      },
    },
    memory: {
      /**
       * Comptages bruts, **volontairement** en SQL direct : il s'agit de compter
       * des lignes dans cinq tables d'un coup, et le résultat est une
       * photographie, pas une entité. Une requête par table, aucun appel réseau
       * (docs/03 §7.1 : la liste des lacunes ne coûte rien).
       */
      snapshot: (projectId: string): ConversationMemorySnapshotRecord | undefined => {
        const project = handle.db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!project) return undefined;
        return {
          projectId: project.id,
          projectName: project.name,
          positioning: project.positioning,
          targetGoal: project.target_goal,
          verifiedFacts: countRows(
            "select count(*) as count from project_facts where project_id = ? and verification_status = 'verified' and deleted_at is null",
            projectId,
          ),
          skillFacts: countRows(
            'select count(*) as count from project_skill_facts where project_id = ?',
            projectId,
          ),
          audienceProfiles: countRows(
            'select count(*) as count from audience_profiles where project_id = ?',
            projectId,
          ),
          styleProfiles: countRows(
            'select count(*) as count from style_profiles where project_id = ?',
            projectId,
          ),
          goals: countRows(
            "select count(*) as count from project_goals where project_id = ? and status = 'active'",
            projectId,
          ),
        };
      },
    },
    /**
     * Même garantie que pour la mémoire des projets : `better-sqlite3` est
     * synchrone et mono-connexion, donc les écritures du callback passent par la
     * même transaction (accepter une proposition écrit plusieurs lignes).
     */
    transaction: <T>(operation: () => T): T => handle.db.transaction(() => operation)(),
  };
}
