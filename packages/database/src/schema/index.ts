/**
 * Schéma complet de la base : les **13 tables** de l'étape 1 (docs/10 §4.1), les
 * **4 tables** de l'étape 3 (conversation et fiche maître, docs/03 §7 et §8.1)
 * et les **8 tables** de l'étape 4 (contenus, versions, affirmations, remarques,
 * rendus, erreurs, santé, notifications — docs/10 §4.4).
 *
 * Règle « la table d'abord, le pipeline ensuite » (docs/10 §1.3) : une table est
 * créée quand son domaine est modélisé, même si le pipeline qui la remplit
 * arrive plus tard. Les 16 autres tables arrivent à leurs étapes respectives.
 */

import { getTableName } from 'drizzle-orm';

export * from './analytics';
export * from './conversation';
export * from './editorial';
export * from './media';
export * from './news';
export * from './projects';
export * from './publishing';
export * from './scheduling';
export * from './system';
export * from './users';

import { appSettings, llmProvidersConfig, users } from './users';
import { budgetLimits, learnings, metricSnapshots, performancePatterns } from './analytics';
import {
  audienceProfiles,
  projectFacts,
  projectGoals,
  projectSkillFacts,
  projects,
  styleProfiles,
} from './projects';
import { conversationSummaries, conversations, masterBriefs, messages } from './conversation';
import {
  errors,
  jobEvents,
  jobs,
  llmCalls,
  notifications,
  promptVersions,
  systemHealth,
} from './system';
import {
  contentClaims,
  contentItems,
  contentReviewNotes,
  contentSubjects,
  contentVersions,
  subjectAngles,
  videoRenders,
} from './editorial';
import {
  manualPackages,
  platformAccounts,
  projectPlatforms,
  publicationAttempts,
  publications,
} from './publishing';
import { mediaAssets, messageAttachments, transcripts } from './media';
import { newsItems, newsSources } from './news';
import { calendarChangeProposals, calendarSlots } from './scheduling';

/** Liste de référence : sert aux tests de migration et au diagnostic. */
export const STEP_ONE_TABLES = [
  users,
  appSettings,
  llmProvidersConfig,
  projects,
  projectGoals,
  projectFacts,
  projectSkillFacts,
  styleProfiles,
  audienceProfiles,
  jobs,
  jobEvents,
  llmCalls,
  promptVersions,
] as const;

/** Noms SQL attendus après la migration initiale. */
export const STEP_ONE_TABLE_NAMES: readonly string[] = STEP_ONE_TABLES.map((table) =>
  getTableName(table),
);

/**
 * Les quatre tables de l'étape 3 (conversation et fiche maître, docs/03 §7 et
 * §8.1). Le diagnostic et les tests de migration vérifient leur présence
 * séparément de la liste initiale : une base de l'étape 1 reste détectable.
 */
export const STEP_THREE_TABLES = [
  conversations,
  messages,
  conversationSummaries,
  masterBriefs,
] as const;

export const STEP_THREE_TABLE_NAMES: readonly string[] = STEP_THREE_TABLES.map((table) =>
  getTableName(table),
);

/**
 * Les **huit tables de l'étape 4** : les cinq du contenu (docs/03 §9.1 à §9.4,
 * §10.3) et les trois de l'observabilité (docs/03 §14.5 à §14.7).
 *
 * Elles sont listées par **nom SQL** et non par objet Drizzle : la liste sert au
 * diagnostic et aux tests de migration, et `video_renders` n'a encore aucun
 * pipeline — ce qui compte, c'est que la base les porte.
 */
export const STEP_FOUR_TABLE_NAMES: readonly string[] = [
  'content_items',
  'content_versions',
  'content_claims',
  'content_review_notes',
  'video_renders',
  'errors',
  'system_health',
  'notifications',
];

/** Les tables de l'étape 4, en objets Drizzle (pour le diagnostic qui les interroge). */
export const STEP_FOUR_TABLES = [
  contentItems,
  contentVersions,
  contentClaims,
  contentReviewNotes,
  videoRenders,
  errors,
  systemHealth,
  notifications,
] as const;

export const STEP_FIVE_TABLE_NAMES: readonly string[] = [
  'project_platforms',
  'platform_accounts',
  'publications',
  'publication_attempts',
  'manual_packages',
];

export const STEP_FIVE_TABLES = [
  projectPlatforms,
  platformAccounts,
  publications,
  publicationAttempts,
  manualPackages,
] as const;

export const STEP_SIX_TABLE_NAMES: readonly string[] = [
  'media_assets',
  'transcripts',
  'message_attachments',
];

export const STEP_SIX_TABLES = [mediaAssets, transcripts, messageAttachments] as const;

/**
 * Les **deux tables de l'étape 7** : la veille (docs/03 §13). Le **schéma**
 * seulement — la collecte, le scoring et le LLM de veille arrivent à l'étape 10
 * (docs/10 §4.7, §4.10). Les créer ici évite une seconde migration qui toucherait
 * le même code d'ingestion externe.
 */
export const STEP_SEVEN_TABLE_NAMES: readonly string[] = ['news_sources', 'news_items'];

export const STEP_SEVEN_TABLES = [newsSources, newsItems] as const;

/**
 * Les **quatre tables de l'étape 8** (docs/10 §4.8) : les plafonds de dépense et
 * les trois réceptacles des mesures futures (docs/03 §4.4, §6.5, §12.1, §12.2).
 *
 * Elles sont listées par **nom SQL**, comme celles de l'étape 4 : trois d'entre
 * elles n'ont **aucun pipeline** à ce stade — c'est le choix explicite de
 * docs/10 §1.3 (« une table vide n'est jamais remplie par du code provisoire »),
 * et c'est précisément quand une table n'a pas encore de code qui la lit qu'elle
 * peut disparaître d'une migration sans que personne ne le voie.
 */
export const STEP_EIGHT_TABLE_NAMES: readonly string[] = [
  'budget_limits',
  'learnings',
  'metric_snapshots',
  'performance_patterns',
];

export const STEP_EIGHT_TABLES = [
  budgetLimits,
  learnings,
  metricSnapshots,
  performancePatterns,
] as const;

/** L'intention calendrier et ses propositions humaines (étape 9). */
export const STEP_NINE_TABLE_NAMES: readonly string[] = [
  'calendar_slots',
  'calendar_change_proposals',
];

export const STEP_NINE_TABLES = [calendarSlots, calendarChangeProposals] as const;

/** Les deux tables éditoriales de l'étape 3, avec les autres : elles vivent dans `./editorial`. */
export const STEP_THREE_EDITORIAL_TABLES = [contentSubjects, subjectAngles] as const;

/**
 * **Toutes** les tables attendues par l'application à son état actuel. C'est
 * cette liste — et jamais un nombre écrit en dur — que vérifient l'amorçage de
 * l'API, celui du worker et le diagnostic : une base à laquelle il manque une
 * table de contenu doit être refusée **au démarrage**, avec le nom de la table
 * manquante, pas par une erreur SQL à la première requête.
 *
 * Elle grandit à chaque étape : ajouter les tables d'une nouvelle étape ici est
 * la dernière ligne à écrire avant de livrer.
 */
export const REQUIRED_TABLE_NAMES: readonly string[] = [
  ...STEP_ONE_TABLE_NAMES,
  ...STEP_THREE_TABLE_NAMES,
  ...STEP_THREE_EDITORIAL_TABLES.map((table) => getTableName(table)),
  ...STEP_FOUR_TABLE_NAMES,
  ...STEP_FIVE_TABLE_NAMES,
  ...STEP_SIX_TABLE_NAMES,
  ...STEP_SEVEN_TABLE_NAMES,
  ...STEP_EIGHT_TABLE_NAMES,
  ...STEP_NINE_TABLE_NAMES,
];
