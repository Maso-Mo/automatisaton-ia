import { defineConfig, devices } from '@playwright/test';
import { E2E_API_URL, E2E_WEB_URL } from './tests/e2e/support/environment';

/**
 * Playwright est le quatrième et dernier outil de test (docs/09 §3) : il n'est
 * arrivé qu'à l'étape 5, quand un parcours **utilisateur** complet a existé.
 * Jusque-là, `scripts/e2e.ts` refusait de laisser un parcours non exécuté ; c'est
 * maintenant `pnpm test:e2e` qui le lance (docs/10 §4.5, docs/09 §11).
 *
 * Ce que cette configuration met en place :
 *
 * - **un parcours, un fichier** : `tests/e2e/*.spec.ts`, jamais exécuté par
 *   Vitest (`vitest.config.ts` l'exclut) ;
 * - **deux processus démarrés pour le test** : la pile applicative scriptée
 *   (`pnpm e2e:stack` — API + boucle de worker sur une base neuve) et l'interface
 *   Vite. Playwright attend que les deux répondent avant d'ouvrir le navigateur ;
 * - **un seul worker, aucun parallélisme** : le parcours écrit dans une base
 *   unique et l'ordre des étapes fait partie de ce qu'il prouve ;
 * - **la trace n'est conservée qu'en échec** : la lire après coup est la seule
 *   façon de comprendre un parcours navigateur qui a échoué sur une machine
 *   distante, et la conserver toujours remplirait le disque.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/support/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  // Un parcours traverse l'entretien, le plan, un job de rédaction et la revue :
  // la marge est large, l'attente reste bornée.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: E2E_WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm e2e:stack',
      url: `${E2E_API_URL}/system/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm dev:web',
      url: E2E_WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
