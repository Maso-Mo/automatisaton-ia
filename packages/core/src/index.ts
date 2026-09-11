/**
 * `@aia/core` — le domaine : la seule couche qui décide.
 *
 * À l'étape 2, le domaine s'étoffe d'un premier domaine métier réel : la
 * **mémoire des projets** (`projects/`). Il reste mince ailleurs — les domaines
 * `conversation`, `editorial`, `review`, `scheduling` et `analytics` arrivent
 * avec les étapes qui les exigent (3, 4, 8 et 11) ; les construire maintenant
 * serait du code mort (docs/10 §1.3).
 *
 * Aucun import d'infrastructure ici : `packages/core` parle à des ports, et
 * `apps/api` / `apps/worker` fournissent les implémentations.
 */

export * from './conversation';
export * from './errors';
export * from './projects';
export * from './system/health';
