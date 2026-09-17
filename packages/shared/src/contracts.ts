import { z } from 'zod';
import {
  angleDifficultySchema,
  angleLengthSchema,
  angleTypeSchema,
  audienceKnowledgeLevelSchema,
  factCategorySchema,
  messageTypeSchema,
  platformIdSchema,
  sentenceLengthSchema,
  skillLevelSchema,
  styleToneSchema,
} from './enums';

/**
 * Contrats **échangés avec un modèle** (docs/02 §5 : « schémas de la fiche maître,
 * des variantes plateforme, des statuts »). Ils vivent dans `@aia/shared` pour une
 * raison précise : le domaine (`@aia/core`) et le paquet IA (`@aia/ai`) doivent
 * valider **le même contrat**, et aucun des deux ne peut importer l'autre
 * (docs/02 §5). Dupliquer ces schémas serait la garantie qu'ils divergent.
 *
 * Nommage : ces objets sont la **sortie brute d'un modèle**, donc en
 * `snake_case`, tels qu'ils sont écrits dans les prompts (docs/04 §6.1). Le
 * domaine les convertit en objets métier `camelCase` en un seul endroit.
 */

/** Bornes de la fiche maître : un brief trop long pollue tous les appels suivants. */
export const BRIEF_SUMMARY_MAX = 2_000;
export const BRIEF_POSITIONING_MAX = 600;
export const BRIEF_AUDIENCE_MAX = 1_000;
export const BRIEF_PILLARS_MIN = 2;
export const BRIEF_PILLARS_MAX = 5;
export const BRIEF_THEMES_MAX = 12;
export const BRIEF_QUOTE_MIN = 8;
export const BRIEF_QUOTE_MAX = 600;

/**
 * Fiche maître telle que le `strategist` la produit (docs/04 §4.2).
 *
 * Les trois premiers champs sont **exigés** : sans positionnement, sans public et
 * sans synthèse, une fiche maître ne sert à rien, et le domaine refuse de
 * générer avant que ces informations existent (`ProjectNotReadyError`).
 * Les blocs suivants sont **nullables** : « un trou visible vaut mieux qu'une
 * invention plausible » — le modèle écrit `null`, l'interface affiche
 * « à compléter », et l'intervieweur pose la question au tour suivant.
 */
export const masterBriefContentSchema = z.object({
  summary: z.string().min(1).max(BRIEF_SUMMARY_MAX),
  positioning: z.string().min(1).max(BRIEF_POSITIONING_MAX),
  target_audience: z.string().min(1).max(BRIEF_AUDIENCE_MAX),
  content_pillars: z
    .array(z.string().min(2).max(160))
    .min(BRIEF_PILLARS_MIN)
    .max(BRIEF_PILLARS_MAX),
  themes: z.array(z.string().min(2).max(200)).min(1).max(BRIEF_THEMES_MAX),
  formats: z
    .array(
      z.object({
        platform: platformIdSchema,
        formats: z.array(z.string().min(1).max(60)).min(1).max(8),
      }),
    )
    .max(8)
    .nullish(),
  skill_map: z
    .array(
      z.object({
        skill: z.string().min(2).max(120),
        level: skillLevelSchema,
        is_learning: z.boolean().default(false),
      }),
    )
    .max(24)
    .nullish(),
  /** Ce que l'utilisateur ne maîtrise PAS : utilisé en négatif, jamais en positif. */
  gaps: z.array(z.string().min(2).max(200)).max(16).nullish(),
  cadence: z
    .array(z.object({ platform: platformIdSchema, per_week: z.number().int().min(0).max(21) }))
    .max(8)
    .nullish(),
  success_criteria: z.array(z.string().min(2).max(200)).max(8).nullish(),
  /** Ce qui reste à apprendre, selon le modèle — l'interface le montre tel quel. */
  open_questions: z.array(z.string().min(3).max(300)).max(8).nullish(),
});
export type MasterBriefContent = z.infer<typeof masterBriefContentSchema>;

/**
 * Fait proposé par l'intervieweur (docs/04 §4.1).
 *
 * `source_quote` est **obligatoire** : c'est le garde-fou de niveau 3 de
 * docs/04 §6.3. Un fait sans citation n'est pas rejeté par le modèle, il est
 * rejeté par le domaine — et un fait inventé n'a pas de citation à produire,
 * puisque la citation doit se retrouver **dans le message de l'utilisateur**.
 */
export const factProposalSchema = z.object({
  category: factCategorySchema,
  statement: z.string().min(8).max(500),
  detail: z.string().max(4_000).nullish(),
  importance: z.number().int().min(1).max(5).default(3),
  source_quote: z.string().min(BRIEF_QUOTE_MIN).max(BRIEF_QUOTE_MAX),
});
export type FactProposal = z.infer<typeof factProposalSchema>;

export const skillProposalSchema = z.object({
  skill: z.string().min(2).max(120),
  level: skillLevelSchema,
  is_learning: z.boolean().default(false),
  evidence: z.string().max(600).nullish(),
  source_quote: z.string().min(BRIEF_QUOTE_MIN).max(BRIEF_QUOTE_MAX),
});
export type SkillProposal = z.infer<typeof skillProposalSchema>;

/**
 * Édition du projet proposée par l'entretien (phases `positioning` et
 * `strategy`, docs/05 §3.1). Elle n'est jamais appliquée directement : elle
 * passe par le même chemin que les faits — proposition, puis acceptation.
 */
export const projectEditProposalSchema = z.object({
  positioning: z.string().min(1).max(600).nullish(),
  target_goal: z.string().min(1).max(300).nullish(),
  source_quote: z.string().min(BRIEF_QUOTE_MIN).max(BRIEF_QUOTE_MAX),
});
export type ProjectEditProposal = z.infer<typeof projectEditProposalSchema>;

/** Public visé proposé (phase `audience`) : c'est le profil qui sera créé. */
export const audienceProposalSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(1_000).nullish(),
  knowledge_level: audienceKnowledgeLevelSchema.default('debutant'),
  pain_points: z.array(z.string().min(2).max(200)).max(10).default([]),
  goals: z.array(z.string().min(2).max(200)).max(10).default([]),
  platforms: z.array(platformIdSchema).max(7).default([]),
  source_quote: z.string().min(BRIEF_QUOTE_MIN).max(BRIEF_QUOTE_MAX),
});
export type AudienceProposal = z.infer<typeof audienceProposalSchema>;

/** Voix proposée (phase `voice`) : un profil de style décrit, jamais imité. */
export const styleProposalSchema = z.object({
  name: z.string().min(2).max(120).default('Voix du projet'),
  tone: styleToneSchema.nullish(),
  formality: z.number().int().min(1).max(5).default(3),
  sentence_length: sentenceLengthSchema.nullish(),
  forbidden_words: z.array(z.string().min(1).max(60)).max(20).default([]),
  signature_openings: z.array(z.string().min(2).max(120)).max(5).default([]),
  signature_closings: z.array(z.string().min(2).max(120)).max(5).default([]),
  source_quote: z.string().min(BRIEF_QUOTE_MIN).max(BRIEF_QUOTE_MAX),
});
export type StyleProposal = z.infer<typeof styleProposalSchema>;

/**
 * Sortie structurée de l'agent `interviewer` (docs/04 §4.1). L'agent **propose**
 * (`extracted_facts`, `skill_deltas`, éditions, profils) : l'écriture n'est
 * appliquée par le domaine qu'après validation de l'utilisateur (docs/05 §3.2).
 */
export const interviewerOutputSchema = z.object({
  reply: z.string().min(1).max(4_000),
  message_type: messageTypeSchema.default('text'),
  /** Choix proposés quand le message est une question à options. */
  question_options: z.array(z.string().min(1).max(200)).max(6).nullish(),
  extracted_facts: z.array(factProposalSchema).max(8).default([]),
  skill_deltas: z.array(skillProposalSchema).max(8).default([]),
  project_edits: z.array(projectEditProposalSchema).max(2).default([]),
  proposed_audiences: z.array(audienceProposalSchema).max(2).default([]),
  proposed_style: styleProposalSchema.nullish(),
  open_questions: z.array(z.string().min(3).max(300)).max(6).default([]),
  suggested_next: z.enum(['continue', 'make_brief']).default('continue'),
});
export type InterviewerOutput = z.infer<typeof interviewerOutputSchema>;

/** Sortie structurée de l'agent `strategist`, tâche `master_brief` (docs/04 §4.2). */
export const masterBriefOutputSchema = z.object({
  master_brief: masterBriefContentSchema,
});
export type MasterBriefOutput = z.infer<typeof masterBriefOutputSchema>;

// --- Étape 4 : plan éditorial (sujets et angles) --------------------------

export const SUBJECT_TITLE_MAX = 160;
export const SUBJECT_THESIS_MAX = 300;
export const SUBJECT_EVIDENCE_MAX = 8;
export const EDITORIAL_SUBJECTS_MIN = 3;
export const EDITORIAL_SUBJECTS_MAX = 5;
export const ANGLES_PER_SUBJECT_MIN = 2;
export const ANGLES_PER_SUBJECT_MAX = 3;
export const ANGLE_HOOK_MAX = 200;
export const ANGLE_STRUCTURE_MAX = 8;
export const ANGLE_RATIONALE_MAX = 400;
export const ANGLE_EVIDENCE_MAX = 6;
/** Longueur minimale d'un extrait d'ancrage : en dessous, ce n'est pas une citation. */
export const EVIDENCE_QUOTE_MIN = 6;
export const EVIDENCE_QUOTE_MAX = 300;

/**
 * Un **angle** proposé par le `strategist` (docs/04 §4.2) : un regard précis sur
 * un sujet, pas encore un contenu. `structure` est le déroulé prévu, et
 * `evidence` l'**ancrage factuel** exigé par docs/04 §4.2 : au moins un extrait
 * repris d'un fait du projet.
 *
 * L'ancrage est une **citation**, pas un identifiant : le paquet de mémoire
 * affiche les faits en texte (docs/04 §5.1), donc demander un identifiant
 * ferait inventer des identifiants. Le domaine vérifie que chaque extrait
 * existe bien dans les faits fournis — c'est ce qui rejette un sujet sans
 * ancrage, sans faire confiance au modèle.
 */
export const angleProposalSchema = z.object({
  hook: z.string().min(10).max(ANGLE_HOOK_MAX),
  angle_type: angleTypeSchema,
  structure: z.array(z.string().min(2).max(160)).min(2).max(ANGLE_STRUCTURE_MAX),
  estimated_length: angleLengthSchema,
  difficulty: angleDifficultySchema,
  /** Indice optionnel : un angle né d'une plateforme n'interdit pas les autres. */
  platform_hint: platformIdSchema.nullish(),
  rationale: z.string().min(10).max(ANGLE_RATIONALE_MAX),
  evidence: z
    .array(z.string().min(EVIDENCE_QUOTE_MIN).max(EVIDENCE_QUOTE_MAX))
    .min(1)
    .max(ANGLE_EVIDENCE_MAX),
});
export type AngleProposal = z.infer<typeof angleProposalSchema>;

/** Un **sujet** : une unité de sens indépendante d'une plateforme (docs/03 §8.2). */
export const subjectProposalSchema = z.object({
  title: z.string().min(4).max(SUBJECT_TITLE_MAX),
  thesis: z.string().min(10).max(SUBJECT_THESIS_MAX),
  /** Pilier de contenu repris de la fiche maître, quand il est connu. */
  pillar: z.string().min(2).max(160).nullish(),
  evidence: z
    .array(z.string().min(EVIDENCE_QUOTE_MIN).max(EVIDENCE_QUOTE_MAX))
    .min(1)
    .max(SUBJECT_EVIDENCE_MAX),
  angles: z.array(angleProposalSchema).min(ANGLES_PER_SUBJECT_MIN).max(ANGLES_PER_SUBJECT_MAX),
});
export type SubjectProposal = z.infer<typeof subjectProposalSchema>;

/** Sortie du `strategist`, tâche `angles` : 3 à 5 sujets, 2 à 3 angles chacun. */
export const editorialPlanOutputSchema = z.object({
  subjects: z.array(subjectProposalSchema).min(EDITORIAL_SUBJECTS_MIN).max(EDITORIAL_SUBJECTS_MAX),
});
export type EditorialPlanOutput = z.infer<typeof editorialPlanOutputSchema>;

// --- Étape 4 : brouillons multi-plateformes -------------------------------

/** Un corps de brouillon : au minimum un message court de réseau social. */
export const DRAFT_BODY_MIN = 40;
export const DRAFT_BODY_MAX = 20_000;
export const DRAFT_HOOK_MAX = 600;
export const DRAFT_TITLE_MAX = 300;
export const DRAFT_HASHTAGS_MAX = 12;
export const DRAFT_MENTIONS_MAX = 12;
export const DRAFT_NOTES_MAX = 8;

/**
 * Brouillon d'**une** cible (docs/04 §4.3) : `Draft` et `ScriptDraft` réunis.
 *
 * `body` porte tout ce qui sera publié — le texte du post, le script à dire, ou
 * le plan horodaté d'une vidéo longue. Rien n'est perdu en route : ce qui n'a
 * pas de colonne dans `content_versions` (le CTA, la structure d'un script) est
 * **dans** le corps, parce que c'est ce que l'utilisateur collera dans l'outil
 * de la plateforme.
 *
 * `notes` n'est pas décoratif : ce sont les avertissements opérationnels que la
 * plateforme exige et que le produit ne peut pas deviner — « flair obligatoire,
 * à renseigner », « vérifiez la règle d'auto-promotion du subreddit »,
 * « subreddit choisi par l'utilisateur » (docs/06 §5.2). Ils deviennent des
 * `content_review_notes` visibles à côté du texte, jamais un log.
 */
export const targetDraftSchema = z.object({
  title: z.string().min(2).max(DRAFT_TITLE_MAX).nullish(),
  hook: z.string().min(2).max(DRAFT_HOOK_MAX),
  body: z.string().min(DRAFT_BODY_MIN).max(DRAFT_BODY_MAX),
  hashtags: z.array(z.string().min(1).max(60)).max(DRAFT_HASHTAGS_MAX).default([]),
  mentions: z.array(z.string().min(1).max(80)).max(DRAFT_MENTIONS_MAX).default([]),
  notes: z.array(z.string().min(2).max(300)).max(DRAFT_NOTES_MAX).default([]),
});
export type TargetDraft = z.infer<typeof targetDraftSchema>;

/**
 * Sortie du `platform_writer` (docs/04 §4.3) : **un appel couvre toutes les
 * cibles demandées**. Les clés sont les `ContentTarget` — le schéma ne les
 * impose pas, parce qu'une régénération ciblée n'en demande qu'une ; c'est le
 * domaine qui vérifie que toutes les cibles demandées sont présentes et
 * qu'aucune ne s'est invitée.
 */
export const contentDraftsOutputSchema = z.object({
  drafts: z.record(z.string().min(1).max(40), targetDraftSchema),
});
export type ContentDraftsOutput = z.infer<typeof contentDraftsOutputSchema>;
