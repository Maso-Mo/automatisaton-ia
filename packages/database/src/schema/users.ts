import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Utilisateur et configuration — tables créées à l'étape 1 (docs/03 §4).
 * Conventions transverses (docs/03 §2) : identifiants `TEXT` (UUID v7),
 * horodatages `INTEGER` (ms epoch), booléens `INTEGER` 0/1, montants entiers en
 * micro-dollars, JSON `TEXT` validé par Zod côté code.
 */

/** Un seul utilisateur en V1, mais la table existe pour ne pas réécrire le schéma. */
export const users = sqliteTable('users', {
  id: text().primaryKey(),
  display_name: text().notNull(),
  email: text().unique(), // nullable : usage purement local
  password_hash: text(), // nullable : mode local sans mot de passe (docs/07)
  locale: text().notNull().default('fr-FR'),
  created_at: integer().notNull(),
  updated_at: integer().notNull(),
});

/** Réglages modifiables depuis l'interface, en lignes clé/valeur typées. */
export const appSettings = sqliteTable('app_settings', {
  key: text().primaryKey(),
  value_json: text().notNull(),
  value_type: text().notNull(), // 'string' | 'number' | 'boolean' | 'json'
  updated_at: integer().notNull(),
});

/** Un enregistrement par fournisseur IA connu. */
export const llmProvidersConfig = sqliteTable(
  'llm_providers_config',
  {
    id: text().primaryKey(),
    provider: text().notNull(), // 'deepseek'|'openrouter'|'openai'|'anthropic'|'gemini'|'ollama'
    api_key_encrypted: text(), // chiffré AES-256-GCM ; null si Ollama local
    key_version: integer().notNull().default(1),
    base_url: text(),
    enabled: integer({ mode: 'boolean' }).notNull().default(false),
    default_model: text(),
    is_default: integer({ mode: 'boolean' }).notNull().default(false),
    last_health_ok_at: integer(),
    last_health_error: text(),
    created_at: integer().notNull(),
    updated_at: integer().notNull(),
  },
  (table) => [
    // Un seul fournisseur par défaut : deux rendraient les agents imprévisibles (docs/03 §4.3).
    uniqueIndex('uq_provider_default')
      .on(table.is_default)
      .where(sql`${table.is_default} = 1`),
    index('idx_provider_enabled').on(table.enabled),
  ],
);
