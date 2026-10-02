import { rmSync } from 'node:fs';
import { E2E_DATA_DIR } from './environment';

/**
 * Une base **neuve** à chaque exécution du parcours.
 *
 * Le parcours crée son projet, sa conversation, sa fiche maître, son plan et ses
 * contenus : hériter de l'état d'une exécution précédente rendrait les
 * assertions dépendantes de l'ordre des exécutions — exactement ce qu'un test ne
 * doit jamais être. La suppression a lieu **avant** le démarrage des serveurs
 * (`webServer` de Playwright démarre après `globalSetup`), donc avant que
 * quiconque ouvre la base.
 */
export default function globalSetup(): void {
  rmSync(E2E_DATA_DIR, { recursive: true, force: true });
}
