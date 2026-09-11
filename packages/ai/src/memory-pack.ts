import { estimatePromptTokens } from './pricing';

/**
 * Le **paquet de mémoire** (docs/04 §5.1) : ce que le modèle voit du projet, ni
 * plus ni moins.
 *
 * Trois règles, toutes vérifiables :
 *
 * 1. **Sélection locale** : les faits sont choisis par `@aia/core` (importance ×
 *    récence ÷ usages), pas par le modèle, et pas par un embedding
 *    (docs/04 §5.3 : pas de RAG en V1) ;
 * 2. **Budget** : au dépassement, on sacrifie d'abord les apprentissages, puis la
 *    fenêtre anti-répétition, puis les faits au-delà de trois. On ne sacrifie
 *    **jamais** le style, l'audience ni les compétences — un contenu sans voix
 *    n'est pas un contenu de cet utilisateur (docs/04 §5.2) ;
 * 3. **Manifeste** : les identifiants retenus sont journalisés, donc un résultat
 *    inattendu reste explicable.
 *
 * Le paquet est **immuable pendant un tour** : il est construit une fois, et tous
 * les appels du même tour voient le même contexte.
 */

export interface MemoryPackProject {
  id: string;
  name: string;
  status: string;
  positioning: string | null;
  targetGoal: string | null;
  language: string;
}

export interface MemoryPackFact {
  id: string;
  category: string;
  statement: string;
  detail: string | null;
  importance: number;
  verificationStatus: string;
}

export interface MemoryPackSkill {
  skill: string;
  level: string;
  evidence: string | null;
}

export interface MemoryPackAudience {
  name: string;
  description: string | null;
  knowledgeLevel: string;
  painPoints: string[];
}

export interface MemoryPackStyle {
  name: string;
  tone: string | null;
  formality: number;
  forbiddenWords: string[];
}

export interface MemoryPack {
  project: MemoryPackProject;
  skillFacts: MemoryPackSkill[];
  facts: MemoryPackFact[];
  style: MemoryPackStyle | null;
  audience: MemoryPackAudience | null;
  /** Vide en V1 : la table `learnings` arrive à l'étape analytics (docs/10 §4.11). */
  learnings: string[];
  /** Vide en V1 : l'anti-répétition arrive avec l'étape éditoriale. */
  recentContent: { title: string; platform: string }[];
  manifest: {
    factIds: string[];
    skillNames: string[];
    audienceName: string | null;
    styleName: string | null;
    /** Jetons d'entrée estimés, sans le prompt d'instruction. */
    estimatedTokens: number;
  };
  /** Faits écartés faute de budget : visible, donc discutable. */
  droppedFactIds: string[];
}

export interface MemoryPackInput {
  project: MemoryPackProject;
  facts: readonly MemoryPackFact[];
  skillFacts: readonly MemoryPackSkill[];
  audience?: MemoryPackAudience | null;
  style?: MemoryPackStyle | null;
}

/** Budgets documentés (docs/04 §5.2), en jetons estimés. */
export const MEMORY_BUDGET = {
  facts: 1_500,
  skills: 400,
  styleAndAudience: 700,
} as const;

/** « Jamais moins de 3 faits » : c'est le plancher du contexte utile. */
export const MIN_FACTS_IN_PACK = 3;

export function buildMemoryPack(input: MemoryPackInput): MemoryPack {
  const keptSkills = trimToBudget(
    [...input.skillFacts],
    MEMORY_BUDGET.skills + MEMORY_BUDGET.styleAndAudience,
    (skill) => skill.skill,
  );

  const selected: MemoryPackFact[] = [];
  const dropped: string[] = [];
  let used = 0;

  for (const fact of input.facts) {
    const cost = estimatePromptTokens(renderFact(fact));
    if (used + cost > MEMORY_BUDGET.facts && selected.length >= MIN_FACTS_IN_PACK) {
      dropped.push(fact.id);
      continue;
    }
    selected.push(fact);
    used += cost;
  }

  return {
    project: input.project,
    skillFacts: keptSkills,
    facts: selected,
    style: input.style ?? null,
    audience: input.audience ?? null,
    learnings: [],
    recentContent: [],
    manifest: {
      factIds: selected.map((fact) => fact.id),
      skillNames: keptSkills.map((skill) => skill.skill),
      audienceName: input.audience?.name ?? null,
      styleName: input.style?.name ?? null,
      estimatedTokens: used + estimatePromptTokens(keptSkills.map(renderSkill).join('\n')),
    },
    droppedFactIds: dropped,
  };
}

function trimToBudget<T>(items: T[], budgetTokens: number, label: (item: T) => string): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items) {
    const cost = estimatePromptTokens(label(item));
    if (used + cost > budgetTokens) break;
    kept.push(item);
    used += cost;
  }
  return kept;
}

function renderFact(fact: MemoryPackFact): string {
  return `- [${fact.category}] ${fact.statement}${fact.detail ? ` — ${fact.detail}` : ''}`;
}

function renderSkill(skill: MemoryPackSkill): string {
  return `- ${skill.skill} (${skill.level})`;
}

/**
 * Rendu textuel du paquet, injecté dans le prompt. C'est un **rendu**, pas une
 * donnée : aucun de ces éléments n'est écrit dans un fichier de prompt
 * (docs/04 §6.1 : « un prompt est une instruction, pas un document de données »).
 */
export function renderMemoryPack(
  pack: MemoryPack,
  missingCategories: readonly string[] = [],
): string {
  const lines: string[] = [];
  lines.push('## Projet');
  lines.push(`Nom : ${pack.project.name}`);
  if (pack.project.positioning) lines.push(`Positionnement : ${pack.project.positioning}`);
  if (pack.project.targetGoal) lines.push(`Objectif déclaré : ${pack.project.targetGoal}`);

  lines.push('', '## Ce que la personne sait faire (ne jamais lui prêter une autre compétence)');
  lines.push(
    pack.skillFacts.length === 0
      ? 'Aucune compétence confirmée pour l’instant.'
      : pack.skillFacts.map(renderSkill).join('\n'),
  );

  lines.push('', '## Faits confirmés du projet');
  lines.push(
    pack.facts.length === 0
      ? 'Aucun fait confirmé : ne rien affirmer de factuel.'
      : pack.facts.map(renderFact).join('\n'),
  );

  if (pack.audience) {
    lines.push('', '## Public');
    lines.push(`${pack.audience.name} (niveau ${pack.audience.knowledgeLevel})`);
    if (pack.audience.description) lines.push(pack.audience.description);
    if (pack.audience.painPoints.length > 0) {
      lines.push(`Points de douleur : ${pack.audience.painPoints.join(' · ')}`);
    }
  }

  if (pack.style) {
    lines.push('', '## Voix');
    const parts = [pack.style.name];
    if (pack.style.tone) parts.push(`ton ${pack.style.tone}`);
    parts.push(`registre ${pack.style.formality}/5`);
    lines.push(parts.join(' · '));
    if (pack.style.forbiddenWords.length > 0) {
      lines.push(`Mots interdits : ${pack.style.forbiddenWords.join(', ')}`);
    }
  }

  if (missingCategories.length > 0) {
    lines.push('', '## Informations que la mémoire ne contient PAS encore');
    lines.push(missingCategories.join(', '));
  }

  return lines.join('\n');
}
