import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { projects } from './projects';
import { publications } from './publishing';
import { contentVersions } from './editorial';

/**
 * Analytics et plafonds — les **quatre tables de l'étape 8** (docs/10 §4.8) :
 * `budget_limits` (docs/03 §4.4), `learnings` (§6.5), `metric_snapshots` (§12.1)
 * et `performance_patterns` (§12.2).
 *
 * **Pourquoi elles arrivent ici et pas à l'étape 11** : à partir de l'étape 8, le
 * système agit **seul vers l'extérieur**. C'est le moment où l'on pose les
 * garde-fous (les plafonds) et les réceptacles des mesures futures. La collecte
 * et l'**analyse** appartiennent à l'étape 11 : un système qui collecte avant
 * d'analyser ne perd rien, l'inverse est impossible (docs/10 §4.8).
 *
 * Règle de docs/10 §1.3 : « une table vide n'est **jamais** remplie par du code
 * provisoire ». Les trois tables de mesure sont donc créées **sans pipeline** —
 * ni job, ni route — et c'est écrit explicitement (docs/18 §12).
 */

/**
 * Les plafonds de dépense, par portée et par période (docs/03 §4.4, docs/08 §8.1).
 *
 * Différence avec `app_settings.daily_budget_usd` : `app_settings` porte le
 * réglage simple affiché à l'utilisateur ; cette table permet « la veille n'a
 * droit qu'à 0,50 $/jour quel que soit le budget global » — le filet qui évite
 * qu'une tâche automatique absorbe tout.
 *
 * **`scope_ref` n'est jamais `NULL`, contrairement à la fiche docs/03 §4.4.**
 * C'est une correction assumée : SQLite autorise plusieurs `NULL` dans un index
 * unique, donc `UNIQUE (scope, scope_ref, period)` avec un `scope_ref` nullable
 * **n'aurait rien empêché** — on aurait pu écrire dix plafonds globaux
 * journaliers sans qu'aucune contrainte ne s'y oppose. `''` désigne donc global,
 * et un `CHECK` interdit tout autre vide.
 */
export const budgetLimits = sqliteTable(
  'budget_limits',
  {
    id: text().primaryKey(),
    /** 'global' | 'project' | 'task' */
    scope: text().notNull(),
    /** `projectId`, nom de tâche (`publication`, `veille`…), ou `''` si `scope = 'global'`. */
    scope_ref: text().notNull().default(''),
    /** 'day' | 'week' | 'month' */
    period: text().notNull(),
    limit_micro_usd: integer().notNull(),
    /** `true` = refus en dur ; `false` = avertissement seulement (docs/08 §8.2). */
    hard_stop: integer({ mode: 'boolean' }).notNull().default(true),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_budget_limit_scope').on(table.scope, table.scope_ref, table.period),
    index('idx_budget_limits_scope').on(table.scope, table.scope_ref),
    check('chk_budget_scope', sql`${table.scope} in ('global','project','task')`),
    check('chk_budget_period', sql`${table.period} in ('day','week','month')`),
    check('chk_budget_amount', sql`${table.limit_micro_usd} >= 0`),
    check(
      'chk_budget_scope_ref',
      sql`(${table.scope} = 'global' and ${table.scope_ref} = '') or (${table.scope} <> 'global' and ${table.scope_ref} <> '')`,
    ),
  ],
);

/**
 * Ce que le produit a **appris des résultats réels** (docs/03 §6.5).
 *
 * Les règles anti-superstition de docs/03 §6.5 sont portées par le schéma là où
 * elles sont vérifiables : `sample_size >= 5` (sous ce seuil, c'est du bruit),
 * confiance `faible` par défaut, et `active` pour qu'une croyance jamais
 * reconfirmée puisse être éteinte **sans être supprimée** — l'historique de ce
 * qu'on a cru reste lisible.
 */
export const learnings = sqliteTable(
  'learnings',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    /** 'platform'|'topic'|'format'|'hook'|'timing'|'length' */
    scope: text().notNull(),
    platform: text(),
    /** « Les posts LinkedIn en liste de 5 points performent mieux » — une phrase lisible. */
    statement: text().notNull(),
    /** `{ publicationIds: [...], metric: 'engagement_rate', ... }` : la preuve, pas l'intuition. */
    evidence_json: text(),
    /** Nombre de publications analysées. Jamais moins de 5 (docs/03 §6.5, règle 1). */
    sample_size: integer().notNull(),
    /** 'faible'|'moyenne'|'forte' — `faible` par défaut (règle 2). */
    confidence: text().notNull().default('faible'),
    confidence_x100: integer().notNull().default(0),
    niche: text(),
    content_type: text(),
    /** Un apprentissage n'entre dans un prompt que si revu ou de confiance forte (règle 4). */
    human_reviewed: integer({ mode: 'boolean' }).notNull().default(false),
    active: integer({ mode: 'boolean' }).notNull().default(true),
    created_at: integer().notNull(),
    last_confirmed_at: integer(),
  },
  (table) => [
    index('idx_learnings_project').on(table.project_id, table.active, table.confidence),
    check(
      'chk_learnings_scope',
      sql`${table.scope} in ('platform','topic','format','hook','timing','length')`,
    ),
    check('chk_learnings_confidence', sql`${table.confidence} in ('faible','moyenne','forte')`),
    check('chk_learnings_sample_size', sql`${table.sample_size} >= 5`),
  ],
);

/**
 * Une ligne par **publication et par jour** (docs/03 §12.1). Jamais d'écrasement
 * destructeur : les mesures s'ajoutent, ce qui permet de tracer une courbe.
 *
 * `uq_metric_snapshot` rend une collecte rejouée au même instant idempotente,
 * sans écraser T+1 h par T+6 h le même jour : la vitesse reste mesurable.
 *
 * `engagement_rate_x100` est **stocké**, pas calculé à la volée : la formule
 * dépend de la plateforme (impressions, reach ou vues au dénominateur). Le
 * stocker garantit des comparaisons historiques cohérentes même si la formule
 * change (docs/03 §12.1).
 *
 * `source = 'manual'` est **indispensable** : plusieurs plateformes n'exposent
 * pas d'analytics utilisables et l'utilisateur doit pouvoir saisir ses chiffres à
 * la main, avec la **même** valeur que les données d'API (docs/03 §12.1).
 */
export const metricSnapshots = sqliteTable(
  'metric_snapshots',
  {
    id: text().primaryKey(),
    publication_id: text()
      .notNull()
      .references(() => publications.id),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    platform: text().notNull(),
    /** Moment de la mesure (ms epoch). */
    captured_at: integer().notNull(),
    /** 'YYYY-MM-DD' dans le fuseau de l'utilisateur — c'est lui qui fait l'unicité du jour. */
    captured_date: text().notNull(),
    /** 'api'|'manual'|'estimated'. `estimated` n'est jamais présenté comme mesuré. */
    source: text().notNull(),
    impressions: integer(),
    reach: integer(),
    views: integer(),
    likes: integer(),
    comments: integer(),
    shares: integer(),
    saves: integer(),
    clicks: integer(),
    follows_gained: integer(),
    watch_time_sec: integer(),
    avg_view_duration_sec: integer(),
    /** ×100 : un entier, jamais un flottant (docs/03 §2.4). */
    completion_rate_x100: integer(),
    /** ×100 ; calculé par le collecteur puis stocké pour la stabilité historique. */
    engagement_rate_x100: integer(),
    profile_visits: integer(),
    /** Taille du compte au moment de la publication ; `NULL` reste inconnu. */
    followers_at_publish: integer(),
    /** Métriques propres à la plateforme, conservées sans les aplatir ni les inventer. */
    platform_metrics_json: text(),
    collection_method: text().notNull().default('manual_entry'),
    provenance: text().notNull().default('user'),
    engagement_rate_x10000: integer(),
    share_rate_x10000: integer(),
    save_rate_x10000: integer(),
    comment_rate_x10000: integer(),
    ctr_x10000: integer(),
    view_velocity_x100: integer(),
    relative_performance_x100: integer(),
    percentile_x100: integer(),
    /** Réponse brute de l'API, pour audit — sans jeton (docs/07 §9.1). */
    raw_json: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_metric_snapshot').on(table.publication_id, table.captured_at, table.source),
    index('idx_metrics_project_date').on(table.project_id, table.captured_date),
    index('idx_metrics_platform').on(table.platform, table.captured_date),
    check('chk_metrics_source', sql`${table.source} in ('api','manual','estimated')`),
    check(
      'chk_metrics_captured_date',
      sql`length(${table.captured_date}) = 10 and ${table.captured_date} like '____-__-__'`,
    ),
    check(
      'chk_metrics_non_negative',
      sql`(${table.impressions} is null or ${table.impressions} >= 0)
        and (${table.reach} is null or ${table.reach} >= 0)
        and (${table.views} is null or ${table.views} >= 0)
        and (${table.likes} is null or ${table.likes} >= 0)
        and (${table.comments} is null or ${table.comments} >= 0)
        and (${table.shares} is null or ${table.shares} >= 0)
        and (${table.saves} is null or ${table.saves} >= 0)`,
    ),
    check(
      'chk_metrics_followers',
      sql`${table.followers_at_publish} is null or ${table.followers_at_publish} >= 0`,
    ),
  ],
);

/**
 * Les corrélations **calculées localement** entre les caractéristiques d'un
 * contenu et son résultat (docs/03 §12.2) : le socle factuel, avant toute
 * interprétation par un LLM.
 *
 * `sample_size` et `baseline_x100` sont dans la table parce que « les hooks sous
 * forme de question ont un engagement 40 % supérieur, sur 9 publications » est
 * vérifiable, alors que « les questions marchent mieux » ne l'est pas. Un agent
 * LLM ne découvre jamais un pattern : il en **rédige** une recommandation à
 * partir de patterns déjà calculés (docs/03 §12.2).
 */
export const performancePatterns = sqliteTable(
  'performance_patterns',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    platform: text().notNull(),
    /** Dimension abstraite mesurée (hook, structure, longueur, CTA, vidéo ou publication). */
    dimension: text().notNull(),
    /** « hook sous forme de question » — la valeur observée, pas son interprétation. */
    value: text().notNull(),
    /** 'engagement_rate'|'reach'|'saves' */
    metric: text().notNull(),
    sample_size: integer().notNull(),
    avg_value_x100: integer().notNull(),
    median_value_x100: integer(),
    /** Moyenne générale de la plateforme : sans elle, un écart n'est pas mesurable. */
    baseline_x100: integer(),
    /** `(avg − baseline) / baseline × 100`. */
    delta_percent: integer(),
    niche: text(),
    content_type: text(),
    observed_effect: text(),
    positive_sample_size: integer().notNull().default(0),
    baseline_sample_size: integer().notNull().default(0),
    confidence_x100: integer().notNull().default(0),
    evidence_json: text(),
    status: text().notNull().default('EXPERIMENTAL'),
    first_observed_at: integer(),
    last_observed_at: integer(),
    computed_at: integer().notNull(),
    period_start: integer().notNull(),
    period_end: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_pattern').on(
      table.project_id,
      table.platform,
      table.dimension,
      table.value,
      table.metric,
      table.period_end,
    ),
    index('idx_patterns_lookup').on(
      table.project_id,
      table.platform,
      table.dimension,
      table.sample_size,
    ),
    check(
      'chk_patterns_dimension',
      sql`${table.dimension} in ('hook_type','length','posting_hour','posting_weekday','topic','format','hashtag_count','has_media','has_video','has_subtitles','structure','cta_type','technical_level','duration','visual_pace')`,
    ),
    check('chk_patterns_metric', sql`${table.metric} in ('engagement_rate','reach','saves')`),
    check('chk_patterns_sample_size', sql`${table.sample_size} > 0`),
    check(
      'chk_patterns_status',
      sql`${table.status} in ('EXPERIMENTAL','LIKELY','SUPPORTED','REJECTED')`,
    ),
    check('chk_patterns_confidence', sql`${table.confidence_x100} between 0 and 100`),
  ],
);

/** Exemple public fourni ou importé par l'utilisateur, sans copie du contenu tiers. */
export const externalContentExamples = sqliteTable(
  'external_content_examples',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    platform: text().notNull(),
    url: text().notNull(),
    creator_name: text(),
    published_at: integer(),
    collected_at: integer().notNull(),
    views: integer(),
    likes: integer(),
    comments: integer(),
    shares: integer(),
    followers: integer(),
    duration_ms: integer(),
    title: text().notNull(),
    topic: text(),
    extracted_features_json: text(),
    provenance: text().notNull(),
    confidence_x100: integer().notNull().default(50),
    included: integer({ mode: 'boolean' }).notNull().default(true),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_external_example_url').on(table.project_id, table.url),
    index('idx_external_example_project').on(table.project_id, table.platform, table.included),
    check('chk_external_confidence', sql`${table.confidence_x100} between 0 and 100`),
  ],
);

/** Caractéristiques abstraites d'un contenu interne ou externe, jamais son script tiers. */
export const contentFeatureSets = sqliteTable(
  'content_feature_sets',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    publication_id: text().references(() => publications.id),
    content_version_id: text().references(() => contentVersions.id),
    external_example_id: text().references(() => externalContentExamples.id),
    platform: text().notNull(),
    niche: text(),
    content_type: text().notNull(),
    features_json: text().notNull(),
    provenance: text().notNull(),
    confidence_x100: integer().notNull().default(100),
    experiment_key: text(),
    experiment_variant: text(),
    extraction_ms: integer().notNull().default(0),
    included: integer({ mode: 'boolean' }).notNull().default(true),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_features_publication').on(table.publication_id),
    uniqueIndex('uq_features_external').on(table.external_example_id),
    index('idx_features_learning').on(table.project_id, table.platform, table.included),
    check(
      'chk_features_origin',
      sql`(${table.publication_id} is not null and ${table.external_example_id} is null)
        or (${table.publication_id} is null and ${table.external_example_id} is not null)`,
    ),
    check('chk_features_confidence', sql`${table.confidence_x100} between 0 and 100`),
  ],
);
