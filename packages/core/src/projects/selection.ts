import { MS_PER_DAY, type FactCategory, type FactVerificationStatus } from '@aia/shared';
import { isActiveFact, isTrustedFact } from './facts';
import type { Project, ProjectFact } from './types';

/**
 * Sélection **déterministe** du contexte (docs/03 §6.6, docs/10 §4.2).
 *
 * Décision d'étape assumée : ce choix est **local, gratuit et sans IA**
 * (pas d'embedding, pas de RAG, pas de LLM — docs/10 §4.2 « Interdits »,
 * docs/11 §5.2). Il est donc reproductible : mêmes faits + même date ⇒ même
 * paquet de contexte, ce qu'un classement par modèle ne garantit pas.
 *
 * Score documenté : `importance × récence ÷ (used_count + 1)` — un fait répété
 * sort plus tard, sans qu'aucun modèle n'intervienne.
 */

/** Demi-vie de la récence : un fait de 90 jours pèse moitié moins qu'un fait du jour. */
export const RECENCY_HALF_LIFE_DAYS = 90;

/** Les seize catégories de connaissance du projet demandées à l'étape 2. */
export const PROJECT_KNOWLEDGE_CATEGORIES = [
  'description',
  'motivation',
  'probleme',
  'stack',
  'technologie',
  'architecture',
  'fonctionnalite',
  'decision',
  'difficulte',
  'erreur',
  'solution',
  'apprentissage',
  'etat_actuel',
  'prochaine_etape',
  'url',
  'note',
] as const satisfies readonly FactCategory[];

export interface ContextSelectionOptions {
  categories?: readonly FactCategory[];
  statuses?: readonly FactVerificationStatus[];
  /** Nombre maximal de faits — docs/03 §6.6 : 5 à 8, jamais « tout ». */
  limit?: number;
  /** `true` : inclut les faits non confirmés (mode brouillon, docs/03 §6.1). */
  includeUnverified?: boolean;
  /** Bornes de date sur `created_at` (filtre optionnel, docs/10 §4.2). */
  sinceMs?: number;
  untilMs?: number;
  nowMs: number;
}

export interface SelectedFact {
  fact: ProjectFact;
  score: number;
}

export interface ExclusionCounts {
  /** Faits non confirmés écartés parce que `includeUnverified` est faux. */
  unverified: number;
  /** Faits obsolètes ou remplacés : jamais dans un contexte. */
  inactive: number;
  /** Faits écartés par les filtres de catégorie, d'état ou de date. */
  filtered: number;
}

export interface ProjectContext {
  projectId: string;
  projectName: string;
  generatedAt: number;
  facts: SelectedFact[];
  excluded: ExclusionCounts;
  /** Catégories de connaissance du projet encore vides : ce qu'il reste à dire. */
  missingCategories: FactCategory[];
}

/** Récence bornée : jamais nulle, donc un vieux fait important reste sélectionnable. */
export function recencyFactor(updatedAtMs: number, nowMs: number): number {
  const ageDays = Math.max(0, (nowMs - updatedAtMs) / MS_PER_DAY);
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function scoreFact(fact: ProjectFact, nowMs: number): number {
  return (fact.importance * recencyFactor(fact.updatedAt, nowMs)) / (fact.usedCount + 1);
}

interface FilterOutcome {
  selected: SelectedFact[];
  excluded: ExclusionCounts;
}

function applyFilters(
  facts: readonly ProjectFact[],
  options: ContextSelectionOptions,
): FilterOutcome {
  const excluded: ExclusionCounts = { unverified: 0, inactive: 0, filtered: 0 };
  const selected: SelectedFact[] = [];

  for (const fact of facts) {
    if (!isActiveFact(fact)) {
      excluded.inactive += 1;
      continue;
    }
    const trustedEnough = options.includeUnverified === true || isTrustedFact(fact);
    if (!trustedEnough) {
      excluded.unverified += 1;
      continue;
    }
    if (options.categories && !options.categories.includes(fact.category)) {
      excluded.filtered += 1;
      continue;
    }
    if (options.statuses && !options.statuses.includes(fact.verificationStatus)) {
      excluded.filtered += 1;
      continue;
    }
    if (options.sinceMs !== undefined && fact.createdAt < options.sinceMs) {
      excluded.filtered += 1;
      continue;
    }
    if (options.untilMs !== undefined && fact.createdAt > options.untilMs) {
      excluded.filtered += 1;
      continue;
    }
    selected.push({ fact, score: scoreFact(fact, options.nowMs) });
  }

  return { selected, excluded };
}

/**
 * Ordre **total** et stable : score, puis importance, puis récence, puis
 * identifiant. Sans cette dernière clé, deux faits de même score sortiraient
 * dans un ordre dépendant du parcours de la base — donc non reproductible.
 */
function compareSelected(a: SelectedFact, b: SelectedFact): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.fact.importance !== a.fact.importance) return b.fact.importance - a.fact.importance;
  if (b.fact.updatedAt !== a.fact.updatedAt) return b.fact.updatedAt - a.fact.updatedAt;
  return a.fact.id < b.fact.id ? -1 : a.fact.id > b.fact.id ? 1 : 0;
}

export function selectProjectFacts(
  facts: readonly ProjectFact[],
  options: ContextSelectionOptions,
): FilterOutcome {
  const { selected, excluded } = applyFilters(facts, options);
  selected.sort(compareSelected);
  const limit = options.limit ?? 8;
  return { selected: selected.slice(0, Math.max(0, limit)), excluded };
}

/**
 * Paquet de contexte d'un projet : faits retenus, faits écartés (et pourquoi),
 * catégories encore vides. Aucun appel réseau, aucune écriture : sélectionner
 * un contexte n'incrémente pas `used_count` (c'est l'injection réelle dans un
 * prompt qui le fera, à l'étape 4).
 */
export function buildProjectContext(
  project: Project,
  facts: readonly ProjectFact[],
  options: ContextSelectionOptions,
): ProjectContext {
  const { selected, excluded } = selectProjectFacts(facts, options);
  const known = new Set(facts.filter((fact) => isActiveFact(fact)).map((fact) => fact.category));
  const missingCategories = PROJECT_KNOWLEDGE_CATEGORIES.filter((category) => !known.has(category));

  return {
    projectId: project.id,
    projectName: project.name,
    generatedAt: options.nowMs,
    facts: selected,
    excluded,
    missingCategories,
  };
}
