import { and, asc, desc, eq, gte, inArray, isNull, lte, notInArray } from 'drizzle-orm';
import { encodeJson, parseJsonUnknown } from '@aia/shared';
import type {
  AudienceKnowledgeLevel,
  FactCategory,
  FactSource,
  FactVerificationStatus,
  ProjectStatus,
  SentenceLength,
  SkillLearnedHow,
  SkillLevel,
  StyleScope,
  StyleTone,
} from '@aia/shared';
import type { DatabaseHandle } from '../client';
import {
  audienceProfiles,
  projectFacts,
  projects,
  projectSkillFacts,
  styleProfiles,
} from '../schema';
import { ensureLocalOwnerId } from './users';

/**
 * Persistance de la mémoire des projets (docs/03 §5, §6 ; docs/10 §4.2).
 *
 * Deux règles structurantes :
 *
 * 1. **Ce fichier ne décide rien.** Il stocke, filtre et rend des objets. Les
 *    transitions d'état, les validations et la sélection du contexte vivent dans
 *    `@aia/core` : la décision est testable sans base, la base est testable sans
 *    décision.
 * 2. **Aucune suppression.** Il n'existe volontairement aucune fonction
 *    `deleteProject` / `deleteFact` : la mémoire longue ne se supprime pas
 *    (docs/03 §2.6, §16.1), et un déclencheur SQL le refuse de toute façon.
 *
 * Les objets rendus sont en `camelCase` : ils sont **structurellement** ceux du
 * domaine (`@aia/core/src/projects/types.ts`). Le paquet de persistance
 * n'importe donc pas le domaine — la règle « un paquet d'infrastructure ne
 * dépend jamais de `packages/core` » (docs/02 §5) reste tenue, et TypeScript
 * vérifie la compatibilité au point de câblage, dans `apps/api`.
 */

type ProjectRow = typeof projects.$inferSelect;
type FactRow = typeof projectFacts.$inferSelect;

export interface ProjectRecord {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  positioning: string | null;
  status: ProjectStatus;
  targetGoal: string | null;
  startDate: number | null;
  timezone: string | null;
  language: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface ProjectFactRecord {
  id: string;
  projectId: string;
  category: FactCategory;
  statement: string;
  detail: string | null;
  source: FactSource;
  sourceMessageId: string | null;
  verificationStatus: FactVerificationStatus;
  verificationNote: string | null;
  verifiedAt: number | null;
  verifiedByUser: boolean;
  importance: number;
  usedCount: number;
  lastUsedAt: number | null;
  supersedesFactId: string | null;
  supersededByFactId: string | null;
  supersededAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ProjectQueryFilter {
  statuses?: ProjectStatus[];
  /** `false` (défaut) : les projets archivés sont exclus du listage courant. */
  includeArchived?: boolean;
  limit?: number;
}

export interface FactQueryFilter {
  projectId: string;
  categories?: FactCategory[];
  statuses?: FactVerificationStatus[];
  sinceMs?: number;
  untilMs?: number;
  /** `false` (défaut) : les faits obsolètes et remplacés sont exclus. */
  includeInactive?: boolean;
  limit?: number;
}

export interface ProjectPatchRecord {
  name?: string;
  positioning?: string | null;
  targetGoal?: string | null;
  startDate?: number | null;
  timezone?: string | null;
  language?: string;
  status?: ProjectStatus;
  archivedAt?: number | null;
  updatedAt: number;
}

export interface ProjectFactPatchRecord {
  category?: FactCategory;
  statement?: string;
  detail?: string | null;
  importance?: number;
  verificationStatus?: FactVerificationStatus;
  verificationNote?: string | null;
  verifiedAt?: number | null;
  verifiedByUser?: boolean;
  supersededByFactId?: string | null;
  supersededAt?: number | null;
  updatedAt: number;
}

const DEFAULT_PROJECT_LIMIT = 200;
const MAX_PROJECT_LIMIT = 1_000;
const DEFAULT_FACT_LIMIT = 500;
const MAX_FACT_LIMIT = 2_000;

/**
 * Compétence telle qu'elle est stockée (docs/03 §6.2). Le port du domaine
 * (`@aia/core`) rend ces objets **structurellement** : mêmes noms de champs,
 * aucune dépendance du paquet de persistance vers le domaine (docs/02 §5).
 */
export interface ProjectSkillFactRecord {
  id: string;
  projectId: string;
  skill: string;
  level: SkillLevel;
  evidence: string | null;
  learnedHow: SkillLearnedHow | null;
  isLearning: boolean;
  learningTarget: string | null;
  confidence: number;
  lastUpdatedAt: number;
  createdAt: number;
}

export interface ProjectSkillFactPatchRecord {
  level?: SkillLevel;
  evidence?: string | null;
  learnedHow?: SkillLearnedHow | null;
  isLearning?: boolean;
  learningTarget?: string | null;
  confidence?: number;
  lastUpdatedAt: number;
}

export interface AudienceProfileRecord {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  painPoints: string[];
  goals: string[];
  objections: string[];
  knowledgeLevel: AudienceKnowledgeLevel;
  vocabulary: string[];
  platforms: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StyleProfileRecord {
  id: string;
  projectId: string;
  name: string;
  scope: StyleScope;
  platform: string | null;
  tone: StyleTone | null;
  formality: number;
  sentenceLength: SentenceLength | null;
  humorLevel: number;
  emojiLevel: number;
  forbiddenWords: string[];
  signatureOpenings: string[];
  signatureClosings: string[];
  exampleParagraphs: string[];
  derivedFromTexts: number;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

const INACTIVE_FACT_STATUSES: FactVerificationStatus[] = ['obsolete', 'superseded'];

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    slug: row.slug,
    positioning: row.positioning,
    status: row.status as ProjectStatus,
    targetGoal: row.target_goal,
    startDate: row.start_date,
    timezone: row.timezone,
    language: row.language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toFact(row: FactRow): ProjectFactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    category: row.category as FactCategory,
    statement: row.statement,
    detail: row.detail,
    source: row.source as FactSource,
    sourceMessageId: row.source_message_id,
    verificationStatus: row.verification_status as FactVerificationStatus,
    verificationNote: row.verification_note,
    verifiedAt: row.verified_at,
    verifiedByUser: row.verified_by_user,
    importance: row.importance,
    usedCount: row.used_count,
    lastUsedAt: row.last_used_at,
    supersedesFactId: row.supersedes_fact_id,
    supersededByFactId: row.superseded_by_fact_id,
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(Math.max(value, 1), max);
}

type SkillFactRow = typeof projectSkillFacts.$inferSelect;

function toSkillFact(row: SkillFactRow): ProjectSkillFactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    skill: row.skill,
    level: row.level as SkillLevel,
    evidence: row.evidence,
    learnedHow: (row.learned_how ?? null) as SkillLearnedHow | null,
    isLearning: row.is_learning,
    learningTarget: row.learning_target,
    confidence: row.confidence,
    lastUpdatedAt: row.last_updated_at,
    createdAt: row.created_at,
  };
}

type AudienceProfileRow = typeof audienceProfiles.$inferSelect;
type StyleProfileRow = typeof styleProfiles.$inferSelect;

/** Colonnes `_json` de listes de chaînes : décodées avec repli sur `[]`. */
function decodeStringList(raw: string | null): string[] {
  if (raw === null) return [];
  const parsed = parseJsonUnknown(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  return parsed.value.filter((item): item is string => typeof item === 'string');
}

function toAudienceProfile(row: AudienceProfileRow): AudienceProfileRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    painPoints: decodeStringList(row.pain_points_json),
    goals: decodeStringList(row.goals_json),
    objections: decodeStringList(row.objections_json),
    knowledgeLevel: row.knowledge_level as AudienceKnowledgeLevel,
    vocabulary: decodeStringList(row.vocabulary_json),
    platforms: decodeStringList(row.platforms_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStyleProfile(row: StyleProfileRow): StyleProfileRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    scope: row.scope as StyleScope,
    platform: row.platform,
    tone: (row.tone ?? null) as StyleTone | null,
    formality: row.formality,
    sentenceLength: (row.sentence_length ?? null) as SentenceLength | null,
    humorLevel: row.humor_level,
    emojiLevel: row.emoji_level,
    forbiddenWords: decodeStringList(row.forbidden_words_json),
    signatureOpenings: decodeStringList(row.signature_openings_json),
    signatureClosings: decodeStringList(row.signature_closings_json),
    exampleParagraphs: decodeStringList(row.example_paragraphs_json),
    derivedFromTexts: row.derived_from_texts,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ProjectMemoryStoreOptions {
  /** Horloge injectée : jamais de `Date.now()` implicite (docs/09 §1.1). */
  nowMs(): number;
  /** Propriétaire courant (injectable pour les tests). */
  ownerId?(): string;
}

export interface ProjectMemoryStoreImpl {
  projects: {
    insert(record: ProjectRecord): void;
    patch(id: string, patch: ProjectPatchRecord): number;
    byId(id: string): ProjectRecord | undefined;
    bySlug(slug: string): ProjectRecord | undefined;
    list(filter?: ProjectQueryFilter): ProjectRecord[];
  };
  facts: {
    insert(record: ProjectFactRecord): void;
    patch(id: string, patch: ProjectFactPatchRecord): number;
    byId(id: string): ProjectFactRecord | undefined;
    list(filter: FactQueryFilter): ProjectFactRecord[];
  };
  skillFacts: {
    insert(record: ProjectSkillFactRecord): void;
    patch(id: string, patch: ProjectSkillFactPatchRecord): number;
    byId(id: string): ProjectSkillFactRecord | undefined;
    list(projectId: string): ProjectSkillFactRecord[];
    byProjectAndSkill(projectId: string, skill: string): ProjectSkillFactRecord | undefined;
  };
  audienceProfiles: {
    insert(record: AudienceProfileRecord): void;
    byId(id: string): AudienceProfileRecord | undefined;
    list(projectId: string): AudienceProfileRecord[];
  };
  styleProfiles: {
    insert(record: StyleProfileRecord): void;
    byId(id: string): StyleProfileRecord | undefined;
    list(projectId: string): StyleProfileRecord[];
  };
  owner: {
    currentId(): string;
  };
  transaction<T>(operation: () => T): T;
}

export function createProjectMemoryStore(
  handle: DatabaseHandle,
  options: ProjectMemoryStoreOptions,
): ProjectMemoryStoreImpl {
  let cachedOwnerId: string | null = null;
  const currentOwnerId = (): string => {
    if (cachedOwnerId !== null) return cachedOwnerId;
    cachedOwnerId = options.ownerId?.() ?? ensureLocalOwnerId(handle, options.nowMs());
    return cachedOwnerId;
  };

  return {
    projects: {
      insert: (record) => {
        handle.db
          .insert(projects)
          .values({
            id: record.id,
            owner_id: record.ownerId,
            name: record.name,
            slug: record.slug,
            positioning: record.positioning,
            status: record.status,
            target_goal: record.targetGoal,
            start_date: record.startDate,
            timezone: record.timezone,
            language: record.language,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            archived_at: record.archivedAt,
          })
          .run();
      },
      patch: (id, patch) => {
        const set: Partial<typeof projects.$inferInsert> = { updated_at: patch.updatedAt };
        if (patch.name !== undefined) set.name = patch.name;
        if (patch.positioning !== undefined) set.positioning = patch.positioning;
        if (patch.targetGoal !== undefined) set.target_goal = patch.targetGoal;
        if (patch.startDate !== undefined) set.start_date = patch.startDate;
        if (patch.timezone !== undefined) set.timezone = patch.timezone;
        if (patch.language !== undefined) set.language = patch.language;
        if (patch.status !== undefined) set.status = patch.status;
        if (patch.archivedAt !== undefined) set.archived_at = patch.archivedAt;
        return handle.db.update(projects).set(set).where(eq(projects.id, id)).run().changes;
      },
      byId: (id) => {
        const row = handle.db.select().from(projects).where(eq(projects.id, id)).get();
        return row ? toProject(row) : undefined;
      },
      bySlug: (slug) => {
        const row = handle.db.select().from(projects).where(eq(projects.slug, slug)).get();
        return row ? toProject(row) : undefined;
      },
      list: (filter = {}) => {
        const conditions = [];
        if (filter.statuses && filter.statuses.length > 0) {
          conditions.push(inArray(projects.status, filter.statuses));
        } else if (filter.includeArchived !== true) {
          conditions.push(notInArray(projects.status, ['archived']));
        }
        const base = handle.db
          .select()
          .from(projects)
          .orderBy(desc(projects.updated_at), asc(projects.created_at), asc(projects.id));
        const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
        return filtered
          .limit(clampLimit(filter.limit, DEFAULT_PROJECT_LIMIT, MAX_PROJECT_LIMIT))
          .all()
          .map(toProject);
      },
    },
    facts: {
      insert: (record) => {
        handle.db
          .insert(projectFacts)
          .values({
            id: record.id,
            project_id: record.projectId,
            category: record.category,
            statement: record.statement,
            detail: record.detail,
            source: record.source,
            source_message_id: record.sourceMessageId,
            verification_status: record.verificationStatus,
            verification_note: record.verificationNote,
            verified_at: record.verifiedAt,
            verified_by_user: record.verifiedByUser,
            supersedes_fact_id: record.supersedesFactId,
            superseded_by_fact_id: record.supersededByFactId,
            superseded_at: record.supersededAt,
            importance: record.importance,
            used_count: record.usedCount,
            last_used_at: record.lastUsedAt,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
            deleted_at: record.deletedAt,
          })
          .run();
      },
      patch: (id, patch) => {
        const set: Partial<typeof projectFacts.$inferInsert> = { updated_at: patch.updatedAt };
        if (patch.category !== undefined) set.category = patch.category;
        if (patch.statement !== undefined) set.statement = patch.statement;
        if (patch.detail !== undefined) set.detail = patch.detail;
        if (patch.importance !== undefined) set.importance = patch.importance;
        if (patch.verificationStatus !== undefined)
          set.verification_status = patch.verificationStatus;
        if (patch.verificationNote !== undefined) set.verification_note = patch.verificationNote;
        if (patch.verifiedAt !== undefined) set.verified_at = patch.verifiedAt;
        if (patch.verifiedByUser !== undefined) set.verified_by_user = patch.verifiedByUser;
        if (patch.supersededByFactId !== undefined)
          set.superseded_by_fact_id = patch.supersededByFactId;
        if (patch.supersededAt !== undefined) set.superseded_at = patch.supersededAt;
        return handle.db.update(projectFacts).set(set).where(eq(projectFacts.id, id)).run().changes;
      },
      byId: (id) => {
        const row = handle.db.select().from(projectFacts).where(eq(projectFacts.id, id)).get();
        return row ? toFact(row) : undefined;
      },
      list: (filter) => {
        // `deleted_at` n'est jamais écrit par la mémoire : la colonne reste le
        // filet de sécurité documenté (docs/03 §2.6), et un fait « oublié »
        // n'apparaît pas dans les listages.
        const conditions = [
          eq(projectFacts.project_id, filter.projectId),
          isNull(projectFacts.deleted_at),
        ];
        if (filter.categories && filter.categories.length > 0) {
          conditions.push(inArray(projectFacts.category, filter.categories));
        }
        if (filter.statuses && filter.statuses.length > 0) {
          conditions.push(inArray(projectFacts.verification_status, filter.statuses));
        } else if (filter.includeInactive !== true) {
          conditions.push(notInArray(projectFacts.verification_status, INACTIVE_FACT_STATUSES));
        }
        if (filter.sinceMs !== undefined) {
          conditions.push(gte(projectFacts.created_at, filter.sinceMs));
        }
        if (filter.untilMs !== undefined) {
          conditions.push(lte(projectFacts.created_at, filter.untilMs));
        }

        return handle.db
          .select()
          .from(projectFacts)
          .where(and(...conditions))
          .orderBy(desc(projectFacts.created_at), asc(projectFacts.id))
          .limit(clampLimit(filter.limit, DEFAULT_FACT_LIMIT, MAX_FACT_LIMIT))
          .all()
          .map(toFact);
      },
    },
    skillFacts: {
      insert: (record) => {
        handle.db
          .insert(projectSkillFacts)
          .values({
            id: record.id,
            project_id: record.projectId,
            skill: record.skill,
            level: record.level,
            evidence: record.evidence,
            learned_how: record.learnedHow,
            is_learning: record.isLearning,
            learning_target: record.learningTarget,
            confidence: record.confidence,
            last_updated_at: record.lastUpdatedAt,
            created_at: record.createdAt,
          })
          .run();
      },
      patch: (id, patch) => {
        const set: Partial<typeof projectSkillFacts.$inferInsert> = {
          last_updated_at: patch.lastUpdatedAt,
        };
        if (patch.level !== undefined) set.level = patch.level;
        if (patch.evidence !== undefined) set.evidence = patch.evidence;
        if (patch.learnedHow !== undefined) set.learned_how = patch.learnedHow;
        if (patch.isLearning !== undefined) set.is_learning = patch.isLearning;
        if (patch.learningTarget !== undefined) set.learning_target = patch.learningTarget;
        if (patch.confidence !== undefined) set.confidence = patch.confidence;
        return handle.db
          .update(projectSkillFacts)
          .set(set)
          .where(eq(projectSkillFacts.id, id))
          .run().changes;
      },
      byId: (id) => {
        const row = handle.db
          .select()
          .from(projectSkillFacts)
          .where(eq(projectSkillFacts.id, id))
          .get();
        return row ? toSkillFact(row) : undefined;
      },
      list: (projectId) =>
        handle.db
          .select()
          .from(projectSkillFacts)
          .where(eq(projectSkillFacts.project_id, projectId))
          .orderBy(asc(projectSkillFacts.skill))
          .all()
          .map(toSkillFact),
      byProjectAndSkill: (projectId, skill) => {
        const row = handle.db
          .select()
          .from(projectSkillFacts)
          .where(
            and(eq(projectSkillFacts.project_id, projectId), eq(projectSkillFacts.skill, skill)),
          )
          .get();
        return row ? toSkillFact(row) : undefined;
      },
    },
    audienceProfiles: {
      insert: (record) => {
        handle.db
          .insert(audienceProfiles)
          .values({
            id: record.id,
            project_id: record.projectId,
            name: record.name,
            description: record.description,
            pain_points_json: encodeJson(record.painPoints),
            goals_json: encodeJson(record.goals),
            objections_json: encodeJson(record.objections),
            knowledge_level: record.knowledgeLevel,
            vocabulary_json: encodeJson(record.vocabulary),
            platforms_json: encodeJson(record.platforms),
            created_at: record.createdAt,
            updated_at: record.updatedAt,
          })
          .run();
      },
      byId: (id) => {
        const row = handle.db
          .select()
          .from(audienceProfiles)
          .where(eq(audienceProfiles.id, id))
          .get();
        return row ? toAudienceProfile(row) : undefined;
      },
      list: (projectId) =>
        handle.db
          .select()
          .from(audienceProfiles)
          .where(eq(audienceProfiles.project_id, projectId))
          .orderBy(asc(audienceProfiles.created_at))
          .all()
          .map(toAudienceProfile),
    },
    styleProfiles: {
      insert: (record) => {
        handle.db
          .insert(styleProfiles)
          .values({
            id: record.id,
            project_id: record.projectId,
            name: record.name,
            scope: record.scope,
            platform: record.platform,
            tone: record.tone,
            formality: record.formality,
            sentence_length: record.sentenceLength,
            humor_level: record.humorLevel,
            emoji_level: record.emojiLevel,
            forbidden_words_json: encodeJson(record.forbiddenWords),
            signature_openings_json: encodeJson(record.signatureOpenings),
            signature_closings_json: encodeJson(record.signatureClosings),
            example_paragraphs_json: encodeJson(record.exampleParagraphs),
            derived_from_texts: record.derivedFromTexts,
            confidence: record.confidence,
            created_at: record.createdAt,
            updated_at: record.updatedAt,
          })
          .run();
      },
      byId: (id) => {
        const row = handle.db.select().from(styleProfiles).where(eq(styleProfiles.id, id)).get();
        return row ? toStyleProfile(row) : undefined;
      },
      list: (projectId) =>
        handle.db
          .select()
          .from(styleProfiles)
          .where(eq(styleProfiles.project_id, projectId))
          .orderBy(asc(styleProfiles.created_at))
          .all()
          .map(toStyleProfile),
    },
    owner: { currentId: currentOwnerId },
    /**
     * `better-sqlite3` est synchrone et mono-connexion : les écritures faites
     * dans le callback passent par la même connexion, donc dans la transaction.
     * C'est ce qui rend le remplacement d'un fait atomique (deux lignes).
     */
    transaction: (operation) => handle.db.transaction(() => operation)(),
  };
}
