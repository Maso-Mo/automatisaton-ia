import {
  NotFoundError,
  ValidationError,
  type AngleDifficulty,
  type EditorialPlanOutput,
  type SkillCoverage,
} from '@aia/shared';
import type { ProjectSkillFact } from '../projects/skills';
import type {
  ContentSubject,
  EditorialPorts,
  NewAngleRecord,
  NewSubjectRecord,
  ProjectSnapshot,
  SubjectAngle,
} from './types';
import { checkGrounding, normalizeForMatch, tokenOverlap } from './validation';

/**
 * Le **plan éditorial** : sujets, angles, sélection (docs/03 §8.2 et §8.3,
 * docs/04 §4.2).
 *
 * Deux garanties sont calculées **localement**, jamais demandées au modèle :
 *
 * 1. **l'ancrage factuel** — chaque sujet et chaque angle cite un extrait d'un
 *    fait du projet, vérifié mot à mot contre la mémoire fournie. Un plan non
 *    ancré est refusé, pas corrigé en silence : c'est le garde-fou « pas de
 *    contenu hors du réel de l'utilisateur » (docs/04 §4.2) ;
 * 2. **le score de priorité** — la formule de docs/03 §8.2, calculée en base à
 *    partir du pilier, de la couverture de compétence, de la fraîcheur et de la
 *    diversité. Un modèle qui s'auto-note produit un classement qui ne veut rien
 *    dire ; la version locale est reproductible et testable.
 */

/** Le poids des composantes du score (docs/03 §8.2). */
export const SUBJECT_SCORE_WEIGHTS = {
  pillarMatch: 2,
  skillCoverage: 2,
  freshness: 1,
  diversity: 1,
  recentlyCoveredPenalty: 3,
} as const;

/** Deux titres qui se recouvrent à ce point parlent du même sujet. */
export const DUPLICATE_THRESHOLD = 0.6;

export function projectSnapshot(ports: EditorialPorts, projectId: string): ProjectSnapshot {
  const project = ports.memory.projects.byId(projectId);
  if (!project) {
    throw new NotFoundError(`Projet introuvable : ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }
  const brief = ports.briefs.current(projectId) ?? null;
  const facts = ports.memory.facts.list({ projectId });
  const skills = ports.memory.skillFacts.list(projectId);
  return { project, brief, facts, skills };
}

/**
 * Couverture d'une compétence par un sujet (docs/03 §8.2 : « jamais présenter une
 * automatisation comme une compétence »).
 *
 * La comparaison est volontairement grossière — recouvrement de jetons entre le
 * titre/thèse et le **libellé** de la compétence. Elle ne prétend pas juger du
 * fond : elle évite qu'un sujet tombe dans un trou de compétence sans que
 * l'utilisateur le voie, et l'étape 6 l'affinera avec les données réelles.
 */
export function skillCoverageFor(
  subject: { title: string; thesis: string },
  skills: readonly ProjectSkillFact[],
): SkillCoverage {
  if (skills.length === 0) return 'non_couverte';
  const text = `${subject.title} ${subject.thesis}`;
  const overlaps = skills.map((skill) => tokenOverlap(text, skill.skill));
  const best = Math.max(...overlaps);
  if (best >= 0.5) return 'couverte';
  if (best >= 0.2) return 'partielle';
  return 'non_couverte';
}

export interface SubjectScoreInput {
  subject: { title: string; thesis: string; pillar: string | null };
  brief: ProjectSnapshot['brief'];
  skills: readonly ProjectSkillFact[];
  /** Titres des sujets déjà au plan : anti-répétition (docs/03 §8.2). */
  recentSubjects: readonly { title: string; pillar: string | null }[];
}

export interface SubjectScore {
  score: number;
  coverage: SkillCoverage;
  reasons: string[];
}

/** La formule de docs/03 §8.2, en clair et sans inconnue. */
export function scoreSubject(input: SubjectScoreInput): SubjectScore {
  const weights = SUBJECT_SCORE_WEIGHTS;
  const reasons: string[] = [];
  let score = 0;

  const pillars = (input.brief?.contentPillars ?? []).map(normalizeForMatch);
  const pillar = normalizeForMatch(input.subject.pillar ?? '');
  if (pillar.length > 0 && pillars.some((candidate) => candidate === pillar)) {
    score += weights.pillarMatch;
    reasons.push(`pilier « ${input.subject.pillar} » confirmé par la fiche maître`);
  } else if (input.subject.pillar) {
    reasons.push(`pilier « ${input.subject.pillar} » hors des piliers de la fiche maître`);
  }

  const coverage = skillCoverageFor(input.subject, input.skills);
  if (coverage === 'couverte') {
    score += weights.skillCoverage;
    reasons.push('sujet couvert par une compétence déclarée');
  } else if (coverage === 'partielle') {
    score += weights.skillCoverage / 2;
    reasons.push('compétence partiellement couverte');
  } else {
    reasons.push(
      'aucune compétence déclarée ne couvre ce sujet : à traiter comme un apprentissage',
    );
  }

  if (input.subject.pillar && input.subject.pillar.length > 0 && input.brief) {
    score += weights.freshness;
    reasons.push('sujet rattaché à un pilier actif');
  }

  const samePillar = input.recentSubjects.filter(
    (recent) => normalizeForMatch(recent.pillar ?? '') === pillar && pillar.length > 0,
  ).length;
  if (samePillar < 2) {
    score += weights.diversity;
    reasons.push('diversité respectée : ce pilier n’est pas surreprésenté');
  } else {
    reasons.push(
      `diversité : ${samePillar} sujets déjà proposés sur ce pilier, préférer un autre angle`,
    );
  }

  const duplicate = input.recentSubjects.find(
    (recent) => tokenOverlap(recent.title, input.subject.title) >= DUPLICATE_THRESHOLD,
  );
  if (duplicate) {
    score -= weights.recentlyCoveredPenalty;
    reasons.push(`proche d’un sujet déjà proposé (« ${duplicate.title} »)`);
  }

  return { score: Math.max(0, score), coverage, reasons };
}

export interface RejectedSubject {
  title: string;
  reasons: string[];
}

export interface ValidatedPlan {
  accepted: NewSubjectRecord[];
  rejected: RejectedSubject[];
  /** Nombre d'angles écartés faute d'ancrage, toutes matières confondues. */
  droppedAngles: number;
}

/** Le poids des composantes du score d'angle (docs/03 §8.3). */
export const ANGLE_SCORE_WEIGHTS = {
  /** Deux extraits distincts valent mieux qu'un : l'angle est mieux appuyé. */
  evidence: 2,
  /** Un déroulé de 4 étapes au moins est un plan, pas une intention. */
  structure: 1,
  /** Un angle accessible se produit ; un angle difficile se reporte indéfiniment. */
  easy: 1,
  hard: -1,
} as const;

/**
 * Le **score d'un angle**, calculé localement (docs/03 §8.3 liste `score` sans en
 * fixer la formule : elle est donc écrite ici, explicitement, et révisable).
 *
 * Ce n'est **pas** le modèle qui s'auto-note : un modèle qui note ses propres
 * propositions produit un classement qui ne veut rien dire. Ce que l'utilisateur
 * voit dans l'écran de choix est donc une mesure reproductible de trois choses
 * observables — l'ancrage, la précision du déroulé, et ce que l'angle exige de
 * lui.
 */
export function scoreAngle(angle: {
  evidence: readonly string[];
  structure: readonly string[];
  difficulty: AngleDifficulty;
}): number {
  const weights = ANGLE_SCORE_WEIGHTS;
  let score = 0;
  if (angle.evidence.length >= 2) score += weights.evidence;
  if (angle.structure.length >= 4) score += weights.structure;
  if (angle.difficulty === 'faible') score += weights.easy;
  if (angle.difficulty === 'elevee') score += weights.hard;
  return Math.max(0, score);
}

/**
 * Confronte la sortie du modèle à la mémoire réelle du projet : **c'est ici que le
 * plan devient acceptable ou non**.
 *
 * Un sujet dont l'ancrage ne tient pas est **rejeté** avec ses raisons ; un angle
 * non ancré est écarté sans faire tomber le sujet (un mauvais angle parmi
 * plusieurs ne justifie pas de tout perdre). Le résultat est montré à
 * l'utilisateur : « 2 sujets sur 5 n'ont pas été retenus, voici pourquoi » vaut
 * mieux qu'un plan silencieusement incomplet.
 */
export function validatePlan(
  output: EditorialPlanOutput,
  snapshot: ProjectSnapshot,
): ValidatedPlan {
  const accepted: NewSubjectRecord[] = [];
  const rejected: RejectedSubject[] = [];
  let droppedAngles = 0;

  const recent = output.subjects.map((subject) => ({
    title: subject.title,
    pillar: subject.pillar ?? null,
  }));

  for (const subject of output.subjects) {
    const reasons: string[] = [];

    const subjectGrounding = checkGrounding(subject.evidence, snapshot.facts);
    if (subject.evidence.length === 0) {
      reasons.push('aucun fait du projet n’est cité par le sujet');
    }
    if (subjectGrounding.ungrounded.length > 0) {
      reasons.push(
        `citation(s) absente(s) de la mémoire du projet : ${subjectGrounding.ungrounded
          .map((quote) => `« ${quote} »`)
          .join(', ')}`,
      );
    }

    const angles: NewAngleRecord[] = [];
    for (const angle of subject.angles) {
      const angleGrounding = checkGrounding(angle.evidence, snapshot.facts);
      if (angle.evidence.length === 0 || angleGrounding.ungrounded.length > 0) {
        droppedAngles += 1;
        continue;
      }
      angles.push({
        hook: angle.hook,
        angleType: angle.angle_type,
        structure: angle.structure,
        estimatedLength: angle.estimated_length,
        difficulty: angle.difficulty,
        platformHint: angle.platform_hint ?? null,
        rationale: angle.rationale,
        evidence: angle.evidence,
        score: scoreAngle(angle),
      });
    }
    if (angles.length === 0) {
      reasons.push('aucun angle exploitable ne reste après vérification de l’ancrage');
    }

    if (reasons.length > 0) {
      rejected.push({ title: subject.title, reasons });
      continue;
    }

    const score = scoreSubject({
      subject: { title: subject.title, thesis: subject.thesis, pillar: subject.pillar ?? null },
      brief: snapshot.brief,
      skills: snapshot.skills,
      recentSubjects: recent,
    });
    accepted.push({
      title: subject.title,
      thesis: subject.thesis,
      pillar: subject.pillar ?? null,
      evidence: subject.evidence,
      skillCoverage: score.coverage,
      priorityScore: score.score,
      origin: 'conversation',
      masterBriefId: snapshot.brief?.id ?? null,
      conversationId: snapshot.brief?.conversationId ?? null,
      angles,
    });
  }

  return { accepted, rejected, droppedAngles };
}

export interface PlanCreationResult {
  subjects: ContentSubject[];
  angles: SubjectAngle[];
  accepted: number;
  rejected: RejectedSubject[];
  droppedAngles: number;
}

/**
 * Persiste un plan validé : un sujet « proposé avec ses angles » (statut
 * `angles_proposed`), prêt à être choisi par l'utilisateur.
 *
 * Le refus est explicite : si **aucun** sujet ne survit à la vérification, on
 * lève une erreur métier au lieu d'enregistrer un plan vide que l'utilisateur
 * prendrait pour une absence de matière.
 */
export function persistPlan(
  ports: EditorialPorts,
  projectId: string,
  plan: ValidatedPlan,
): PlanCreationResult {
  if (plan.accepted.length === 0) {
    throw new ValidationError(
      'Aucun sujet du plan ne repose sur un fait vérifié du projet : rien n’a été enregistré.',
      {
        code: 'PLAN_UNGROUNDED',
        details: { rejected: plan.rejected, droppedAngles: plan.droppedAngles },
      },
    );
  }

  const created = ports.store.createPlan({ projectId, subjects: plan.accepted });
  return {
    subjects: created.subjects,
    angles: created.angles,
    accepted: created.subjects.length,
    rejected: plan.rejected,
    droppedAngles: plan.droppedAngles,
  };
}

/**
 * Choisit un angle : le sujet passe en `selected` (le cycle de vie de
 * `SUBJECT_STATUSES` s'arrête à `proposed → selected → in_production →
 * produced → archived`) et les autres angles du sujet sont conservés avec un
 * motif de rejet — on ne jette pas le travail du modèle, on garde la trace du
 * choix (docs/03 §8.3).
 */
export function selectAngle(
  ports: EditorialPorts,
  angleId: string,
): { angle: SubjectAngle; subject: ContentSubject } {
  const angle = ports.store.getAngle(angleId);
  if (!angle) {
    throw new NotFoundError(`Angle introuvable : ${angleId}`, {
      code: 'ANGLE_NOT_FOUND',
      details: { angleId },
    });
  }
  const subject = ports.store.getSubject(angle.subjectId);
  if (!subject) {
    throw new NotFoundError(`Sujet introuvable pour l’angle ${angleId}`, {
      code: 'SUBJECT_NOT_FOUND',
      details: { angleId, subjectId: angle.subjectId },
    });
  }

  const selected = ports.store.selectAngle(angleId);
  const updated = ports.store.updateSubject(subject.id, { status: 'selected' });
  return { angle: selected, subject: updated };
}

export function rejectAngle(
  ports: EditorialPorts,
  angleId: string,
  reason: string | null,
): SubjectAngle {
  const angle = ports.store.getAngle(angleId);
  if (!angle) {
    throw new NotFoundError(`Angle introuvable : ${angleId}`, {
      code: 'ANGLE_NOT_FOUND',
      details: { angleId },
    });
  }
  return ports.store.rejectAngle(angleId, reason);
}
