import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';

/**
 * Diagnostic : le seul écran de l'étape 1 (docs/10 §4.1). Il répond à une
 * question simple — *le socle est-il en état de fonctionner ?* — sans exiger
 * d'ouvrir un terminal.
 */
export function registerSystemRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/system/health', async () => context.health());

  app.get('/system/jobs-summary', async () => {
    const jobs = context.jobs({ limit: 200 });
    const recent = jobs.slice(0, 10).map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.created_at,
      finishedAt: job.finished_at,
      costMicroUsd: job.cost_micro_usd,
    }));
    return { counts: context.health().worker.jobs, recent };
  });
}
