/**
 * `@aia/database` — persistance.
 *
 * « Contrat de portabilité : tous les accès passent par `packages/database`.
 * Aucun import de `drizzle-orm/sqlite-core` en dehors de ce package »
 * (docs/02 §4). C'est ce qui rend la migration vers PostgreSQL mécanique.
 */

export * from './client';
export * from './migrations';
export * from './repositories/conversation';
export * from './repositories/job-events';
export * from './repositories/jobs';
export * from './repositories/llm-calls';
export * from './repositories/project-memory';
export * from './repositories/prompt-versions';
export * from './repositories/settings';
export * from './repositories/users';
export * from './schema';
