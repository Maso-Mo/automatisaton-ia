/**
 * `@aia/queue` — abstraction de la file de jobs.
 *
 * « La file vit en base » : `SqliteQueue` porte la file, le lease et
 * l'historique dans la table `jobs`. Le contrat `Queue` (docs/02 §9.3) est figé
 * avant le code : un driver `RedisQueue` pourra le remplacer sans modifier un
 * seul appel du domaine.
 */

export * from './backoff';
export * from './registry';
export * from './retry-policy';
export * from './sqlite-queue';
export * from './types';
