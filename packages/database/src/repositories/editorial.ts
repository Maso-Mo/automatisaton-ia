import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import {
  NotFoundError,
  encodeJson,
  parseJsonUnknown,
  uuidv7,
  contentTargetForPlatformFormat,
  type AngleDifficulty,
  type AngleLength,
  type AngleType,
  type ContentFormat,
  type ContentGeneration,
  type ContentState,
  type ContentTarget,
  type PlatformId,
  type SkillCoverage,
  type SubjectOrigin,
  type SubjectStatus,
} from '@aia/shared';
import type { DatabaseHandle } from '../client';
import {
  contentItems,
  contentReviewNotes,
  contentSubjects,
  contentVersions,
  subjectAngles,
} from '../schema';

/**
 * Persistance de l'éditorial : sujets, angles, contenus versionnés, remarques
 * (docs/03 §8 et §9).
 *
 * Ce fichier **ne décide rien**. La machine à états, l'ancrage factuel, la
 * règle « une écriture = une version » vivent dans `@aia/core/editorial`, où
 * elles se testent sans base. Ici, on stocke et on rend des objets
 * **structurellement** identiques aux types du domaine — jamais un import du
 * domaine (docs/02 §5 : contrat de portabilité).
 *
 * Une colonne mérite une explication, parce qu'elle n'existe pas telle quelle en
 * base : `target`. La table stocke `platform` + `format` (ce que la contrainte
 * SQL peut vérifier), le domaine manipule la **cible** (`linkedin_post`,
 * `youtube_long`…), qui est ce qui décide des limites de longueur et du prompt.
 * La correspondance est faite ici, par `contentTargetForPlatformFormat`, et une
 * ligne dont le couple est inconnu est **ignorée en le disant** plutôt que
 * devinée.
 */

export interface EditorialStoreOptions {
  nowMs: () => number;
  /** Signalement d'une ligne illisible : on continue, mais on le dit. */
  warn?: (message: string) => void;
}

export interface EditorialSubject {
  id: string;
  projectId: string;
  masterBriefId: string | null;
  conversationId: string | null;
  title: string;
  thesis: string;
  pillar: string | null;
  audienceId: string | null;
  origin: SubjectOrigin;
  status: SubjectStatus;
  skillCoverage: SkillCoverage | null;
  evidence: string[];
  priorityScore: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface EditorialAngle {
  id: string;
  subjectId: string;
  platform: string;
  hook: string;
  angleType: AngleType;
  structure: string[];
  audienceId: string | null;
  estimatedLength: AngleLength | null;
  difficulty: AngleDifficulty | null;
  evidence: string[];
  rationale: string | null;
  score: number | null;
  selected: boolean;
  rejectionReason: string | null;
  createdAt: number;
}

export interface EditorialItem {
  id: string;
  projectId: string;
  subjectId: string | null;
  angleId: string | null;
  platform: PlatformId;
  target: ContentTarget;
  format: ContentFormat;
  title: string | null;
  state: ContentState;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  contentHash: string | null;
  aiGenerated: boolean;
  humanEdited: boolean;
  editRatio: number | null;
  regeneratedCount: number;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  scheduledFor: number | null;
  publishedAt: number | null;
  archivedAt: number | null;
}

export interface EditorialVersion {
  id: string;
  contentItemId: string;
  versionNumber: number;
  body: string;
  title: string | null;
  hook: string | null;
  hashtags: string[];
  mentions: string[];
  linkUrl: string | null;
  mediaAssetIds: string[];
  charCount: number | null;
  wordCount: number | null;
  readingTimeSec: number | null;
  generation: ContentGeneration;
  promptVersionHash: string | null;
  llmCallId: string | null;
  modelUsed: string | null;
  temperatureX100: number | null;
  qualityScore: number | null;
  approvedAt: number | null;
  approvedBy: string | null;
  createdAt: number;
}

export interface EditorialNote {
  id: string;
  contentItemId: string;
  contentVersionId: string | null;
  author: string;
  noteType: 'critique' | 'suggestion' | 'erreur' | 'warning' | 'decision';
  severity: 'info' | 'basse' | 'moyenne' | 'haute';
  message: string;
  anchorText: string | null;
  resolved: boolean;
  createdAt: number;
}

export interface NewEditorialAngleInput {
  hook: string;
  angleType: AngleType;
  structure: string[];
  estimatedLength: AngleLength;
  difficulty: AngleDifficulty;
  platformHint: string | null;
  rationale: string;
  evidence: string[];
  score: number;
}

export interface NewEditorialSubjectInput {
  title: string;
  thesis: string;
  pillar: string | null;
  evidence: string[];
  skillCoverage: SkillCoverage;
  priorityScore: number;
  origin: SubjectOrigin;
  masterBriefId: string | null;
  conversationId: string | null;
  angles: NewEditorialAngleInput[];
}

export interface NewEditorialItemInput {
  projectId: string;
  subjectId: string | null;
  angleId: string | null;
  platform: PlatformId;
  target: ContentTarget;
  format: ContentFormat;
  contentHash: string | null;
}

export interface NewEditorialVersionInput {
  contentItemId: string;
  versionNumber: number;
  body: string;
  title: string | null;
  hook: string | null;
  hashtags: string[];
  mentions: string[];
  charCount: number;
  wordCount: number;
  readingTimeSec: number;
  generation: ContentGeneration;
  promptVersionHash: string | null;
  llmCallId: string | null;
  modelUsed: string | null;
  temperatureX100: number | null;
}

export interface NewEditorialNoteInput {
  noteType: EditorialNote['noteType'];
  severity: EditorialNote['severity'];
  message: string;
  anchorText: string | null;
}

export interface EditorialItemPatch {
  title?: string | null;
  state?: ContentState;
  currentVersionId?: string | null;
  approvedVersionId?: string | null;
  contentHash?: string | null;
  humanEdited?: boolean;
  editRatio?: number | null;
  regeneratedCount?: number;
  approvedAt?: number | null;
  archivedAt?: number | null;
}

export interface EditorialSubjectPatch {
  status?: SubjectStatus;
  skillCoverage?: SkillCoverage;
}

// --- Lecture des lignes ---------------------------------------------------

type SubjectRow = typeof contentSubjects.$inferSelect;
type AngleRow = typeof subjectAngles.$inferSelect;
type ItemRow = typeof contentItems.$inferSelect;
type VersionRow = typeof contentVersions.$inferSelect;
type NoteRow = typeof contentReviewNotes.$inferSelect;

/** Colonne `_json` d'un tableau de chaînes : illisible → tableau vide, jamais une exception. */
function decodeStringArray(raw: string | null): string[] {
  if (raw === null) return [];
  const parsed = parseJsonUnknown(raw);
  if (!parsed.ok || !Array.isArray(parsed.value)) return [];
  return parsed.value.filter((entry): entry is string => typeof entry === 'string');
}

function toSubject(row: SubjectRow): EditorialSubject {
  return {
    id: row.id,
    projectId: row.project_id,
    masterBriefId: row.master_brief_id,
    conversationId: row.conversation_id,
    title: row.title,
    thesis: row.thesis,
    pillar: row.pillar,
    audienceId: row.audience_id,
    origin: row.origin as SubjectOrigin,
    status: row.status as SubjectStatus,
    skillCoverage: (row.skill_coverage as SkillCoverage | null) ?? null,
    evidence: decodeStringArray(row.evidence_json),
    priorityScore: row.priority_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toAngle(row: AngleRow): EditorialAngle {
  return {
    id: row.id,
    subjectId: row.subject_id,
    platform: row.platform,
    hook: row.hook,
    angleType: row.angle_type as AngleType,
    structure: decodeStringArray(row.structure_json),
    audienceId: row.audience_id,
    estimatedLength: (row.estimated_length as AngleLength | null) ?? null,
    difficulty: (row.difficulty as AngleDifficulty | null) ?? null,
    evidence: decodeStringArray(row.evidence_json),
    rationale: row.rationale,
    score: row.score,
    selected: row.selected,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
  };
}

function toVersion(row: VersionRow): EditorialVersion {
  return {
    id: row.id,
    contentItemId: row.content_item_id,
    versionNumber: row.version_number,
    body: row.body,
    title: row.title,
    hook: row.hook,
    hashtags: decodeStringArray(row.hashtags_json),
    mentions: decodeStringArray(row.mentions_json),
    linkUrl: row.link_url,
    mediaAssetIds: decodeStringArray(row.media_asset_ids_json),
    charCount: row.char_count,
    wordCount: row.word_count,
    readingTimeSec: row.reading_time_sec,
    generation: row.generation as ContentGeneration,
    promptVersionHash: row.prompt_version_hash,
    llmCallId: row.llm_call_id,
    modelUsed: row.model_used,
    temperatureX100: row.temperature_x100,
    qualityScore: row.quality_score,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    createdAt: row.created_at,
  };
}

function toNote(row: NoteRow): EditorialNote {
  return {
    id: row.id,
    contentItemId: row.content_item_id,
    contentVersionId: row.content_version_id,
    author: row.author,
    noteType: row.note_type as EditorialNote['noteType'],
    severity: row.severity as EditorialNote['severity'],
    message: row.message,
    anchorText: row.anchor_text,
    resolved: row.resolved,
    createdAt: row.created_at,
  };
}

export interface EditorialStoreImpl {
  createPlan(input: { projectId: string; subjects: readonly NewEditorialSubjectInput[] }): {
    subjects: EditorialSubject[];
    angles: EditorialAngle[];
  };
  listSubjects(
    projectId: string,
    filter?: { statuses?: readonly SubjectStatus[] },
  ): EditorialSubject[];
  getSubject(id: string): EditorialSubject | null;
  listAngles(subjectId: string): EditorialAngle[];
  getAngle(id: string): EditorialAngle | null;
  selectAngle(angleId: string): EditorialAngle;
  rejectAngle(angleId: string, reason: string | null): EditorialAngle;
  updateSubject(id: string, patch: EditorialSubjectPatch): EditorialSubject;
  listSubjectTitles(projectId: string): string[];

  createContentItem(input: NewEditorialItemInput): EditorialItem;
  getContentItem(id: string): EditorialItem | null;
  listContentItems(projectId: string, filter?: { state?: ContentState }): EditorialItem[];
  listContentItemsByAngle(angleId: string): EditorialItem[];
  updateContentItem(id: string, patch: EditorialItemPatch): EditorialItem;
  nextVersionNumber(contentItemId: string): number;

  addVersion(input: NewEditorialVersionInput): EditorialVersion;
  getVersion(id: string): EditorialVersion | null;
  listVersions(contentItemId: string): EditorialVersion[];
  approveVersion(versionId: string, approvedBy: string | null): EditorialVersion;

  replaceNotes(
    contentItemId: string,
    contentVersionId: string,
    author: string,
    notes: readonly NewEditorialNoteInput[],
  ): void;
  listNotes(contentItemId: string): EditorialNote[];
}

/**
 * Fabrique du port de persistance éditorial. Elle est **synchrone** de bout en
 * bout : SQLite en local ne justifie pas des promesses qui masqueraient les
 * erreurs d'écriture (docs/02 §4).
 *
 * L'identifiant des sujets et des angles est généré **ici** — et non par le
 * domaine — parce que `NewSubjectRecord` n'en porte pas : un sujet n'existe
 * qu'une fois inséré, et le plan n'a pas à prévoir des identifiants.
 */
export function createEditorialStore(
  handle: DatabaseHandle,
  options: EditorialStoreOptions,
): EditorialStoreImpl {
  const now = (): number => options.nowMs();
  const newId = (): string => uuidv7(now());
  const warn = (message: string): void => options.warn?.(message);

  const subjectOrThrow = (id: string): EditorialSubject => {
    const row = handle.db.select().from(contentSubjects).where(eq(contentSubjects.id, id)).get();
    if (!row) {
      throw new NotFoundError(`Sujet introuvable : ${id}`, {
        code: 'SUBJECT_NOT_FOUND',
        details: { subjectId: id },
      });
    }
    return toSubject(row);
  };

  const angleOrThrow = (id: string): EditorialAngle => {
    const row = handle.db.select().from(subjectAngles).where(eq(subjectAngles.id, id)).get();
    if (!row) {
      throw new NotFoundError(`Angle introuvable : ${id}`, {
        code: 'ANGLE_NOT_FOUND',
        details: { angleId: id },
      });
    }
    return toAngle(row);
  };

  const itemOrThrow = (id: string): EditorialItem => {
    const item = store.getContentItem(id);
    if (!item) {
      throw new NotFoundError(`Contenu introuvable : ${id}`, {
        code: 'CONTENT_NOT_FOUND',
        details: { itemId: id },
      });
    }
    return item;
  };

  const versionOrThrow = (id: string): EditorialVersion => {
    const row = handle.db.select().from(contentVersions).where(eq(contentVersions.id, id)).get();
    if (!row) {
      throw new NotFoundError(`Version introuvable : ${id}`, {
        code: 'CONTENT_VERSION_NOT_FOUND',
        details: { versionId: id },
      });
    }
    return toVersion(row);
  };

  /**
   * Une ligne de `content_items` dont le couple (plateforme, format) n'est pas une
   * cible connue est **écartée** : elle ne peut être ni validée (aucune limite de
   * longueur), ni rédigée (aucun prompt), et la deviner produirait une erreur
   * silencieuse plus tard. On le signale plutôt que de l'ignorer en silence.
   */
  const itemFromRow = (row: ItemRow): EditorialItem | null => {
    const target = contentTargetForPlatformFormat(row.platform, row.format);
    if (!target) {
      warn(
        `content_items ${row.id} : couple (${row.platform}, ${row.format}) sans cible connue — ligne ignorée`,
      );
      return null;
    }
    return {
      id: row.id,
      projectId: row.project_id,
      subjectId: row.subject_id,
      angleId: row.angle_id,
      platform: row.platform as PlatformId,
      target,
      format: row.format as ContentFormat,
      title: row.title,
      state: row.state as ContentState,
      currentVersionId: row.current_version_id,
      approvedVersionId: row.approved_version_id,
      contentHash: row.content_hash,
      aiGenerated: row.ai_generated,
      humanEdited: row.human_edited,
      editRatio: row.edit_ratio,
      regeneratedCount: row.regenerated_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      approvedAt: row.approved_at,
      scheduledFor: row.scheduled_for,
      publishedAt: row.published_at,
      archivedAt: row.archived_at,
    };
  };

  const store: EditorialStoreImpl = {
    // --- Sujets et angles (étape 3) ---------------------------------------
    createPlan: (input) => {
      const timestamp = now();
      const subjects: EditorialSubject[] = [];
      const angles: EditorialAngle[] = [];

      for (const subject of input.subjects) {
        const subjectId = newId();
        handle.db
          .insert(contentSubjects)
          .values({
            id: subjectId,
            project_id: input.projectId,
            master_brief_id: subject.masterBriefId,
            conversation_id: subject.conversationId,
            title: subject.title,
            thesis: subject.thesis,
            pillar: subject.pillar,
            audience_id: null,
            origin: subject.origin,
            status: 'proposed',
            skill_coverage: subject.skillCoverage,
            evidence_json: encodeJson(subject.evidence),
            priority_score: subject.priorityScore,
            created_at: timestamp,
            updated_at: timestamp,
            archived_at: null,
          })
          .run();

        subjects.push(subjectOrThrow(subjectId));

        for (const angle of subject.angles) {
          const angleId = newId();
          handle.db
            .insert(subjectAngles)
            .values({
              id: angleId,
              subject_id: subjectId,
              // `platform_hint` est un indice : sans lui, l'angle vaut pour toutes
              // les plateformes (`all`), ce que la contrainte SQL accepte.
              platform: angle.platformHint ?? 'all',
              hook: angle.hook,
              angle_type: angle.angleType,
              structure_json: encodeJson(angle.structure),
              audience_id: null,
              estimated_length: angle.estimatedLength,
              difficulty: angle.difficulty,
              evidence_json: encodeJson(angle.evidence),
              rationale: angle.rationale,
              score: angle.score,
              selected: false,
              rejection_reason: null,
              created_at: timestamp,
            })
            .run();
          angles.push(angleOrThrow(angleId));
        }
      }

      return { subjects, angles };
    },

    listSubjects: (projectId, filter = {}) => {
      const conditions = [eq(contentSubjects.project_id, projectId)];
      if (filter.statuses && filter.statuses.length > 0) {
        conditions.push(inArray(contentSubjects.status, [...filter.statuses]));
      } else {
        conditions.push(ne(contentSubjects.status, 'archived'));
      }
      return handle.db
        .select()
        .from(contentSubjects)
        .where(and(...conditions))
        .orderBy(desc(contentSubjects.priority_score), asc(contentSubjects.created_at))
        .all()
        .map(toSubject);
    },

    getSubject: (id) => {
      const row = handle.db.select().from(contentSubjects).where(eq(contentSubjects.id, id)).get();
      return row ? toSubject(row) : null;
    },

    listAngles: (subjectId) =>
      handle.db
        .select()
        .from(subjectAngles)
        .where(eq(subjectAngles.subject_id, subjectId))
        .orderBy(desc(subjectAngles.score), asc(subjectAngles.created_at))
        .all()
        .map(toAngle),

    getAngle: (id) => {
      const row = handle.db.select().from(subjectAngles).where(eq(subjectAngles.id, id)).get();
      return row ? toAngle(row) : null;
    },

    /**
     * Choisir un angle **rejette les autres du même sujet**, avec un motif écrit.
     * On ne jette pas le travail du modèle : on garde la trace du choix
     * (« pourquoi pas celui-là ? »), et plus aucun angle non retenu n'est
     * sélectionnable.
     */
    selectAngle: (angleId) => {
      const angle = angleOrThrow(angleId);
      handle.db
        .update(subjectAngles)
        .set({ selected: true, rejection_reason: null })
        .where(eq(subjectAngles.id, angleId))
        .run();

      for (const sibling of store.listAngles(angle.subjectId)) {
        if (sibling.id === angleId || sibling.rejectionReason !== null) continue;
        handle.db
          .update(subjectAngles)
          .set({ selected: false, rejection_reason: 'angle non retenu pour ce sujet' })
          .where(eq(subjectAngles.id, sibling.id))
          .run();
      }

      return angleOrThrow(angleId);
    },

    rejectAngle: (angleId, reason) => {
      angleOrThrow(angleId);
      handle.db
        .update(subjectAngles)
        .set({ selected: false, rejection_reason: reason })
        .where(eq(subjectAngles.id, angleId))
        .run();
      return angleOrThrow(angleId);
    },

    updateSubject: (id, patch) => {
      subjectOrThrow(id);
      const set: Partial<typeof contentSubjects.$inferInsert> = { updated_at: now() };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.skillCoverage !== undefined) set.skill_coverage = patch.skillCoverage;
      handle.db.update(contentSubjects).set(set).where(eq(contentSubjects.id, id)).run();
      return subjectOrThrow(id);
    },

    listSubjectTitles: (projectId) =>
      handle.db
        .select({ title: contentSubjects.title })
        .from(contentSubjects)
        .where(eq(contentSubjects.project_id, projectId))
        .orderBy(desc(contentSubjects.created_at))
        .all()
        .map((row) => row.title),

    // --- Contenus (étape 4) ----------------------------------------------
    createContentItem: (input) => {
      const timestamp = now();
      const id = newId();
      handle.db
        .insert(contentItems)
        .values({
          id,
          project_id: input.projectId,
          subject_id: input.subjectId,
          angle_id: input.angleId,
          platform_account_id: null,
          platform: input.platform,
          format: input.format,
          title: null,
          state: 'draft',
          current_version_id: null,
          approved_version_id: null,
          content_hash: input.contentHash,
          ai_generated: true,
          human_edited: false,
          edit_ratio: null,
          regenerated_count: 0,
          created_at: timestamp,
          updated_at: timestamp,
          approved_at: null,
          scheduled_for: null,
          published_at: null,
          archived_at: null,
        })
        .run();
      return itemOrThrow(id);
    },

    getContentItem: (id) => {
      const row = handle.db.select().from(contentItems).where(eq(contentItems.id, id)).get();
      return row ? itemFromRow(row) : null;
    },

    listContentItems: (projectId, filter = {}) => {
      const conditions = [eq(contentItems.project_id, projectId)];
      if (filter.state !== undefined) conditions.push(eq(contentItems.state, filter.state));
      return handle.db
        .select()
        .from(contentItems)
        .where(and(...conditions))
        .orderBy(asc(contentItems.created_at))
        .all()
        .map(itemFromRow)
        .filter((item): item is EditorialItem => item !== null);
    },

    listContentItemsByAngle: (angleId) =>
      handle.db
        .select()
        .from(contentItems)
        .where(eq(contentItems.angle_id, angleId))
        .orderBy(asc(contentItems.created_at))
        .all()
        .map(itemFromRow)
        .filter((item): item is EditorialItem => item !== null),

    updateContentItem: (id, patch) => {
      itemOrThrow(id);
      const set: Partial<typeof contentItems.$inferInsert> = { updated_at: now() };
      if (patch.title !== undefined) set.title = patch.title;
      if (patch.state !== undefined) set.state = patch.state;
      if (patch.currentVersionId !== undefined) set.current_version_id = patch.currentVersionId;
      if (patch.approvedVersionId !== undefined) set.approved_version_id = patch.approvedVersionId;
      if (patch.contentHash !== undefined) set.content_hash = patch.contentHash;
      if (patch.humanEdited !== undefined) set.human_edited = patch.humanEdited;
      if (patch.editRatio !== undefined) set.edit_ratio = patch.editRatio;
      if (patch.regeneratedCount !== undefined) set.regenerated_count = patch.regeneratedCount;
      if (patch.approvedAt !== undefined) set.approved_at = patch.approvedAt;
      if (patch.archivedAt !== undefined) set.archived_at = patch.archivedAt;
      handle.db.update(contentItems).set(set).where(eq(contentItems.id, id)).run();
      return itemOrThrow(id);
    },

    /**
     * Le numéro de la prochaine version : `max + 1`. Il est calculé ici et non
     * par le domaine parce que deux écritures ne doivent pas proposer le même
     * numéro — l'index `uq_content_version` refuse la seconde, ce qui vaut mieux
     * qu'une version écrasée.
     */
    nextVersionNumber: (contentItemId) => {
      const rows = handle.db
        .select({ versionNumber: contentVersions.version_number })
        .from(contentVersions)
        .where(eq(contentVersions.content_item_id, contentItemId))
        .all();
      return rows.reduce((max, row) => Math.max(max, row.versionNumber), 0) + 1;
    },

    addVersion: (input) => {
      const id = newId();
      const timestamp = now();
      handle.db
        .insert(contentVersions)
        .values({
          id,
          content_item_id: input.contentItemId,
          version_number: input.versionNumber,
          body: input.body,
          title: input.title,
          hook: input.hook,
          hashtags_json: encodeJson(input.hashtags),
          mentions_json: encodeJson(input.mentions),
          link_url: null,
          media_asset_ids_json: encodeJson([]),
          char_count: input.charCount,
          word_count: input.wordCount,
          reading_time_sec: input.readingTimeSec,
          generation: input.generation,
          prompt_version_hash: input.promptVersionHash,
          llm_call_id: input.llmCallId,
          model_used: input.modelUsed,
          temperature_x100: input.temperatureX100,
          critique_json: null,
          quality_score: null,
          approved_at: null,
          approved_by: null,
          created_at: timestamp,
        })
        .run();
      return versionOrThrow(id);
    },

    getVersion: (id) => {
      const row = handle.db.select().from(contentVersions).where(eq(contentVersions.id, id)).get();
      return row ? toVersion(row) : null;
    },

    listVersions: (contentItemId) =>
      handle.db
        .select()
        .from(contentVersions)
        .where(eq(contentVersions.content_item_id, contentItemId))
        .orderBy(asc(contentVersions.version_number))
        .all()
        .map(toVersion),

    approveVersion: (versionId, approvedBy) => {
      versionOrThrow(versionId);
      handle.db
        .update(contentVersions)
        .set({ approved_at: now(), approved_by: approvedBy })
        .where(eq(contentVersions.id, versionId))
        .run();
      return versionOrThrow(versionId);
    },

    /**
     * Les remarques d'un contenu sont **remplacées par auteur** : régénérer ne
     * laisse pas les remarques de la version précédente à côté du nouveau texte
     * (docs/03 §9.4). Celles des autres auteurs — un humain, un autre agent —
     * sont conservées : on n'efface pas la parole de quelqu'un d'autre.
     */
    replaceNotes: (contentItemId, contentVersionId, author, notes) => {
      handle.db
        .delete(contentReviewNotes)
        .where(
          and(
            eq(contentReviewNotes.content_item_id, contentItemId),
            eq(contentReviewNotes.content_version_id, contentVersionId),
            eq(contentReviewNotes.author, author),
          ),
        )
        .run();

      const timestamp = now();
      for (const note of notes) {
        handle.db
          .insert(contentReviewNotes)
          .values({
            id: newId(),
            content_item_id: contentItemId,
            content_version_id: contentVersionId,
            author,
            note_type: note.noteType,
            severity: note.severity,
            message: note.message,
            anchor_text: note.anchorText,
            resolved: false,
            resolved_at: null,
            resolved_by: null,
            created_at: timestamp,
          })
          .run();
      }
    },

    listNotes: (contentItemId) =>
      handle.db
        .select()
        .from(contentReviewNotes)
        .where(eq(contentReviewNotes.content_item_id, contentItemId))
        .orderBy(asc(contentReviewNotes.created_at))
        .all()
        .map(toNote),
  };

  return store;
}
