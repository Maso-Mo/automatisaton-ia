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

export const FACT_CATEGORIES = [
  'experience',
  'chiffre',
  'opinion',
  'projet',
  'echec',
  'ressource',
  'contrainte',
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];
export const factCategorySchema = z.enum(FACT_CATEGORIES);

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
} as const;
