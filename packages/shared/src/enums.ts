import { z } from 'zod';

/**
 * Toute valeur d'énumération existe aux TROIS endroits, dans ce seul fichier :
 * le tableau `as const`, le type TypeScript dérivé, et le schéma Zod
 * (docs/03 §2.3). Un test vérifie que les trois ne divergent jamais
 * (`enums.test.ts`), ce qui rend impossible l'ajout d'une valeur « à moitié ».
 *
 * Les valeurs sont stockées en `TEXT` avec contrainte dans la base : un texte
 * est lisible en base, dans les journaux et dans les exports.
 */

// --- Application -----------------------------------------------------------

export const APP_ENVS = ['development', 'test', 'production'] as const;
export type AppEnv = (typeof APP_ENVS)[number];
export const appEnvSchema = z.enum(APP_ENVS);

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const logLevelSchema = z.enum(LOG_LEVELS);

// --- Jobs (docs/08 §3) -----------------------------------------------------

export const JOB_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'dead',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusSchema = z.enum(JOB_STATUSES);

/** Statuts pour lesquels un `dedupe_key` est encore « actif » (docs/03 §14.1). */
export const ACTIVE_JOB_STATUSES = ['queued', 'running'] as const satisfies readonly JobStatus[];

// --- Erreurs (docs/02 §12) -------------------------------------------------

export const ERROR_CATEGORIES = [
  'validation',
  'auth',
  'forbidden',
  'not_found',
  'conflict',
  'transient',
  'budget',
  'capability',
  'ambiguous',
  'internal',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export const errorCategorySchema = z.enum(ERROR_CATEGORIES);

// --- Projets et mémoire ----------------------------------------------------

export const PROJECT_STATUSES = ['discovery', 'active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const projectStatusSchema = z.enum(PROJECT_STATUSES);

/**
 * Catégories de faits (docs/03 §6.1). Deux familles, volontairement séparées :
 *
 * 1. **biographie et vécu** — ce qui rend un contenu personnel (étapes 3 à 8) ;
 * 2. **connaissance du projet** — ce que l'utilisateur sait de son propre projet
 *    (étape 2). Stoker ces informations en faits typés plutôt qu'en un seul champ
 *    de texte libre permet de les filtrer, de les dater et de les remplacer
 *    (docs/03 §2.5 : « on ne requête jamais dans du JSON »).
 */
export const FACT_CATEGORIES = [
  // 1. Biographie et vécu
  'experience',
  'chiffre',
  'opinion',
  'projet',
  'echec',
  'ressource',
  'contrainte',
  // 2. Connaissance du projet (étape 2)
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
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
export const factCategorySchema = z.enum(FACT_CATEGORIES);

/**
 * État de vérification d'un fait (docs/03 §6.1, docs/05 §3). `verified_by_user`
 * ne suffit pas : il faut distinguer « l'IA l'a proposé », « l'utilisateur l'a
 * saisi », « l'utilisateur l'a confirmé », « c'est incertain » et « c'est
 * remplacé » — sinon un fait faux et un fait confirmé sont indiscernables.
 */
export const FACT_VERIFICATION_STATUSES = [
  'proposed',
  'user_provided',
  'verified',
  'uncertain',
  'obsolete',
  'superseded',
] as const;
export type FactVerificationStatus = (typeof FACT_VERIFICATION_STATUSES)[number];
export const factVerificationStatusSchema = z.enum(FACT_VERIFICATION_STATUSES);

/** Origine d'un fait. `ai_proposal` n'est **jamais** une source suffisante. */
export const FACT_SOURCES = [
  'user_input',
  'user_edit',
  'user_import',
  'conversation',
  'ai_proposal',
] as const;
export type FactSource = (typeof FACT_SOURCES)[number];
export const factSourceSchema = z.enum(FACT_SOURCES);

/** Statuts qui autorisent l'injection d'un fait dans un prompt (docs/03 §6.1). */
export const TRUSTED_FACT_STATUSES = [
  'verified',
] as const satisfies readonly FactVerificationStatus[];

/** Statuts d'un fait encore « vivant » : ni obsolète, ni remplacé. */
export const ACTIVE_FACT_STATUSES = [
  'proposed',
  'user_provided',
  'verified',
  'uncertain',
] as const satisfies readonly FactVerificationStatus[];

/**
 * Libellés affichés par l'interface. Ils vivent ici, à côté des valeurs, pour
 * qu'une valeur ajoutée sans libellé soit une **erreur de compilation** — et non
 * un écran vide découvert par l'utilisateur (`labels.test.ts`).
 */
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  discovery: 'Découverte',
  active: 'Actif',
  paused: 'En pause',
  archived: 'Archivé',
};

export const FACT_CATEGORY_LABELS: Record<FactCategory, string> = {
  // Biographie et vécu
  experience: 'Expérience vécue',
  chiffre: 'Chiffre',
  opinion: 'Opinion',
  projet: 'Projet réalisé',
  echec: 'Échec',
  ressource: 'Ressource',
  contrainte: 'Contrainte',
  // Connaissance du projet
  description: 'Description',
  motivation: 'Motivation',
  probleme: 'Problème traité',
  stack: 'Stack technique',
  technologie: 'Technologie',
  architecture: 'Architecture connue',
  fonctionnalite: 'Fonctionnalité',
  decision: 'Décision technique',
  difficulte: 'Difficulté',
  erreur: 'Erreur',
  solution: 'Solution',
  apprentissage: 'Apprentissage',
  etat_actuel: 'État actuel',
  prochaine_etape: 'Prochaine étape',
  url: 'URL',
  note: 'Note',
};

export const FACT_VERIFICATION_STATUS_LABELS: Record<FactVerificationStatus, string> = {
  proposed: 'Proposé (non validé)',
  user_provided: 'Fourni par vous',
  verified: 'Confirmé par vous',
  uncertain: 'Incertain',
  obsolete: 'Obsolète',
  superseded: 'Remplacé',
};

export const FACT_SOURCE_LABELS: Record<FactSource, string> = {
  user_input: 'Saisie par vous',
  user_edit: 'Corrigé par vous',
  user_import: 'Importé par vous',
  conversation: 'Extrait d’une conversation',
  ai_proposal: 'Proposé par l’IA',
};

export const CONVERSATION_KIND_LABELS: Record<ConversationKind, string> = {
  interview: 'Entretien de projet',
  news_discussion: 'Discussion d’actualité',
  feedback: 'Retour sur un contenu',
  freeform: 'Conversation libre',
};

/** Les libellés de phase disent **ce qu'on cherche**, pas un identifiant technique. */
export const CONVERSATION_STAGE_LABELS: Record<ConversationStage, string> = {
  intake: 'Qui vous êtes, ce que vous faites',
  positioning: 'Ce pour quoi vous voulez être reconnu',
  audience: 'À qui vous parlez',
  voice: 'Votre façon de parler',
  fact_extraction: 'Faits, chiffres et expériences',
  strategy: 'Rythme, plateformes et objectifs',
  brief_ready: 'Fiche maître à relire',
  closed: 'Entretien terminé',
};

export const MESSAGE_ROLE_LABELS: Record<MessageRole, string> = {
  user: 'Vous',
  assistant: 'Assistant',
  system: 'Système',
  tool: 'Mémoire consultée',
};

export const MESSAGE_TYPE_LABELS: Record<MessageType, string> = {
  text: 'Texte',
  question: 'Question',
  options: 'Options',
  proposal: 'Proposition',
  confirmation: 'Confirmation',
  error: 'Erreur',
};

export const MASTER_BRIEF_STATUS_LABELS: Record<MasterBriefStatus, string> = {
  draft: 'Brouillon',
  validated: 'Validée',
  superseded: 'Remplacée',
};

export const SKILL_LEVELS = ['debutant', 'intermediaire', 'avance', 'expert'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];
export const skillLevelSchema = z.enum(SKILL_LEVELS);

export const SKILL_LEARNED_HOW = [
  'autodidacte',
  'formation',
  'projet',
  'travail',
  'en_apprentissage',
] as const;
export type SkillLearnedHow = (typeof SKILL_LEARNED_HOW)[number];
export const skillLearnedHowSchema = z.enum(SKILL_LEARNED_HOW);

export const STYLE_SCOPES = ['project', 'platform'] as const;
export type StyleScope = (typeof STYLE_SCOPES)[number];
export const styleScopeSchema = z.enum(STYLE_SCOPES);

export const STYLE_TONES = [
  'pedagogue',
  'direct',
  'chaleureux',
  'technique',
  'provocateur',
] as const;
export type StyleTone = (typeof STYLE_TONES)[number];
export const styleToneSchema = z.enum(STYLE_TONES);

export const SENTENCE_LENGTHS = ['courte', 'moyenne', 'longue'] as const;
export type SentenceLength = (typeof SENTENCE_LENGTHS)[number];
export const sentenceLengthSchema = z.enum(SENTENCE_LENGTHS);

export const AUDIENCE_KNOWLEDGE_LEVELS = ['debutant', 'intermediaire', 'avance'] as const;
export type AudienceKnowledgeLevel = (typeof AUDIENCE_KNOWLEDGE_LEVELS)[number];
export const audienceKnowledgeLevelSchema = z.enum(AUDIENCE_KNOWLEDGE_LEVELS);

export const GOAL_METRICS = [
  'cadence',
  'abonnes',
  'vues',
  'engagement',
  'clics',
  'ventes',
] as const;
export type GoalMetric = (typeof GOAL_METRICS)[number];
export const goalMetricSchema = z.enum(GOAL_METRICS);

export const GOAL_STATUSES = ['active', 'reached', 'missed', 'abandoned'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export const goalStatusSchema = z.enum(GOAL_STATUSES);

// --- Conversation et fiche maître (docs/03 §7, §8.1) -----------------------

export const CONVERSATION_KINDS = ['interview', 'news_discussion', 'feedback', 'freeform'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const conversationKindSchema = z.enum(CONVERSATION_KINDS);

/**
 * Les huit phases d'un entretien (docs/05 §3.1). `stage` est un **état
 * explicite** : la transition est décidée par du code, sur la base de champs
 * obligatoires réellement présents en base — jamais par le jugement du modèle.
 */
export const CONVERSATION_STAGES = [
  'intake',
  'positioning',
  'audience',
  'voice',
  'fact_extraction',
  'strategy',
  'brief_ready',
  'closed',
] as const;
export type ConversationStage = (typeof CONVERSATION_STAGES)[number];
export const conversationStageSchema = z.enum(CONVERSATION_STAGES);

export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];
export const messageRoleSchema = z.enum(MESSAGE_ROLES);

export const MESSAGE_TYPES = [
  'text',
  'question',
  'options',
  'proposal',
  'confirmation',
  'error',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const messageTypeSchema = z.enum(MESSAGE_TYPES);

/** Mode d'entrée d'un message utilisateur. Le vocal arrive à l'étape média. */
export const MESSAGE_INPUT_MODES = ['text', 'voice', 'file'] as const;
export type MessageInputMode = (typeof MESSAGE_INPUT_MODES)[number];
export const messageInputModeSchema = z.enum(MESSAGE_INPUT_MODES);

export const CONVERSATION_SUMMARY_SCOPES = ['rolling', 'final'] as const;
export type ConversationSummaryScope = (typeof CONVERSATION_SUMMARY_SCOPES)[number];
export const conversationSummaryScopeSchema = z.enum(CONVERSATION_SUMMARY_SCOPES);

/** `superseded` : une nouvelle version a remplacé celle-ci (docs/03 §8.1). */
export const MASTER_BRIEF_STATUSES = ['draft', 'validated', 'superseded'] as const;
export type MasterBriefStatus = (typeof MASTER_BRIEF_STATUSES)[number];
export const masterBriefStatusSchema = z.enum(MASTER_BRIEF_STATUSES);

/**
 * Ce qui manque à la mémoire d'un projet : la liste qui pilote les questions de
 * l'entretien (docs/03 §7.1). L'ordre est celui des phases documentées, et la
 * première lacune **est** la phase courante. C'est la clé du produit : une
 * question dont la réponse est déjà en base ne doit jamais être posée.
 */
export const CONVERSATION_SLOTS = [
  'skills',
  'positioning',
  'audience',
  'voice',
  'facts',
  'strategy',
] as const;
export type ConversationSlot = (typeof CONVERSATION_SLOTS)[number];
export const conversationSlotSchema = z.enum(CONVERSATION_SLOTS);

// --- Éditorial : sujets, angles, contenus (docs/03 §8.2 à §9.4) ------------

/**
 * Un **sujet** est une unité de sens indépendante d'une plateforme
 * (docs/03 §8.2). Son cycle de vie est volontairement court : proposé, choisi,
 * en production, produit, archivé.
 */
export const SUBJECT_STATUSES = [
  'proposed',
  'selected',
  'in_production',
  'produced',
  'archived',
] as const;
export type SubjectStatus = (typeof SUBJECT_STATUSES)[number];
export const subjectStatusSchema = z.enum(SUBJECT_STATUSES);

export const SUBJECT_ORIGINS = [
  'conversation',
  'news',
  'manual',
  'recycling',
  'analytics',
] as const;
export type SubjectOrigin = (typeof SUBJECT_ORIGINS)[number];
export const subjectOriginSchema = z.enum(SUBJECT_ORIGINS);

/**
 * Ce que le sujet demande à l'utilisateur, comparé à `project_skill_facts`
 * (docs/03 §8.2). Calculée **localement** : c'est ce qui empêche le produit de
 * faire écrire un post d'expert sur une compétence que l'utilisateur découvre.
 */
export const SKILL_COVERAGES = ['couverte', 'partielle', 'non_couverte'] as const;
export type SkillCoverage = (typeof SKILL_COVERAGES)[number];
export const skillCoverageSchema = z.enum(SKILL_COVERAGES);

/** Types d'angle (docs/03 §8.3). Ce sont eux que l'utilisateur rejette, pas les sujets. */
export const ANGLE_TYPES = [
  'retour_experience',
  'tutoriel',
  'opinion',
  'comparaison',
  'erreur',
  'coulisses',
  'question',
  'etude_de_cas',
] as const;
export type AngleType = (typeof ANGLE_TYPES)[number];
export const angleTypeSchema = z.enum(ANGLE_TYPES);

export const ANGLE_LENGTHS = ['court', 'moyen', 'long'] as const;
export type AngleLength = (typeof ANGLE_LENGTHS)[number];
export const angleLengthSchema = z.enum(ANGLE_LENGTHS);

/** Ce que l'angle **exige** de l'utilisateur : affiché avant qu'il ne choisisse. */
export const ANGLE_DIFFICULTIES = ['faible', 'moyenne', 'elevee'] as const;
export type AngleDifficulty = (typeof ANGLE_DIFFICULTIES)[number];
export const angleDifficultySchema = z.enum(ANGLE_DIFFICULTIES);

/** Formats d'un contenu (docs/03 §9.1). `youtube` long et court partagent la plateforme. */
export const CONTENT_FORMATS = [
  'post_texte',
  'post_image',
  'video_courte',
  'video_longue',
  'thread',
  'article',
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number];
export const contentFormatSchema = z.enum(CONTENT_FORMATS);

/**
 * Cibles de génération de ce lot : un couple (plateforme, format), parce que
 * « YouTube Shorts » et « YouTube long » sont la **même plateforme** et deux
 * formats différents. La clé sert de clé de sortie au `platform_writer` et de
 * nom de prompt.
 */
export const CONTENT_TARGETS = [
  'linkedin_post',
  'reddit_post',
  'tiktok_short',
  'youtube_short',
  'youtube_long',
] as const;
export type ContentTarget = (typeof CONTENT_TARGETS)[number];
export const contentTargetSchema = z.enum(CONTENT_TARGETS);

/**
 * Machine à états d'un contenu (docs/03 §9.1). C'est l'invariant n° 1 du
 * produit : **aucune publication sans approbation explicite**. Les transitions
 * sont appliquées dans `packages/core`, jamais dans l'API ni dans le worker.
 */
export const CONTENT_STATES = [
  'draft',
  'generated',
  'in_review',
  'editing',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'publish_failed',
  'publish_ambiguous',
  'archived',
] as const;
export type ContentState = (typeof CONTENT_STATES)[number];
export const contentStateSchema = z.enum(CONTENT_STATES);

/** Origine d'une version : « initial » est la v1, les autres la remplacent (docs/03 §9.2). */
export const CONTENT_GENERATIONS = ['initial', 'regenerated', 'edited', 'reformatted'] as const;
export type ContentGeneration = (typeof CONTENT_GENERATIONS)[number];
export const contentGenerationSchema = z.enum(CONTENT_GENERATIONS);

// --- Configuration ---------------------------------------------------------

export const SETTING_VALUE_TYPES = ['string', 'number', 'boolean', 'json'] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];
export const settingValueTypeSchema = z.enum(SETTING_VALUE_TYPES);

export const LLM_PROVIDER_IDS = [
  'deepseek',
  'openrouter',
  'openai',
  'anthropic',
  'gemini',
  'ollama',
] as const;
export type LlmProviderId = (typeof LLM_PROVIDER_IDS)[number];
export const llmProviderIdSchema = z.enum(LLM_PROVIDER_IDS);

export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];
export const storageDriverSchema = z.enum(STORAGE_DRIVERS);

export const ASR_ENGINES = ['whisper_cpp', 'faster_whisper', 'cloud'] as const;
export type AsrEngine = (typeof ASR_ENGINES)[number];
export const asrEngineSchema = z.enum(ASR_ENGINES);

// --- Plateformes (câblées aux étapes 5 à 9) --------------------------------

export const PLATFORM_IDS = [
  'linkedin',
  'reddit',
  'x',
  'youtube',
  'tiktok',
  'instagram',
  'blog',
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];
export const platformIdSchema = z.enum(PLATFORM_IDS);

// --- Objectifs et périodes ------------------------------------------------

export const GOAL_PERIODS = ['week', 'month', 'quarter', 'year'] as const;
export type GoalPeriod = (typeof GOAL_PERIODS)[number];
export const goalPeriodSchema = z.enum(GOAL_PERIODS);

export const BUDGET_PERIODS = ['day', 'week', 'month'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];
export const budgetPeriodSchema = z.enum(BUDGET_PERIODS);

/**
 * Registre utilisé par `enums.test.ts` pour vérifier la cohérence
 * tableau ↔ type ↔ schéma Zod sur l'ensemble des énumérations.
 */
export const ENUM_REGISTRY = {
  APP_ENVS: { values: APP_ENVS, schema: appEnvSchema },
  LOG_LEVELS: { values: LOG_LEVELS, schema: logLevelSchema },
  JOB_STATUSES: { values: JOB_STATUSES, schema: jobStatusSchema },
  ERROR_CATEGORIES: { values: ERROR_CATEGORIES, schema: errorCategorySchema },
  PROJECT_STATUSES: { values: PROJECT_STATUSES, schema: projectStatusSchema },
  FACT_CATEGORIES: { values: FACT_CATEGORIES, schema: factCategorySchema },
  FACT_VERIFICATION_STATUSES: {
    values: FACT_VERIFICATION_STATUSES,
    schema: factVerificationStatusSchema,
  },
  FACT_SOURCES: { values: FACT_SOURCES, schema: factSourceSchema },
  SKILL_LEVELS: { values: SKILL_LEVELS, schema: skillLevelSchema },
  SKILL_LEARNED_HOW: { values: SKILL_LEARNED_HOW, schema: skillLearnedHowSchema },
  STYLE_SCOPES: { values: STYLE_SCOPES, schema: styleScopeSchema },
  STYLE_TONES: { values: STYLE_TONES, schema: styleToneSchema },
  SENTENCE_LENGTHS: { values: SENTENCE_LENGTHS, schema: sentenceLengthSchema },
  AUDIENCE_KNOWLEDGE_LEVELS: {
    values: AUDIENCE_KNOWLEDGE_LEVELS,
    schema: audienceKnowledgeLevelSchema,
  },
  GOAL_METRICS: { values: GOAL_METRICS, schema: goalMetricSchema },
  GOAL_STATUSES: { values: GOAL_STATUSES, schema: goalStatusSchema },
  GOAL_PERIODS: { values: GOAL_PERIODS, schema: goalPeriodSchema },
  SETTING_VALUE_TYPES: { values: SETTING_VALUE_TYPES, schema: settingValueTypeSchema },
  LLM_PROVIDER_IDS: { values: LLM_PROVIDER_IDS, schema: llmProviderIdSchema },
  STORAGE_DRIVERS: { values: STORAGE_DRIVERS, schema: storageDriverSchema },
  ASR_ENGINES: { values: ASR_ENGINES, schema: asrEngineSchema },
  PLATFORM_IDS: { values: PLATFORM_IDS, schema: platformIdSchema },
  BUDGET_PERIODS: { values: BUDGET_PERIODS, schema: budgetPeriodSchema },
  CONVERSATION_KINDS: { values: CONVERSATION_KINDS, schema: conversationKindSchema },
  CONVERSATION_STAGES: { values: CONVERSATION_STAGES, schema: conversationStageSchema },
  MESSAGE_ROLES: { values: MESSAGE_ROLES, schema: messageRoleSchema },
  MESSAGE_TYPES: { values: MESSAGE_TYPES, schema: messageTypeSchema },
  MESSAGE_INPUT_MODES: { values: MESSAGE_INPUT_MODES, schema: messageInputModeSchema },
  CONVERSATION_SUMMARY_SCOPES: {
    values: CONVERSATION_SUMMARY_SCOPES,
    schema: conversationSummaryScopeSchema,
  },
  MASTER_BRIEF_STATUSES: { values: MASTER_BRIEF_STATUSES, schema: masterBriefStatusSchema },
  CONVERSATION_SLOTS: { values: CONVERSATION_SLOTS, schema: conversationSlotSchema },
  SUBJECT_STATUSES: { values: SUBJECT_STATUSES, schema: subjectStatusSchema },
  SUBJECT_ORIGINS: { values: SUBJECT_ORIGINS, schema: subjectOriginSchema },
  SKILL_COVERAGES: { values: SKILL_COVERAGES, schema: skillCoverageSchema },
  ANGLE_TYPES: { values: ANGLE_TYPES, schema: angleTypeSchema },
  ANGLE_LENGTHS: { values: ANGLE_LENGTHS, schema: angleLengthSchema },
  ANGLE_DIFFICULTIES: { values: ANGLE_DIFFICULTIES, schema: angleDifficultySchema },
  CONTENT_FORMATS: { values: CONTENT_FORMATS, schema: contentFormatSchema },
  CONTENT_TARGETS: { values: CONTENT_TARGETS, schema: contentTargetSchema },
  CONTENT_STATES: { values: CONTENT_STATES, schema: contentStateSchema },
  CONTENT_GENERATIONS: { values: CONTENT_GENERATIONS, schema: contentGenerationSchema },
} as const;
