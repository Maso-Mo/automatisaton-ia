import {
  ValidationError,
  type AudienceKnowledgeLevel,
  type FactCategory,
  type InterviewerOutput,
  type PlatformId,
  type SentenceLength,
  type SkillLevel,
  type StyleTone,
} from '@aia/shared';
import type { ProjectFact } from '../projects/types';
import type { ProjectSkillFact } from '../projects/skills';
import type { AudienceProfile, StyleProfile } from '../projects/profiles';
import {
  addAudienceProfile,
  addFact,
  addStyleProfile,
  setFactVerification,
  updateProject,
  upsertSkillFact,
} from '../projects/service';
import { projectMemoryPorts, type Conversation, type ConversationPorts } from './types';

/**
 * Le **plan d'écriture** d'un tour (docs/05 §3.2, étape 8 ; docs/04 §4.1).
 *
 * « Le modèle ne **décide** pas d'écrire ; il **propose** une écriture que le
 * domaine applique après validation. » C'est la règle non négociable de la
 * mémoire : un fait entendu dans une phrase ne devient jamais un fait du projet
 * tout seul.
 *
 * Le plan est donc **stocké** dans le message de l'assistant (`content_json`) :
 * il survit à un rechargement de page, il est auditable, et l'utilisateur peut
 * l'accepter plus tard — y compris après avoir fermé son navigateur.
 *
 * Deux garde-fous sont appliqués **ici**, en code (docs/04 §6.3, niveaux 3 et 4) :
 *
 * 1. une proposition sans citation est refusée ;
 * 2. une citation qui ne se retrouve pas dans le message de l'utilisateur est
 *    refusée : un fait inventé n'a pas de citation à produire.
 */

export type ProposalStatus = 'pending' | 'accepted' | 'rejected';

export interface FactProposalEntry {
  id: string;
  category: FactCategory;
  statement: string;
  detail: string | null;
  importance: number;
  sourceQuote: string;
  status: ProposalStatus;
  /** Fait créé après acceptation : le lien qui rend le geste traçable. */
  factId: string | null;
  rejectedReason: string | null;
}

export interface SkillProposalEntry {
  id: string;
  skill: string;
  level: SkillLevel;
  isLearning: boolean;
  evidence: string | null;
  sourceQuote: string;
  status: ProposalStatus;
  skillFactId: string | null;
  rejectedReason: string | null;
}

/** Édition du projet lui-même (positionnement, objectif en clair). */
export interface ProjectEditProposalEntry {
  id: string;
  positioning: string | null;
  targetGoal: string | null;
  sourceQuote: string;
  status: ProposalStatus;
  rejectedReason: string | null;
}

export interface AudienceProposalEntry {
  id: string;
  name: string;
  description: string | null;
  knowledgeLevel: AudienceKnowledgeLevel;
  painPoints: string[];
  goals: string[];
  platforms: PlatformId[];
  sourceQuote: string;
  status: ProposalStatus;
  audienceProfileId: string | null;
  rejectedReason: string | null;
}

export interface StyleProposalEntry {
  id: string;
  name: string;
  tone: StyleTone | null;
  formality: number;
  sentenceLength: SentenceLength | null;
  forbiddenWords: string[];
  signatureOpenings: string[];
  signatureClosings: string[];
  sourceQuote: string;
  status: ProposalStatus;
  styleProfileId: string | null;
  rejectedReason: string | null;
}

export interface ConversationEditPlan {
  /** Message de l'assistant qui porte la proposition. */
  assistantMessageId: string;
  /** Message de l'utilisateur dont les citations doivent provenir. */
  sourceMessageId: string;
  reply: string;
  suggestedNext: 'continue' | 'make_brief';
  openQuestions: string[];
  facts: FactProposalEntry[];
  skills: SkillProposalEntry[];
  projectEdits: ProjectEditProposalEntry[];
  audiences: AudienceProposalEntry[];
  styles: StyleProposalEntry[];
  createdAt: number;
}

/** Toutes les entrées d'un plan, quel que soit leur type : une seule itération. */
export function planEntries(plan: ConversationEditPlan): ProposalEntry[] {
  return [...plan.facts, ...plan.skills, ...plan.projectEdits, ...plan.audiences, ...plan.styles];
}

export type ProposalEntry =
  | FactProposalEntry
  | SkillProposalEntry
  | ProjectEditProposalEntry
  | AudienceProposalEntry
  | StyleProposalEntry;

/**
 * Normalisation volontairement **minimale** : espaces, casse, apostrophes
 * typographiques. Tout le reste est refusé — une citation approximative est
 * exactement ce qu'un modèle produit quand il invente.
 */
export function normalizeQuote(value: string): string {
  return value
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isQuoteGrounded(quote: string, sourceText: string): boolean {
  const normalizedQuote = normalizeQuote(quote);
  if (normalizedQuote.length === 0) return false;
  return normalizeQuote(sourceText).includes(normalizedQuote);
}

export interface PlanFromOutputParams {
  assistantMessageId: string;
  sourceMessageId: string;
  /** Texte du message utilisateur : la seule source de citation acceptée. */
  sourceText: string;
  output: InterviewerOutput;
}

/**
 * Construit le plan d'un tour. Les propositions non citées sont conservées mais
 * marquées `rejected` avec leur raison : l'utilisateur voit ce que le modèle a
 * voulu écrire et pourquoi c'est refusé. Une donnée silencieusement jetée est
 * une donnée qu'on ne peut plus expliquer.
 */
export function planFromInterviewerOutput(
  ports: ConversationPorts,
  params: PlanFromOutputParams,
): ConversationEditPlan {
  const grounded = (quote: string): string | null =>
    isQuoteGrounded(quote, params.sourceText) ? null : 'citation introuvable dans votre message';

  const facts: FactProposalEntry[] = params.output.extracted_facts.map((proposal) => ({
    id: ports.newId(),
    category: proposal.category,
    statement: proposal.statement.trim(),
    detail: proposal.detail?.trim() ?? null,
    importance: proposal.importance,
    sourceQuote: proposal.source_quote.trim(),
    status: 'pending' as ProposalStatus,
    factId: null,
    rejectedReason: grounded(proposal.source_quote),
  }));

  const skills: SkillProposalEntry[] = params.output.skill_deltas.map((proposal) => ({
    id: ports.newId(),
    skill: proposal.skill.trim(),
    level: proposal.level,
    isLearning: proposal.is_learning,
    evidence: proposal.evidence?.trim() ?? null,
    sourceQuote: proposal.source_quote.trim(),
    status: 'pending' as ProposalStatus,
    skillFactId: null,
    rejectedReason: grounded(proposal.source_quote),
  }));

  const projectEdits: ProjectEditProposalEntry[] = params.output.project_edits.map((proposal) => ({
    id: ports.newId(),
    positioning: proposal.positioning?.trim() ?? null,
    targetGoal: proposal.target_goal?.trim() ?? null,
    sourceQuote: proposal.source_quote.trim(),
    status: 'pending' as ProposalStatus,
    rejectedReason: grounded(proposal.source_quote),
  }));

  const audiences: AudienceProposalEntry[] = params.output.proposed_audiences.map((proposal) => ({
    id: ports.newId(),
    name: proposal.name.trim(),
    description: proposal.description?.trim() ?? null,
    knowledgeLevel: proposal.knowledge_level,
    painPoints: proposal.pain_points.map((item) => item.trim()),
    goals: proposal.goals.map((item) => item.trim()),
    platforms: proposal.platforms,
    sourceQuote: proposal.source_quote.trim(),
    status: 'pending' as ProposalStatus,
    audienceProfileId: null,
    rejectedReason: grounded(proposal.source_quote),
  }));

  const styles: StyleProposalEntry[] = params.output.proposed_style
    ? [
        {
          id: ports.newId(),
          name: params.output.proposed_style.name.trim(),
          tone: params.output.proposed_style.tone ?? null,
          formality: params.output.proposed_style.formality,
          sentenceLength: params.output.proposed_style.sentence_length ?? null,
          forbiddenWords: params.output.proposed_style.forbidden_words.map((word) => word.trim()),
          signatureOpenings: params.output.proposed_style.signature_openings.map((item) =>
            item.trim(),
          ),
          signatureClosings: params.output.proposed_style.signature_closings.map((item) =>
            item.trim(),
          ),
          sourceQuote: params.output.proposed_style.source_quote.trim(),
          status: 'pending' as ProposalStatus,
          styleProfileId: null,
          rejectedReason: grounded(params.output.proposed_style.source_quote),
        },
      ]
    : [];

  const plan: ConversationEditPlan = {
    assistantMessageId: params.assistantMessageId,
    sourceMessageId: params.sourceMessageId,
    reply: params.output.reply,
    suggestedNext: params.output.suggested_next,
    openQuestions: [...params.output.open_questions],
    facts,
    skills,
    projectEdits,
    audiences,
    styles,
    createdAt: ports.clock.nowMs(),
  };

  // Les propositions non citées sont **visibles mais refusées** : l'utilisateur
  // voit ce que le modèle a voulu écrire, et pourquoi ce n'est pas accepté.
  for (const entry of planEntries(plan)) {
    if (entry.rejectedReason !== null) entry.status = 'rejected';
  }

  return plan;
}

/** Nombre de propositions encore en attente : ce que l'interface doit montrer. */
export function pendingProposalCount(plan: ConversationEditPlan): number {
  return planEntries(plan).filter((entry) => entry.status === 'pending').length;
}

export function assertPlanBelongsToConversation(
  conversation: Conversation,
  plan: ConversationEditPlan,
): void {
  if (plan.assistantMessageId.length === 0 || plan.sourceMessageId.length === 0) {
    throw new ValidationError('Plan d’écriture incomplet : message source manquant', {
      code: 'EDIT_PLAN_INCOMPLETE',
      details: { conversationId: conversation.id },
    });
  }
}

export interface ProposalDecisions {
  /** Identifiants de propositions acceptées. Vide = on ne change rien. */
  accept: readonly string[];
  /**
   * `true` : l'acceptation vaut confirmation. Le fait est créé puis confirmé —
   * deux actes datés, pas une écriture directe en `verified` (c'est impossible :
   * un fait d'origine IA naît toujours `proposed`).
   */
  confirmFacts?: boolean;
}

export interface RefusedProposal {
  proposalId: string;
  reason: string;
}

export interface ApplyEditPlanResult {
  plan: ConversationEditPlan;
  facts: ProjectFact[];
  skills: ProjectSkillFact[];
  audiences: AudienceProfile[];
  styles: StyleProfile[];
  refused: RefusedProposal[];
}

/**
 * Applique les décisions de l'utilisateur sur un plan. Tout passe par une
 * **transaction** : accepter trois faits et deux compétences écrit cinq lignes,
 * et un incident au milieu ne doit pas laisser la moitié d'un geste.
 *
 * Idempotence : réaccepter une proposition déjà acceptée ne recrée rien — elle
 * renvoie ce qui a été écrit la première fois. C'est ce qui rend un double clic
 * inoffensif.
 */
export function applyEditPlan(
  ports: ConversationPorts,
  conversation: Conversation,
  plan: ConversationEditPlan,
  decisions: ProposalDecisions,
): ApplyEditPlanResult {
  assertPlanBelongsToConversation(conversation, plan);

  const accepted = new Set(decisions.accept);
  const known = new Map<string, ProposalEntry>();
  for (const entry of planEntries(plan)) known.set(entry.id, entry);

  for (const id of accepted) {
    if (!known.has(id)) {
      throw new ValidationError(`Proposition inconnue : ${id}`, {
        code: 'PROPOSAL_NOT_FOUND',
        details: { proposalId: id, assistantMessageId: plan.assistantMessageId },
      });
    }
  }

  const memory = projectMemoryPorts(ports);
  const facts: ProjectFact[] = [];
  const skills: ProjectSkillFact[] = [];
  const audiences: AudienceProfile[] = [];
  const styles: StyleProfile[] = [];
  const refused: RefusedProposal[] = [];

  const nextPlan: ConversationEditPlan = {
    ...plan,
    facts: plan.facts.map((entry) => ({ ...entry })),
    skills: plan.skills.map((entry) => ({ ...entry })),
    projectEdits: plan.projectEdits.map((entry) => ({ ...entry })),
    audiences: plan.audiences.map((entry) => ({ ...entry })),
    styles: plan.styles.map((entry) => ({ ...entry })),
  };

  ports.store.transaction(() => {
    for (const entry of nextPlan.facts) {
      if (!accepted.has(entry.id)) continue;
      if (entry.rejectedReason !== null) {
        refused.push({ proposalId: entry.id, reason: entry.rejectedReason });
        continue;
      }
      if (entry.factId !== null) {
        const existing = ports.memory.facts.byId(entry.factId);
        if (existing) facts.push(existing);
        continue;
      }

      const created = addFact(memory, conversation.projectId, {
        category: entry.category,
        statement: entry.statement,
        detail: entry.detail,
        importance: entry.importance,
        source: 'conversation',
        sourceMessageId: plan.sourceMessageId,
      });
      const finalFact =
        decisions.confirmFacts === true
          ? setFactVerification(
              memory,
              conversation.projectId,
              created.id,
              'verified',
              'Confirmé depuis la conversation',
            )
          : created;

      entry.status = 'accepted';
      entry.factId = finalFact.id;
      facts.push(finalFact);
    }

    for (const entry of nextPlan.skills) {
      if (!accepted.has(entry.id)) continue;
      if (entry.rejectedReason !== null) {
        refused.push({ proposalId: entry.id, reason: entry.rejectedReason });
        continue;
      }
      if (entry.skillFactId !== null) {
        const existing = ports.memory.skillFacts.byId(entry.skillFactId);
        if (existing) skills.push(existing);
        continue;
      }

      const { skill } = upsertSkillFact(memory, conversation.projectId, {
        skill: entry.skill,
        level: entry.level,
        evidence: entry.evidence,
        isLearning: entry.isLearning,
        learningTarget: entry.isLearning ? entry.skill : null,
      });
      entry.status = 'accepted';
      entry.skillFactId = skill.id;
      skills.push(skill);
    }

    // Le positionnement et l'objectif du projet sont des champs de `projects` :
    // l'édition passe donc par la modification de projet existante, et non par
    // une écriture directe (docs/10 §4.2 : le domaine décide, la base stocke).
    for (const entry of nextPlan.projectEdits) {
      if (!accepted.has(entry.id) || entry.rejectedReason !== null) {
        if (accepted.has(entry.id)) {
          refused.push({ proposalId: entry.id, reason: entry.rejectedReason ?? 'refusée' });
        }
        continue;
      }
      const edit: { positioning?: string; targetGoal?: string } = {};
      if (entry.positioning !== null) edit.positioning = entry.positioning;
      if (entry.targetGoal !== null) edit.targetGoal = entry.targetGoal;
      if (Object.keys(edit).length === 0) {
        refused.push({ proposalId: entry.id, reason: 'proposition vide' });
        continue;
      }
      updateProject(memory, conversation.projectId, edit);
      entry.status = 'accepted';
    }

    for (const entry of nextPlan.audiences) {
      if (!accepted.has(entry.id)) continue;
      if (entry.rejectedReason !== null) {
        refused.push({ proposalId: entry.id, reason: entry.rejectedReason });
        continue;
      }
      if (entry.audienceProfileId !== null) {
        const existing = ports.memory.audienceProfiles.byId(entry.audienceProfileId);
        if (existing) audiences.push(existing);
        continue;
      }
      const profile = addAudienceProfile(memory, conversation.projectId, {
        name: entry.name,
        description: entry.description,
        painPoints: entry.painPoints,
        goals: entry.goals,
        knowledgeLevel: entry.knowledgeLevel,
        platforms: entry.platforms,
      });
      entry.status = 'accepted';
      entry.audienceProfileId = profile.id;
      audiences.push(profile);
    }

    for (const entry of nextPlan.styles) {
      if (!accepted.has(entry.id)) continue;
      if (entry.rejectedReason !== null) {
        refused.push({ proposalId: entry.id, reason: entry.rejectedReason });
        continue;
      }
      if (entry.styleProfileId !== null) {
        const existing = ports.memory.styleProfiles.byId(entry.styleProfileId);
        if (existing) styles.push(existing);
        continue;
      }
      const profile = addStyleProfile(memory, conversation.projectId, {
        name: entry.name,
        tone: entry.tone,
        formality: entry.formality,
        sentenceLength: entry.sentenceLength,
        forbiddenWords: entry.forbiddenWords,
        signatureOpenings: entry.signatureOpenings,
        signatureClosings: entry.signatureClosings,
      });
      entry.status = 'accepted';
      entry.styleProfileId = profile.id;
      styles.push(profile);
    }
  });

  return { plan: nextPlan, facts, skills, audiences, styles, refused };
}
