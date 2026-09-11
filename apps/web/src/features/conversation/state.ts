import type { EditPlanView, MessageView, PlanProposalView } from '../../api/client';

/**
 * Logique d'écran de la conversation, **sans React** : tout ce qui peut être faux
 * et testable sans navigateur est ici (docs/09 §1 : le test le moins cher qui
 * détecte la panne). Le composant ne fait que rendre ce que ces fonctions
 * calculent.
 */

export type ProposalKind = 'fact' | 'skill' | 'audience' | 'style' | 'project';

export interface ProposalListItem {
  id: string;
  kind: ProposalKind;
  /** Ce qui sera écrit, en une ligne lisible. */
  label: string;
  /** Ce que l'utilisateur avait dit : la citation d'origine. */
  sourceQuote: string;
  status: PlanProposalView['status'];
  /** Présent ⇔ la proposition est refusée, et on sait pourquoi. */
  rejectedReason: string | null;
}

/** La citation est **toujours** affichée : c'est la preuve du fait proposé. */
export function planProposals(plan: EditPlanView): ProposalListItem[] {
  return [
    ...plan.facts.map((proposal) => ({
      id: proposal.id,
      kind: 'fact' as const,
      label: `[${proposal.category ?? 'note'}] ${proposal.statement ?? ''}`,
      sourceQuote: proposal.sourceQuote,
      status: proposal.status,
      rejectedReason: proposal.rejectedReason,
    })),
    ...plan.skills.map((proposal) => ({
      id: proposal.id,
      kind: 'skill' as const,
      label: `Compétence : ${proposal.skill ?? ''} (${proposal.level ?? '—'})`,
      sourceQuote: proposal.sourceQuote,
      status: proposal.status,
      rejectedReason: proposal.rejectedReason,
    })),
    ...plan.projectEdits.map((proposal) => ({
      id: proposal.id,
      kind: 'project' as const,
      label:
        proposal.positioning !== null && proposal.positioning !== undefined
          ? `Positionnement : ${proposal.positioning}`
          : `Objectif : ${proposal.targetGoal ?? ''}`,
      sourceQuote: proposal.sourceQuote,
      status: proposal.status,
      rejectedReason: proposal.rejectedReason,
    })),
    ...plan.audiences.map((proposal) => ({
      id: proposal.id,
      kind: 'audience' as const,
      label: `Public : ${proposal.name ?? ''}`,
      sourceQuote: proposal.sourceQuote,
      status: proposal.status,
      rejectedReason: proposal.rejectedReason,
    })),
    ...plan.styles.map((proposal) => ({
      id: proposal.id,
      kind: 'style' as const,
      label: `Voix : ${proposal.name ?? ''}`,
      sourceQuote: proposal.sourceQuote,
      status: proposal.status,
      rejectedReason: proposal.rejectedReason,
    })),
  ];
}

/** Ce qui attend une décision : ce que l'écran met en avant. */
export function pendingProposals(plan: EditPlanView): ProposalListItem[] {
  return planProposals(plan).filter((proposal) => proposal.status === 'pending');
}

/**
 * Sélection par défaut : tout ce qui est **proposé et cité**, rien de plus.
 * Une proposition refusée ne peut pas être acceptée par accident — le domaine la
 * refuserait de toute façon, et l'utilisateur verrait une erreur incompréhensible.
 */
export function defaultSelection(plan: EditPlanView): string[] {
  return pendingProposals(plan)
    .filter((proposal) => proposal.rejectedReason === null)
    .map((proposal) => proposal.id);
}

export function formatTurnCost(
  microUsd: number,
  inputTokens: number,
  outputTokens: number,
): string {
  return `${(microUsd / 1_000_000).toFixed(4)} $ · ${inputTokens} → ${outputTokens} jetons`;
}

/**
 * Fusion des messages d'un flux SSE et de l'état déjà affiché : par identifiant,
 * dans l'ordre de création. Un événement rejoué après reconnexion ne duplique
 * donc rien — c'est la moitié « reprise » de l'exigence de temps réel.
 */
export function mergeMessages(
  existing: readonly MessageView[],
  incoming: readonly MessageView[],
): MessageView[] {
  const byId = new Map<string, MessageView>();
  for (const message of [...existing, ...incoming]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt - b.createdAt,
  );
}

/** Libellés des blocs « à compléter » de la fiche maître (clés du domaine). */
export const BRIEF_FIELD_LABELS: Record<string, string> = {
  summary: 'Synthèse',
  positioning: 'Positionnement',
  target_audience: 'Public visé',
  content_pillars: 'Piliers de contenu',
  themes: 'Thèmes',
  formats: 'Formats par plateforme',
  cadence: 'Rythme',
  success_criteria: 'Critères de réussite',
};

export function briefMissingLabels(missing: readonly string[]): string[] {
  return missing.map((field) => BRIEF_FIELD_LABELS[field] ?? field);
}

/** Une phase se lit en clair : « Faits, chiffres et expériences », pas `fact_extraction`. */
export function stageSummary(
  stage: string,
  nextSlot: string | null,
  slotLabels: Record<string, string>,
): string {
  if (stage === 'closed') return 'Entretien terminé';
  if (nextSlot === null) return 'Fiche maître prête à être générée';
  return `À apprendre : ${slotLabels[nextSlot] ?? nextSlot}`;
}
