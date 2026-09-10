/**
 * `@aia/analytics` — mesures et apprentissages.
 *
 * À l'étape 1, ce paquet porte **le suivi du budget** : c'est la seule mesure
 * dont l'absence mettrait l'utilisateur en danger (docs/09 §4.3). Les métriques
 * de plateformes et la boucle d'apprentissage arrivent à l'étape 11 : elles
 * n'ont rien à faire ici avant que des publications existent.
 */

export * from './budget-guard';
export * from './budget-port';
export * from './spend';
