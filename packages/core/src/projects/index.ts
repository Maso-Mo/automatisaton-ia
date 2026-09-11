/**
 * Domaine « projets » — étape 2 : la **mémoire structurée des projets**
 * (docs/10 §4.2). Cinq fichiers, une responsabilité chacun :
 *
 * - `types.ts` : les objets du domaine et le port de persistance ;
 * - `projects.ts` : nom, slug, cycle de vie, champs modifiables ;
 * - `facts.ts` : états de vérification, transitions, remplacement ;
 * - `selection.ts` : sélection déterministe du contexte (gratuite, sans IA) ;
 * - `service.ts` : les cas d'usage, seuls points d'entrée pour `apps/api`.
 *
 * Ce qui n'est **pas** ici, volontairement : la conversation, l'extraction par
 * LLM, les fiches maîtres, les sujets et les angles. Ils appartiennent à l'étape
 * 3 et suivantes (docs/10 §4.2, §4.3).
 */

export * from './facts';
export * from './projects';
export * from './selection';
export * from './service';
export * from './types';
export * from './schemas';
