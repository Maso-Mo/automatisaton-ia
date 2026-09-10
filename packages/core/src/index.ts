/**
 * `@aia/core` — le domaine : la seule couche qui décide.
 *
 * À l'étape 1, le domaine est volontairement mince : la hiérarchie d'erreurs et
 * le cas d'usage de diagnostic. Les domaines `conversation`, `projects`,
 * `editorial`, `review`, `scheduling` et `analytics` arrivent avec les étapes
 * qui les exigent (2, 3, 4, 8 et 11).
 *
 * Aucun import d'infrastructure ici : `packages/core` parle à des ports, et
 * `apps/api` / `apps/worker` fournissent les implémentations.
 */

export * from './errors';
export * from './system/health';
