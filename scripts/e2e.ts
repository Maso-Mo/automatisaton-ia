/**
 * Parcours de bout en bout (E2E).
 *
 * **Aucun parcours n'est encore automatisé**, et c'est le périmètre voulu : les
 * 6 parcours de docs/09 §11 sont des parcours *utilisateur* complets (parler de
 * son projet, générer un brouillon, valider, publier). Un E2E n'a de valeur que
 * le jour où la chaîne qu'il traverse existe **entièrement** ; l'écrire avant
 * produirait un test incapable de passer, donc un test qu'on désactive.
 *
 * Playwright n'est donc pas encore installé (docs/09 §3 : quatre outils, et
 * seulement quand ils servent). Ce script échoue **bruyamment** dès qu'un dossier
 * `tests/e2e` apparaît sans être exécuté : le jour où un parcours existe, il ne
 * doit pas être oublié silencieusement.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const e2eDirectory = join(process.cwd(), 'tests', 'e2e');
const parcours = existsSync(e2eDirectory)
  ? readdirSync(e2eDirectory).filter((entry) => entry.endsWith('.spec.ts'))
  : [];

if (parcours.length > 0) {
  console.error(
    `❌ ${parcours.length} parcours E2E existent dans tests/e2e mais Playwright n'est pas branché.`,
  );
  console.error(
    '   Installer Playwright et brancher `pnpm test:e2e` (docs/09 §3) fait partie de l’étape qui introduit le parcours.',
  );
  process.exit(1);
}

console.log(
  'ℹ️  Aucun parcours E2E automatisé — les 6 parcours de docs/09 §11 sont décrits, aucun n’est encore complet.',
);
console.log(
  '   Cette étape est couverte par : unitaires (packages/*), intégration (tests/integration),',
);
console.log('   + `pnpm check:canary`, `pnpm check:boundaries`, `pnpm db:check-migrations`.');
