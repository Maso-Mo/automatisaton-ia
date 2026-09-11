import { ValidationError, type SkillLearnedHow, type SkillLevel } from '@aia/shared';

/**
 * Compétences du projet (docs/03 §6.2, docs/05 §3.1 « intake »).
 *
 * **Table critique** : « une compétence n'est pas une automatisation ». Elle ne
 * contient que ce que l'utilisateur maîtrise — ou apprend activement. C'est
 * l'invariant n° 2 du cahier des charges : le produit ne doit jamais laisser
 * croire que l'utilisateur maîtrise ce qu'un pipeline a automatisé pour lui.
 *
 * Un `upsert` est naturel ici : une compétence est unique par projet
 * (`uq_skill_project`), son niveau progresse au fil des entretiens, et son
 * historique n'a pas d'intérêt produit — contrairement aux faits, qui se
 * remplacent sans se réécrire.
 */

export interface ProjectSkillFact {
  id: string;
  projectId: string;
  skill: string;
  level: SkillLevel;
  evidence: string | null;
  learnedHow: SkillLearnedHow | null;
  isLearning: boolean;
  learningTarget: string | null;
  /** 1–5 : à quel point l'utilisateur est sûr de ce qu'il avance. */
  confidence: number;
  lastUpdatedAt: number;
  createdAt: number;
}

export const SKILL_MAX_LENGTH = 120;
export const SKILL_EVIDENCE_MAX_LENGTH = 600;
export const SKILL_LEARNING_TARGET_MAX_LENGTH = 300;

export interface SkillFactInput {
  skill: string;
  level: SkillLevel;
  evidence?: string | null;
  learnedHow?: SkillLearnedHow | null;
  isLearning?: boolean;
  learningTarget?: string | null;
  confidence?: number;
}

export function assertSkillContent(input: SkillFactInput): string {
  const skill = input.skill.trim();
  if (skill.length === 0) {
    throw new ValidationError('Une compétence doit être nommée', { code: 'SKILL_NAME_REQUIRED' });
  }
  if (skill.length > SKILL_MAX_LENGTH) {
    throw new ValidationError(`Une compétence ne dépasse pas ${SKILL_MAX_LENGTH} caractères`, {
      code: 'SKILL_NAME_TOO_LONG',
      details: { length: skill.length },
    });
  }
  if (input.evidence && input.evidence.length > SKILL_EVIDENCE_MAX_LENGTH) {
    throw new ValidationError('La preuve d’une compétence est trop longue', {
      code: 'SKILL_EVIDENCE_TOO_LONG',
    });
  }
  if (input.learningTarget && input.learningTarget.length > SKILL_LEARNING_TARGET_MAX_LENGTH) {
    throw new ValidationError('L’objectif d’apprentissage est trop long', {
      code: 'SKILL_TARGET_TOO_LONG',
    });
  }
  const confidence = input.confidence ?? 3;
  if (!Number.isInteger(confidence) || confidence < 1 || confidence > 5) {
    throw new ValidationError(`La confiance d’une compétence va de 1 à 5 (reçu : ${confidence})`, {
      code: 'SKILL_CONFIDENCE_OUT_OF_RANGE',
    });
  }
  if (input.isLearning === true && !input.learningTarget) {
    throw new ValidationError(
      'Une compétence « en apprentissage » indique ce qui est en cours d’apprentissage',
      { code: 'SKILL_LEARNING_TARGET_REQUIRED' },
    );
  }
  return skill;
}

/** Nouvelle compétence : tout est explicite, rien n'est implicite. */
export function buildSkillFact(
  ports: { newId(): string; clock: { nowMs(): number } },
  projectId: string,
  input: SkillFactInput,
): ProjectSkillFact {
  const now = ports.clock.nowMs();
  const skill = assertSkillContent(input);
  return {
    id: ports.newId(),
    projectId,
    skill,
    level: input.level,
    evidence: input.evidence ?? null,
    learnedHow: input.learnedHow ?? null,
    isLearning: input.isLearning ?? false,
    learningTarget: input.learningTarget ?? null,
    confidence: input.confidence ?? 3,
    lastUpdatedAt: now,
    createdAt: now,
  };
}

/** Champs modifiables d'une compétence existante : jamais son nom (c'est sa clé). */
export interface SkillFactPatch {
  level?: SkillLevel;
  evidence?: string | null;
  learnedHow?: SkillLearnedHow | null;
  isLearning?: boolean;
  learningTarget?: string | null;
  confidence?: number;
  lastUpdatedAt: number;
}

/** Niveau croissant : régresser une compétence demande une intention explicite. */
const LEVEL_ORDER: readonly SkillLevel[] = ['debutant', 'intermediaire', 'avance', 'expert'];

export function highestLevel(a: SkillLevel, b: SkillLevel): SkillLevel {
  return LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b;
}
