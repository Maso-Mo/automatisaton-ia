import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { conversations, masterBriefs } from './conversation';
import { audienceProfiles, projects } from './projects';
import { llmCalls } from './system';
import { users } from './users';

/**
 * Éditorial : sujets, angles, contenus et versions (docs/03 §8.2 à §9.4).
 *
 * La règle « la table d'abord, le pipeline ensuite » (docs/10 §1.3) a déjà créé
 * `content_subjects` et `subject_angles` (étape 3, domaine modélisé). L'étape 4
 * ajoute les cinq tables du contenu — `content_items`, `content_versions`,
 * `content_claims`, `content_review_notes`, `video_renders` — et les deux
 * déclencheurs qui portent les invariants les plus coûteux à casser :
 *
 * 1. **une version ne se modifie pas** : toute modification crée une nouvelle
 *    ligne (§9.2) ;
 * 2. **une affirmation n'est « étayée » qu'avec une preuve** : le garde-fou
 *    anti-hallucination ne peut pas vivre seulement dans un prompt (§9.3).
 */

export const contentSubjects = sqliteTable(
  'content_subjects',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    master_brief_id: text().references(() => masterBriefs.id),
    /** `news_items` arrive à l'étape 6 : colonne prête, contrainte ajoutée avec la table cible. */
    news_item_id: text(),
    conversation_id: text().references(() => conversations.id),
    title: text().notNull(),
    /** L'idée défendue en une phrase : c'est elle qui distingue un sujet d'un titre. */
    thesis: text().notNull(),
    pillar: text(),
    audience_id: text().references(() => audienceProfiles.id),
    origin: text().notNull().default('conversation'),
    status: text().notNull().default('proposed'),
    /** 'couverte'|'partielle'|'non_couverte' — comparée à `project_skill_facts`, calculée localement. */
    skill_coverage: text(),
    evidence_json: text(),
    priority_score: integer(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    archived_at: integer(),
  },
  (table) => [
    index('idx_subjects_project').on(table.project_id, table.status, table.priority_score),
    index('idx_subjects_origin').on(table.project_id, table.origin),
    check(
      'chk_subjects_skill_coverage',
      sql`${table.skill_coverage} is null or ${table.skill_coverage} in ('couverte','partielle','non_couverte')`,
    ),
    check(
      'chk_subjects_origin',
      sql`${table.origin} in ('conversation','news','manual','recycling','analytics')`,
    ),
  ],
);

export const subjectAngles = sqliteTable(
  'subject_angles',
  {
    id: text().primaryKey(),
    subject_id: text()
      .notNull()
      .references(() => contentSubjects.id),
    /** `all` : l'angle vaut pour toutes les plateformes du projet (docs/03 §8.3). */
    platform: text().notNull().default('all'),
    hook: text().notNull(),
    angle_type: text().notNull(),
    structure_json: text(),
    audience_id: text().references(() => audienceProfiles.id),
    estimated_length: text(),
    difficulty: text(),
    /**
     * **Ajouts de l'étape 4** (docs/10 §4.4). docs/04 §4.2 exige que *chaque*
     * angle cite un fait du projet : sans colonne, cet ancrage serait perdu
     * entre la génération et l'écran de choix — or c'est l'argument de
     * confiance de l'utilisateur (« d'où sort cet angle ? »).
     */
    evidence_json: text(),
    rationale: text(),
    score: integer(),
    selected: integer({ mode: 'boolean' }).notNull().default(false),
    rejection_reason: text(),
    created_at: integer().notNull(),
  },
  (table) => [
    index('idx_angles_subject').on(table.subject_id, table.score),
    check(
      'chk_angles_angle_type',
      sql`${table.angle_type} in ('retour_experience','tutoriel','opinion','comparaison','erreur','coulisses','question','etude_de_cas')`,
    ),
    check(
      'chk_angles_estimated_length',
      sql`${table.estimated_length} is null or ${table.estimated_length} in ('court','moyen','long')`,
    ),
    check(
      'chk_angles_difficulty',
      sql`${table.difficulty} is null or ${table.difficulty} in ('faible','moyenne','elevee')`,
    ),
  ],
);

export const contentItems = sqliteTable(
  'content_items',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    subject_id: text().references(() => contentSubjects.id),
    angle_id: text().references(() => subjectAngles.id),
    platform: text().notNull(),
    /** `platform_accounts` arrive à l'étape 5 : colonne prête, contrainte ajoutée avec la table. */
    platform_account_id: text(),
    format: text().notNull(),
    title: text(),
    state: text().notNull().default('draft'),
    /** Dénormalisé depuis `content_versions` : c'est la version que l'API sert en lecture. */
    current_version_id: text(),
    approved_version_id: text(),
    /** Hash de l'angle + du brief + du style : deux contenus identiques se voient ici. */
    content_hash: text(),
    /**
     * **Marquage IA** (docs/07 §11.2, docs/09 §12) : tout contenu produit avec
     * l'assistance d'un modèle est marqué en base, sans exception. C'est le
     * « ou équivalent » du `content_versions.ai_assisted` de docs/07 §11.2 :
     * le marquage est porté par le contenu, pas par une version, parce qu'il
     * reste vrai après édition humaine.
     */
    ai_generated: integer({ mode: 'boolean' }).notNull().default(true),
    human_edited: integer({ mode: 'boolean' }).notNull().default(false),
    /** % du texte modifié par l'humain : proxy d'utilité réelle du produit (docs/03 §9.1). */
    edit_ratio: integer(),
    regenerated_count: integer().notNull().default(0),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
    approved_at: integer(),
    scheduled_for: integer(),
    published_at: integer(),
    archived_at: integer(),
  },
  (table) => [
    index('idx_items_project').on(table.project_id, table.state),
    index('idx_items_platform').on(table.platform, table.state),
    index('idx_items_scheduled').on(table.scheduled_for),
    index('idx_items_hash').on(table.content_hash),
    check(
      'chk_items_state',
      sql`${table.state} in ('draft','generated','in_review','editing','approved','scheduled','publishing','published','publish_failed','publish_ambiguous','archived')`,
    ),
    check(
      'chk_items_format',
      sql`${table.format} in ('post_texte','post_image','video_courte','video_longue','thread','article')`,
    ),
    check(
      'chk_items_edit_ratio',
      sql`${table.edit_ratio} is null or (${table.edit_ratio} >= 0 and ${table.edit_ratio} <= 100)`,
    ),
  ],
);

export const contentVersions = sqliteTable(
  'content_versions',
  {
    id: text().primaryKey(),
    content_item_id: text()
      .notNull()
      .references(() => contentItems.id),
    version_number: integer().notNull(),
    body: text().notNull(),
    title: text(),
    /** Première ligne : sur LinkedIn et YouTube, elle décide de tout (docs/03 §9.2). */
    hook: text(),
    hashtags_json: text(),
    mentions_json: text(),
    link_url: text(),
    media_asset_ids_json: text(),
    char_count: integer(),
    word_count: integer(),
    reading_time_sec: integer(),
    generation: text().notNull().default('initial'),
    /** Quel prompt **exact** a produit ce texte : la question « pourquoi ce post ? » y répond. */
    prompt_version_hash: text(),
    llm_call_id: text().references(() => llmCalls.id),
    model_used: text(),
    temperature_x100: integer(),
    critique_json: text(),
    quality_score: integer(),
    approved_at: integer(),
    approved_by: text().references(() => users.id),
    created_at: integer().notNull(),
  },
  (table) => [
    uniqueIndex('uq_content_version').on(table.content_item_id, table.version_number),
    index('idx_versions_item').on(table.content_item_id, table.version_number),
    check(
      'chk_versions_generation',
      sql`${table.generation} in ('initial','regenerated','edited','reformatted')`,
    ),
    check(
      'chk_versions_quality_score',
      sql`${table.quality_score} is null or (${table.quality_score} >= 0 and ${table.quality_score} <= 100)`,
    ),
  ],
);

/**
 * Les affirmations vérifiables d'un contenu (docs/03 §9.3).
 *
 * **Vides à l'étape 4** : le `fact_checker` qui les remplit arrive à l'étape 5
 * (docs/10 §4.4 : « aucune affirmation n'est vérifiée à ce stade »). La table
 * existe maintenant pour que la règle bloquante de §9.3 — un claim à risque
 * élevé non étayé interdit l'approbation — soit portée par le schéma dès que le
 * pipeline qui la remplit arrive.
 */
export const contentClaims = sqliteTable(
  'content_claims',
  {
    id: text().primaryKey(),
    content_version_id: text()
      .notNull()
      .references(() => contentVersions.id),
    claim: text().notNull(),
    claim_type: text().notNull(),
    verifiability: text().notNull(),
    /** Source : identifiant de `project_facts` (interne) ou URL (externe). */
    evidence: text(),
    evidence_source: text(),
    risk: text().notNull(),
    status: text().notNull(),
    user_confirmed_at: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    index('idx_claims_version').on(table.content_version_id, table.risk),
    index('idx_claims_status').on(table.content_version_id, table.status),
    check(
      'chk_claims_claim_type',
      sql`${table.claim_type} in ('chiffre','fait','experience','opinion','prediction','generalite')`,
    ),
    check(
      'chk_claims_verifiability',
      sql`${table.verifiability} in ('verifiable','non_verifiable','depend_du_contexte')`,
    ),
    check('chk_claims_risk', sql`${table.risk} in ('faible','moyen','eleve')`),
    check(
      'chk_claims_status',
      sql`${table.status} in ('supported','unsupported','needs_user_confirmation','rejected')`,
    ),
    check(
      'chk_claims_evidence_source',
      sql`${table.evidence_source} is null or ${table.evidence_source} in ('project_fact','news_item','user','web','none')`,
    ),
  ],
);

/**
 * Les remarques affichées **à côté** du texte, pas dans un journal (docs/03 §9.4).
 * Les agents y écrivent aussi : « le vérificateur signale un chiffre non sourcé
 * au paragraphe 3 » se lit sur le contenu, jamais dans un log technique.
 */
export const contentReviewNotes = sqliteTable(
  'content_review_notes',
  {
    id: text().primaryKey(),
    content_item_id: text()
      .notNull()
      .references(() => contentItems.id),
    content_version_id: text().references(() => contentVersions.id),
    /** 'user' ou nom d'agent : 'platform_writer', 'verifier', 'fact_checker', 'style_critic'. */
    author: text().notNull(),
    note_type: text().notNull(),
    severity: text().notNull(),
    message: text().notNull(),
    /** Extrait de texte visé : la remarque pointe une phrase, pas un document. */
    anchor_text: text(),
    resolved: integer({ mode: 'boolean' }).notNull().default(false),
    resolved_by: text(),
    resolved_at: integer(),
    created_at: integer().notNull(),
  },
  (table) => [
    index('idx_notes_item').on(table.content_item_id, table.resolved),
    check(
      'chk_notes_note_type',
      sql`${table.note_type} in ('critique','suggestion','erreur','warning','decision')`,
    ),
    check('chk_notes_severity', sql`${table.severity} in ('info','basse','moyenne','haute')`),
  ],
);

/**
 * Chaque opération de montage, avec le **plan exact** qui l'a produite
 * (docs/03 §10.3). Aucun montage à l'étape 4 : la table est créée avec son
 * domaine (docs/10 §1.3) et `media_assets` (étape 3) n'existe pas encore, donc
 * `output_asset_id` reste une colonne sans contrainte pour l'instant.
 */
export const videoRenders = sqliteTable(
  'video_renders',
  {
    id: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => projects.id),
    content_item_id: text().references(() => contentItems.id),
    source_asset_ids_json: text().notNull(),
    output_asset_id: text(),
    /** 'vertical_9_16'|'square_1_1'|'landscape_16_9'|'clip_short' */
    preset: text().notNull(),
    edit_plan_json: text().notNull(),
    /** Les arguments **exacts** passés à FFmpeg : un rendu est reproductible ou il n'existe pas. */
    ffmpeg_args_json: text().notNull(),
    ffmpeg_version: text(),
    status: text().notNull().default('queued'),
    progress: integer().notNull().default(0),
    duration_ms: integer(),
    output_size_bytes: integer(),
    error_json: text(),
    requested_at: integer().notNull(),
    started_at: integer(),
    finished_at: integer(),
  },
  (table) => [
    index('idx_renders_item').on(table.content_item_id, table.status),
    check(
      'chk_renders_preset',
      sql`${table.preset} in ('vertical_9_16','square_1_1','landscape_16_9','clip_short')`,
    ),
    check(
      'chk_renders_status',
      sql`${table.status} in ('queued','running','completed','failed','cancelled')`,
    ),
  ],
);
