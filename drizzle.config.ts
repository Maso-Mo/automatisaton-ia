import { defineConfig } from 'drizzle-kit';

/**
 * Migrations SQL versionnées dans `packages/database/migrations/` (docs/03 §16.3).
 * Sens unique : toujours en avant (`up`) ; un `down` n'est écrit que pour une
 * migration destructrice. Les déclencheurs SQL vivent dans des fichiers manuels
 * à côté des migrations générées (aucun déclencheur à l'étape 1 : les tables
 * concernées — `publications`, `content_claims` — arrivent aux étapes 4 et 5).
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/database/src/schema/index.ts',
  out: './packages/database/migrations',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'file:./data/app.db',
  },
});
