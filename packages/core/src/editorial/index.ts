/**
 * Domaine « éditorial » — étape 3 (sujets et angles) et étape 4 (contenus
 * versionnés et brouillons multi-plateformes).
 *
 * Quatre fichiers, une responsabilité chacun :
 *
 * - `types.ts` : les objets du domaine et le port de persistance ;
 * - `plan.ts` : la validation du plan proposé — ancrage factuel, score des
 *   sujets, choix et rejet des angles ;
 * - `validation.ts` : les contrôles **locaux** d'un brouillon — longueurs de la
 *   plateforme, forme attendue, ancrage des citations ;
 * - `content.ts` : les cas d'usage du contenu — création d'un contenu par cible,
 *   enregistrement d'une version, régénération ciblée, édition, approbation ;
 * - `schemas.ts` : le vocabulaire d'entrée (ce qui est valide avant toute règle).
 *
 * Ce qui n'est **pas** ici, volontairement : l'appel au modèle (le domaine reçoit
 * un brouillon, il ne le demande pas) et l'écriture en base (le port s'en charge).
 * C'est ce qui rend ces règles testables sans réseau et sans base.
 */

export * from './content';
export * from './plan';
export * from './schemas';
export * from './types';
export * from './validation';
