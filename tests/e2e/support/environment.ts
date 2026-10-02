import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalDirectories, loadConfig, type Config } from '@aia/config';

/**
 * L'environnement du parcours de bout en bout (docs/09 §11, parcours n° 1).
 *
 * Trois choses sont **choisies ici**, et nulle part ailleurs :
 *
 * 1. **une base neuve, sous `data/e2e/`** : jamais la base de développement.
 *    Un parcours navigateur écrit de vrais contenus, approuve une vraie
 *    version ; le faire sur la base de tous les jours serait un accident
 *    irréversible. Le dossier est ignoré par git (`.gitignore`) et supprimé au
 *    début de chaque exécution (`global-setup.ts`) ;
 * 2. **aucun secret, aucun réseau** : les clés d'environnement exigées par
 *    `packages/config` sont fournies en dur, et le fournisseur de modèle est
 *    **scripté** (docs/09 §1.1 : aucun test ne sort du réseau) ;
 * 3. **un worker réactif** : la boucle de production interroge la file toutes
 *    les 60 s. Un parcours qui attendrait une minute par job ne serait pas
 *    exécutable ; `WORKER_POLL_MS` descend donc à 250 ms, sans toucher au code
 *    du worker.
 */

/** Le dossier de travail du parcours : base, journaux, médias. */
export const E2E_DATA_DIR = join(process.cwd(), 'data', 'e2e');

/** Les prompts du dépôt, pas une copie. */
export const E2E_PROMPTS_DIR = fileURLToPath(new URL('../../../prompts', import.meta.url));

/** L'origine de l'interface web (Vite, cf. `apps/web/vite.config.ts`). */
export const E2E_WEB_URL = 'http://127.0.0.1:5173';

/** L'origine de l'API (cf. `APP_PORT` dans `.env.example`). */
export const E2E_API_URL = 'http://127.0.0.1:4317';

export function e2eConfig(): Config {
  const config = loadConfig({
    // Aucun `.env` n'est lu : le parcours ne doit pas dépendre de la
    // configuration de la machine, ni risquer d'utiliser une clé réelle.
    dotenvPath: null,
    rootDir: process.cwd(),
    source: {
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef',
      ENCRYPTION_KEY: 'e'.repeat(64),
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? `file:${join(E2E_DATA_DIR, 'app.db')}`,
      PROMPTS_DIR: E2E_PROMPTS_DIR,
      LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'warn',
      LOG_PRETTY: 'false',
      WORKER_POLL_MS: process.env.WORKER_POLL_MS ?? '250',
      JOB_HEARTBEAT_MS: process.env.JOB_HEARTBEAT_MS ?? '1000',
    },
  });

  ensureLocalDirectories(config);
  return config;
}
