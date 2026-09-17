import type {
  AngleDifficulty,
  AngleLength,
  AngleType,
  ContentFormat,
  ContentGeneration,
  ContentState,
  ContentTarget,
  ContentTargetSpec,
  Clock,
  PlatformId,
  SkillCoverage,
  SubjectOrigin,
  SubjectStatus,
} from '@aia/shared';
import type { MasterBrief } from '../conversation/types';
import type { Project, ProjectFact, ProjectMemoryStore } from '../projects/types';
import type { ProjectSkillFact } from '../projects/skills';

/**
 * Domaine « éditorial » — étape 4 : transformer une fiche maître en **sujets**,
 * **angles** et **contenus versionnés** (docs/10 §4.4, docs/03 §8.2 à §9.4).
 *
 * Trois principes structurent ces types :
 *
 * 1. **Le sujet n'est pas la plateforme, l'angle n'est pas le contenu.** Un sujet
 *    est une unité de sens ; un angle est un regard sur ce sujet ; un contenu est
 *    la version d'un angle **pour une cible** (plateforme + format). C'est ce qui
 *    permet de recycler sans se répéter (docs/03 §8.2).
 * 2. **Rien n'est publié, rien n'est « vérifié ».** À cette étape, le produit
 *    écrit et l'utilisateur valide : `content_claims` reste vide et aucune
 *    affirmation n'est marquée comme sourcée (docs/10 §4.4).
 * 3. **Une version ne se modifie pas.** Chaque écriture — initiale, régénérée,
 *    éditée à la main — crée une ligne : c'est ce qui rend le retour en arrière
 *    et le « pourquoi ce texte ? » possibles (docs/03 §9.2).
 */

/** Un **sujet** : ce dont on parle, indépendamment d'une plateforme (docs/03 §8.2). */
export interface ContentSubject {
  id: string;
  projectId: string;
  masterBriefId: string | null;
  conversationId: string | null;
  title: string;
  /** L'idée défendue, en une phrase. */
  thesis: string;
  pillar: string | null;
  audienceId: string | null;
  origin: SubjectOrigin;
  status: SubjectStatus;
  skillCoverage: SkillCoverage | null;
  /** Extraits de faits qui soutiennent le sujet : l'ancrage exigé par docs/04 §4.2. */
  evidence: string[];
  priorityScore: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/** Un **angle** : un regard précis sur un sujet (docs/03 §8.3). */
export interface SubjectAngle {
  id: string;
  subjectId: string;
  /** `all` : l'angle vaut pour toutes les cibles du projet. */
  platform: string;
  hook: string;
  angleType: AngleType;
  /** Le déroulé prévu, étape par étape. */
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

/**
 * Un **contenu** : la version d'un angle pour une cible (docs/03 §9.1). C'est lui
 * qui porte la machine à états et le marquage IA.
 */
export interface ContentItem {
  id: string;
  projectId: string;
  subjectId: string | null;
  angleId: string | null;
  platform: PlatformId;
  /** Cible exacte (`linkedin_post`, `youtube_long`…) : une seule source de vérité. */
  target: ContentTarget;
  format: ContentFormat;
  title: string | null;
  state: ContentState;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  contentHash: string | null;
  /** Marquage IA, toujours vrai à l'étape 4 (docs/07 §11.2). */
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

/** Une **version** d'un contenu : texte figé, contexte de génération inclus (docs/03 §9.2). */
export interface ContentVersion {
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

/** Une **remarque** affichée à côté du texte (docs/03 §9.4). */
export interface ContentReviewNote {
  id: string;
  contentItemId: string;
  contentVersionId: string | null;
  /** `user`, `platform_writer`… : une remarque a toujours un auteur nommé. */
  author: string;
  noteType: 'critique' | 'suggestion' | 'erreur' | 'warning' | 'decision';
  severity: 'info' | 'basse' | 'moyenne' | 'haute';
  message: string;
  anchorText: string | null;
  resolved: boolean;
  createdAt: number;
}

// --- Écritures ------------------------------------------------------------

export interface NewAngleRecord {
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

export interface NewSubjectRecord {
  title: string;
  thesis: string;
  pillar: string | null;
  evidence: string[];
  skillCoverage: SkillCoverage;
  priorityScore: number;
  origin: SubjectOrigin;
  masterBriefId: string | null;
  conversationId: string | null;
  angles: NewAngleRecord[];
}

export interface CreatePlanInput {
  projectId: string;
  subjects: NewSubjectRecord[];
}

export interface NewContentItemRecord {
  projectId: string;
  subjectId: string | null;
  angleId: string | null;
  platform: PlatformId;
  target: ContentTarget;
  format: ContentFormat;
  contentHash: string | null;
}

export interface NewContentVersionRecord {
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

export interface ContentItemPatch {
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

export interface NewReviewNoteRecord {
  noteType: ContentReviewNote['noteType'];
  severity: ContentReviewNote['severity'];
  message: string;
  anchorText: string | null;
}

/**
 * Le port de persistance de l'éditorial. Il ne **décide** rien : les règles
 * (machine à états, ancrage factuel, remplacement d'une version courante) vivent
 * dans ce paquet, où elles se testent sans base.
 *
 * Le paquet de persistance rend des objets **structurellement** identiques à ces
 * types, sans importer le domaine (docs/02 §5).
 */
export interface EditorialStore {
  createPlan(input: CreatePlanInput): { subjects: ContentSubject[]; angles: SubjectAngle[] };
  listSubjects(projectId: string, filter?: { statuses?: SubjectStatus[] }): ContentSubject[];
  getSubject(id: string): ContentSubject | null;
  listAngles(subjectId: string): SubjectAngle[];
  getAngle(id: string): SubjectAngle | null;
  /** Sélectionne un angle et rejette implicitement les autres du même sujet. */
  selectAngle(angleId: string): SubjectAngle;
  rejectAngle(angleId: string, reason: string | null): SubjectAngle;
  updateSubject(
    id: string,
    patch: { status?: SubjectStatus; skillCoverage?: SkillCoverage },
  ): ContentSubject;
  /** Titres déjà traités : sert à demander au modèle d'éviter la répétition. */
  listSubjectTitles(projectId: string): string[];

  createContentItem(input: NewContentItemRecord): ContentItem;
  getContentItem(id: string): ContentItem | null;
  listContentItems(projectId: string, filter?: { state?: ContentState }): ContentItem[];
  listContentItemsByAngle(angleId: string): ContentItem[];
  updateContentItem(id: string, patch: ContentItemPatch): ContentItem;
  nextVersionNumber(contentItemId: string): number;

  addVersion(input: NewContentVersionRecord): ContentVersion;
  getVersion(id: string): ContentVersion | null;
  listVersions(contentItemId: string): ContentVersion[];
  approveVersion(versionId: string, approvedBy: string | null): ContentVersion;

  replaceNotes(
    contentItemId: string,
    contentVersionId: string,
    author: string,
    notes: readonly NewReviewNoteRecord[],
  ): void;
  listNotes(contentItemId: string): ContentReviewNote[];
}

/**
 * Les dépendances du domaine. `briefs` est un port **étroit** : l'éditorial n'a
 * besoin que de la fiche maître courante, pas de tout le domaine conversation.
 */
export interface EditorialPorts {
  store: EditorialStore;
  memory: ProjectMemoryStore;
  briefs: { current(projectId: string): MasterBrief | undefined };
  clock: Clock;
  newId(): string;
}

/** Un contenu prêt à être montré : l'objet, sa version courante, ses remarques. */
export interface ContentBundle {
  item: ContentItem;
  version: ContentVersion | null;
  notes: ContentReviewNote[];
}

/** Ce dont le domaine a besoin pour écrire : le projet, sa fiche, ses faits, ses compétences. */
export interface ProjectSnapshot {
  project: Project;
  brief: MasterBrief | null;
  facts: ProjectFact[];
  skills: ProjectSkillFact[];
}

/** La spécification d'une cible, telle que le domaine la vérifie. */
export type TargetSpec = ContentTargetSpec;
