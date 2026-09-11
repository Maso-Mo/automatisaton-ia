import { ValidationError, type ConversationSlot, type ConversationStage } from '@aia/shared';
import type { ConversationMemorySnapshot } from './types';

/**
 * Les phases d'un entretien et la **liste de ce qui manque** (docs/03 §7.1,
 * docs/05 §3.1).
 *
 * C'est la pièce qui évite la première cause d'abandon d'un assistant
 * conversationnel : poser une question dont la réponse est déjà en base. Elle est
 * donc calculée **localement**, par comptage, sans aucun appel de modèle.
 *
 * L'ordre des lacunes suit l'ordre des phases documenté : les compétences
 * (`intake`), puis le positionnement, le public, la voix, les faits, la
 * stratégie. La première lacune de cette liste **est** la phase courante.
 *
 * Les valeurs vivent dans `@aia/shared` : la base les décode (colonne JSON) et
 * l'interface les affiche, sans que l'un ou l'autre dépende du domaine.
 */

export { CONVERSATION_SLOTS, conversationSlotSchema, type ConversationSlot } from '@aia/shared';

/**
 * Nombre de faits confirmés en dessous duquel la matière est jugée insuffisante
 * pour écrire quoi que ce soit de personnel. Trois : c'est le minimum pour
 * qu'un contenu ne soit pas une généralité (docs/04 §5.2, « jamais moins de 3 »).
 */
export const MIN_VERIFIED_FACTS_FOR_BRIEF = 3;

export const CONVERSATION_SLOT_LABELS: Record<ConversationSlot, string> = {
  skills: 'Compétences (ce que vous savez faire)',
  positioning: 'Positionnement (ce pour quoi vous voulez être reconnu)',
  audience: 'Public visé',
  voice: 'Voix (votre façon de parler)',
  facts: `Faits confirmés (au moins ${MIN_VERIFIED_FACTS_FOR_BRIEF})`,
  strategy: 'Stratégie (rythme, plateformes, objectifs)',
};

/** La phase documentée qui comble chaque lacune. */
export const STAGE_FOR_SLOT: Record<ConversationSlot, ConversationStage> = {
  skills: 'intake',
  positioning: 'positioning',
  audience: 'audience',
  voice: 'voice',
  facts: 'fact_extraction',
  strategy: 'strategy',
};

/**
 * Question à poser pour une lacune : la trame est **locale**, donc gratuite et
 * vérifiable. Le modèle la reformule, il ne la choisit pas (docs/03 §7.1).
 */
export const SLOT_GUIDANCE: Record<ConversationSlot, string> = {
  skills: 'Demander ce que l’utilisateur sait faire lui-même, et ce qu’il ne sait pas faire.',
  positioning: 'Demander ce pour quoi il veut être reconnu, en une phrase.',
  audience: 'Demander à qui il parle et à quel niveau.',
  voice: 'Demander comment il parle : ton, mots interdits, formulations qu’il aime.',
  facts: 'Demander des faits vécus : chiffres, résultats, erreurs, décisions.',
  strategy: 'Demander le rythme, les plateformes et l’objectif mesurable.',
};

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Ce qui manque à la mémoire du projet, dans l'ordre des phases. Une seule
 * source de vérité : `conversations.missing_slots_json` est le produit de cette
 * fonction, jamais une valeur écrite à la main (docs/03 §7.1).
 */
export function computeMissingSlots(snapshot: ConversationMemorySnapshot): ConversationSlot[] {
  const missing: ConversationSlot[] = [];
  if (snapshot.skillFacts < 1) missing.push('skills');
  if (!hasText(snapshot.positioning)) missing.push('positioning');
  if (snapshot.audienceProfiles < 1) missing.push('audience');
  if (snapshot.styleProfiles < 1) missing.push('voice');
  if (snapshot.verifiedFacts < MIN_VERIFIED_FACTS_FOR_BRIEF) missing.push('facts');
  // La stratégie est connue dès qu'un objectif existe, en clair (`projects.target_goal`)
  // ou mesurable (`project_goals`). Exiger les deux obligerait à inventer un chiffre.
  if (snapshot.goals < 1 && !hasText(snapshot.targetGoal)) missing.push('strategy');
  return missing;
}

/**
 * Transitions autorisées. Elles ne sont **pas** une promenade linéaire : si
 * l'utilisateur donne tout d'un coup, des phases sont sautées ; si un fait
 * confirmé est invalidé, une phase redevient courante. Une seule interdiction :
 * quitter `closed` sans réouverture explicite — un entretien terminé ne se
 * rouvre pas par accident.
 */
export const STAGES_REACHABLE_FROM_CLOSED = ['brief_ready'] as const;

export function canTransitionStage(from: ConversationStage, to: ConversationStage): boolean {
  if (from === to) return true;
  if (from !== 'closed') return true;
  return (STAGES_REACHABLE_FROM_CLOSED as readonly ConversationStage[]).includes(to);
}

export function assertStageTransition(from: ConversationStage, to: ConversationStage): void {
  if (canTransitionStage(from, to)) return;
  throw new ValidationError(
    `Transition de phase interdite : ${from} → ${to}. Une conversation terminée se rouvre explicitement.`,
    { code: 'CONVERSATION_STAGE_TRANSITION_INVALID', details: { from, to } },
  );
}

export interface NextStageOptions {
  /** Une fiche maître existe (brouillon ou validée) pour cette conversation. */
  hasBrief: boolean;
  /** L'utilisateur a terminé l'entretien. */
  closed?: boolean;
}

/**
 * Phase suivante, décidée par du **code** : la première information manquante
 * désigne la phase. Quand plus rien ne manque, la conversation passe en
 * `brief_ready` — c'est-à-dire « on peut écrire la fiche maître », pas « on va
 * générer du contenu » (docs/05 §3.4 : rien ne se déclenche tout seul).
 */
export function nextStage(
  missing: readonly ConversationSlot[],
  options: NextStageOptions,
): ConversationStage {
  if (options.closed) return 'closed';
  const first = missing[0];
  if (first === undefined) return options.hasBrief ? 'brief_ready' : 'strategy';
  return STAGE_FOR_SLOT[first] ?? 'strategy';
}
