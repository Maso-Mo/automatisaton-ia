/**
 * Domaine « conversation » — étape 3 : l'entretien par texte et la **fiche
 * maître** (docs/03 §7 et §8.1, docs/05 §3).
 *
 * Six fichiers, une responsabilité chacun :
 *
 * - `types.ts` : les objets du domaine et le port de persistance ;
 * - `stages.ts` : les huit phases, la liste des lacunes, les transitions ;
 * - `messages.ts` : messages et **fenêtre glissante** (10 messages + résumés) ;
 * - `edit-plan.ts` : les propositions d'écriture et leur validation par l'humain ;
 * - `master-brief.ts` : la fiche maître, ses versions et son immuabilité ;
 * - `service.ts` : les cas d'usage, seuls points d'entrée pour `apps/api`.
 *
 * Ce qui n'est **pas** ici, volontairement : la transcription vocale, les sujets
 * et les angles, et la génération de contenus (étapes suivantes du plan).
 */

export * from './edit-plan';
export * from './master-brief';
export * from './messages';
export * from './schemas';
export * from './service';
export * from './stages';
export * from './types';
