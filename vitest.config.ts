import { defineConfig } from 'vitest/config';

/**
 * Quatre outils de test, pas plus (docs/09 §3) :
 * Vitest (unitaire + intégration sur un fichier SQLite réel), MSW et Playwright arrivent
 * avec les premières fonctionnalités qui en ont besoin (étapes 2 et 5).
 *
 * La suite `live` est exclue par défaut : aucun test ne parle au monde extérieur
 * sans le dire (docs/09 §1.2). Elle s'exécute explicitement avec `VITEST_LIVE=1`
 * (voir `pnpm test:live`) : c'est le seul mode où un test peut dépenser du budget.
 */
const liveOnly = process.env.VITEST_LIVE === '1';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(liveOnly ? [] : ['**/*.live.test.ts']),
      'tests/e2e/**',
    ],
    setupFiles: ['tests/support/setup.ts'],
    // `forks` : beaucoup de tests ouvrent un fichier SQLite réel via un module natif.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
  },
});
