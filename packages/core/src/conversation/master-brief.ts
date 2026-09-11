import {
  masterBriefContentSchema,
  ValidationError,
  type MasterBriefContent,
  type PlatformId,
  type SkillLevel,
} from '@aia/shared';
import { InvalidStateTransitionError } from '../errors';
import { updateProject } from '../projects/service';
import {
  projectMemoryPorts,
  type ConversationPorts,
  type MasterBrief,
  type MasterBriefPatch,
} from './types';

/**
 * La **fiche maître** et son cycle de vie (docs/03 §8.1).
 *
 * Trois règles, et aucune n'est négociable :
 *
 * 1. **Immuable** : une fiche validée ou remplacée ne se modifie pas. Une
 *    correction crée une **nouvelle version** ; l'ancienne passe en `superseded`
 *    avec un lien `superseded_by_id`. Les contenus générés restent rattachés à la
 *    version qui les a produits — sinon on ne saurait plus ce qui a été écrit à
 *    partir de quoi.
 * 2. **Validée par un humain** : `status = 'validated'` exige une date
 *    (`validated_at`), et la base le vérifie (`chk_briefs_validated_at`).
 * 3. **`gaps` est utilisée en négatif** : ce que l'utilisateur ne maîtrise pas
 *    sert à refuser ou signaler un sujet, jamais à le présenter comme une
 *    expertise (docs/03 §8.1).
 *
 * La validation écrit aussi le **positionnement du projet** : la fiche maître est
 * la synthèse validée de l'entretien, donc c'est elle qui fait autorité sur ce
 * pour quoi l'utilisateur veut être reconnu.
 */

export interface BriefBuildParams {
  projectId: string;
  conversationId: string;
  llmCallId: string | null;
  sourceMessageIds: string[];
  version: number;
}

/**
 * Traduit la sortie du modèle (`snake_case`, nullable) en fiche stockable.
 * Les trois champs exigés sont refusés s'ils sont vides : une fiche sans
 * positionnement ni public ne sert à rien, et la corriger après coup coûterait
 * un appel de plus.
 */
export function buildBriefRecord(
  ports: ConversationPorts,
  params: BriefBuildParams,
  content: MasterBriefContent,
): MasterBrief {
  const parsed = masterBriefContentSchema.safeParse(content);
  if (!parsed.success) {
    throw new ValidationError(
      `Fiche maître invalide : ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(racine)'} ${issue.message}`)
        .join(' ; ')}`,
      { code: 'MASTER_BRIEF_INVALID', details: { conversationId: params.conversationId } },
    );
  }

  const now = ports.clock.nowMs();
  const value = parsed.data;
  return {
    id: ports.newId(),
    projectId: params.projectId,
    conversationId: params.conversationId,
    version: params.version,
    status: 'draft',
    summary: value.summary.trim(),
    positioning: value.positioning.trim(),
    targetAudience: value.target_audience.trim(),
    contentPillars: value.content_pillars.map((pillar) => pillar.trim()),
    themes: value.themes.map((theme) => theme.trim()),
    formats:
      value.formats?.map((entry) => ({ platform: entry.platform, formats: entry.formats })) ?? null,
    skillMap:
      value.skill_map?.map((entry) => ({
        skill: entry.skill,
        level: entry.level as SkillLevel,
        isLearning: entry.is_learning,
      })) ?? null,
    gaps: value.gaps?.map((gap) => gap.trim()) ?? null,
    cadence:
      value.cadence?.map((entry) => ({ platform: entry.platform, perWeek: entry.per_week })) ??
      null,
    successCriteria: value.success_criteria?.map((item) => item.trim()) ?? null,
    sourceMessageIds: [...params.sourceMessageIds],
    llmCallId: params.llmCallId,
    validatedAt: null,
    supersededById: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Seule une fiche en brouillon se modifie. Le reste crée une version. */
export function assertBriefMutable(brief: MasterBrief): void {
  if (brief.status === 'draft') return;
  throw new InvalidStateTransitionError(brief.status, 'draft', {
    entity: `fiche maître ${brief.id}`,
  });
}

/**
 * Ce qu'il reste à compléter dans une fiche : c'est ce que l'interface affiche
 * en « à compléter », et ce que l'intervieweur redemande. Un trou visible vaut
 * mieux qu'une invention plausible (docs/04 §4.2).
 */
export function briefGaps(brief: MasterBrief): string[] {
  const missing: string[] = [];
  if (brief.summary.trim().length === 0) missing.push('summary');
  if (brief.positioning.trim().length === 0) missing.push('positioning');
  if (brief.targetAudience.trim().length === 0) missing.push('target_audience');
  if (brief.contentPillars.length === 0) missing.push('content_pillars');
  if (brief.themes.length === 0) missing.push('themes');
  if (brief.formats === null || brief.formats.length === 0) missing.push('formats');
  if (brief.cadence === null || brief.cadence.length === 0) missing.push('cadence');
  if (brief.successCriteria === null || brief.successCriteria.length === 0) {
    missing.push('success_criteria');
  }
  return missing;
}

/** Ce que l'utilisateur peut corriger. Le reste (version, statut) est calculé. */
export interface BriefEditInput {
  summary?: string;
  positioning?: string;
  targetAudience?: string;
  contentPillars?: string[];
  themes?: string[];
  formats?: { platform: PlatformId; formats: string[] }[] | null;
  skillMap?: { skill: string; level: SkillLevel; isLearning: boolean }[] | null;
  gaps?: string[] | null;
  cadence?: { platform: PlatformId; perWeek: number }[] | null;
  successCriteria?: string[] | null;
}

/**
 * Corriger une fiche, c'est en créer une **nouvelle version** (docs/03 §8.1).
 * L'ancienne n'est jamais réécrite : si un contenu a été généré à partir d'elle,
 * on peut encore savoir ce qu'elle disait.
 */
export function nextBriefVersion(
  ports: ConversationPorts,
  previous: MasterBrief,
  edits: BriefEditInput,
): MasterBrief {
  if (previous.status === 'superseded') {
    throw new InvalidStateTransitionError('superseded', 'draft', {
      entity: `fiche maître ${previous.id}`,
    });
  }

  const merged: MasterBriefContent = {
    summary: edits.summary ?? previous.summary,
    positioning: edits.positioning ?? previous.positioning,
    target_audience: edits.targetAudience ?? previous.targetAudience,
    content_pillars: edits.contentPillars ?? previous.contentPillars,
    themes: edits.themes ?? previous.themes,
    formats:
      edits.formats === undefined
        ? (previous.formats ?? null)
        : edits.formats === null
          ? null
          : edits.formats.map((entry) => ({ platform: entry.platform, formats: entry.formats })),
    skill_map:
      edits.skillMap === undefined
        ? (previous.skillMap?.map((entry) => ({
            skill: entry.skill,
            level: entry.level,
            is_learning: entry.isLearning,
          })) ?? null)
        : edits.skillMap === null
          ? null
          : edits.skillMap.map((entry) => ({
              skill: entry.skill,
              level: entry.level,
              is_learning: entry.isLearning,
            })),
    gaps: edits.gaps === undefined ? previous.gaps : edits.gaps,
    cadence:
      edits.cadence === undefined
        ? (previous.cadence?.map((entry) => ({
            platform: entry.platform,
            per_week: entry.perWeek,
          })) ?? null)
        : edits.cadence === null
          ? null
          : edits.cadence.map((entry) => ({ platform: entry.platform, per_week: entry.perWeek })),
    success_criteria:
      edits.successCriteria === undefined ? previous.successCriteria : edits.successCriteria,
    open_questions: null,
  };

  const rebuilt = buildBriefRecord(
    ports,
    {
      projectId: previous.projectId,
      conversationId: previous.conversationId,
      llmCallId: previous.llmCallId,
      sourceMessageIds: previous.sourceMessageIds,
      version: previous.version + 1,
    },
    merged,
  );

  return rebuilt;
}

/** Valider : un acte humain, daté. Le statut devient `validated`. */
export function planBriefValidation(brief: MasterBrief, now: number): MasterBriefPatch {
  if (brief.status !== 'draft') {
    throw new InvalidStateTransitionError(brief.status, 'validated', {
      entity: `fiche maître ${brief.id}`,
    });
  }
  return { status: 'validated', validatedAt: now, updatedAt: now };
}

/** Remplacer : l'ancienne version garde son contenu et pointe vers la nouvelle. */
export function planBriefSupersession(
  brief: MasterBrief,
  successorId: string,
  now: number,
): MasterBriefPatch {
  if (brief.status === 'superseded') {
    throw new InvalidStateTransitionError('superseded', 'superseded', {
      entity: `fiche maître ${brief.id}`,
    });
  }
  return { status: 'superseded', supersededById: successorId, updatedAt: now };
}

/**
 * Une fiche validée fait autorité sur le positionnement du projet : c'est la
 * synthèse de l'entretien, et la recopier ailleurs ferait diverger deux vérités.
 */
export function applyBriefToProject(ports: ConversationPorts, brief: MasterBrief): void {
  updateProject(projectMemoryPorts(ports), brief.projectId, { positioning: brief.positioning });
}
