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

export * from './conversation';
export * from './editorial';
export * from './projects';
export * from './system';
export * from './users';

import { appSettings, llmProvidersConfig, users } from './users';
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
];
