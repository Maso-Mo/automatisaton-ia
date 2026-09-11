/**
 * Schéma complet de l'étape 1 : les **13 tables** listées dans docs/10 §4.1.
 *
 * Règle « la table d'abord, le pipeline ensuite » (docs/10 §1.3) : une table est
 * créée quand son domaine est modélisé, même si le pipeline qui la remplit
 * arrive plus tard. Les 28 autres tables arrivent à leurs étapes respectives.
 */

import { getTableName } from 'drizzle-orm';

export * from './conversation';
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
import { jobEvents, jobs, llmCalls, promptVersions } from './system';

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
