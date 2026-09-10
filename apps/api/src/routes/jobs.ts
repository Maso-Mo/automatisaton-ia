import { NotFoundError, ValidationError } from '@aia/shared';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';

/**
 * Lecture des jobs et flux d'événements.
 *
 * Aucune route d'**action** à l'étape 1 : la seule création de job passe par la
 * sonde en ligne de commande (`pnpm job:noop`). Les routes qui modifient l'état
 * arrivent avec les fonctionnalités qui les exigent (étape 2 et suivantes).
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dead']);

interface PublicJob {
  id: string;
  type: string;
  status: string;
  priority: number;
  attempt: number;
  maxAttempts: number;
  progress: number;
  currentStep: string | null;
  requiresNetwork: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  costMicroUsd: number;
  error: unknown;
}

function toPublicJob(row: {
  id: string;
  type: string;
  status: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  progress: number;
  current_step: string | null;
  requires_network: boolean;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  duration_ms: number | null;
  cost_micro_usd: number;
  error_json: string | null;
}): PublicJob {
  let error: unknown = null;
  if (row.error_json) {
    try {
      error = JSON.parse(row.error_json) as unknown;
    } catch {
      error = { message: row.error_json };
    }
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    progress: row.progress,
    currentStep: row.current_step,
    requiresNetwork: row.requires_network,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    costMicroUsd: row.cost_micro_usd,
    error,
  };
}

export function registerJobRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/jobs', async (request) => {
    const query = request.query as { status?: string; limit?: string };
    const statuses = query.status
      ? query.status
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value.length > 0)
      : undefined;
    const limit = Math.min(Math.max(Number(query.limit ?? 20) || 20, 1), 100);

    const jobs = context.jobs({ ...(statuses ? { statuses: statuses as never } : {}), limit });
    return { jobs: jobs.map(toPublicJob) };
  });

  app.get('/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    const job = context.job(id);
    if (!job) {
      throw new NotFoundError(`Job introuvable : ${id}`, { code: 'JOB_NOT_FOUND' });
    }
    return {
      job: toPublicJob(job),
      events: context.jobEvents(id, 0, 500).map((event) => ({
        sequence: event.sequence,
        level: event.level,
        step: event.step,
        message: event.message,
        progress: event.progress,
        durationMs: event.duration_ms,
        createdAt: event.created_at,
      })),
    };
  });

  /**
   * Flux SSE **reprenable** (docs/02 §13, docs/08 §5.3) : le client envoie le
   * dernier `sequence` reçu et reçoit un état complet avant les événements
   * incrémentaux. Sans cela, une coupure d'une seconde ferait perdre l'affichage
   * des étapes intermédiaires — et l'utilisateur croirait à un blocage.
   */
  app.get('/events/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { lastSequence?: string; intervalMs?: string };
    const job = context.job(id);
    if (!job) {
      throw new NotFoundError(`Job introuvable : ${id}`, { code: 'JOB_NOT_FOUND' });
    }

    const intervalMs = Math.min(Math.max(Number(query.intervalMs ?? 1_000) || 1_000, 250), 10_000);
    const requestedSequence = Number(query.lastSequence ?? 0);
    if (Number.isNaN(requestedSequence) || requestedSequence < 0) {
      throw new ValidationError('lastSequence doit être un entier positif ou nul', {
        code: 'SEQUENCE_INVALID',
      });
    }
    let lastSequence = requestedSequence;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Le contrôle de la réponse passe au flux : Fastify n'écrira plus rien.
    // Sans cela, l'en-tête n'est jamais envoyé (le handler ne rend pas la main).
    reply.hijack();

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // 1. État complet d'abord : la reprise ne perd aucun événement.
    const current = context.job(id);
    if (current) {
      send('snapshot', { job: toPublicJob(current) });
    }
    for (const event of context.jobEvents(id, lastSequence, 500)) {
      lastSequence = event.sequence;
      send('job_event', { ...event, jobId: id });
    }

    const interval = setInterval(() => {
      try {
        const fresh = context.jobEvents(id, lastSequence, 200);
        for (const event of fresh) {
          lastSequence = event.sequence;
          send('job_event', { ...event, jobId: id });
        }

        const latest = context.job(id);
        if (!latest) {
          send('closed', { reason: 'job introuvable' });
          close();
          return;
        }
        if (TERMINAL_STATUSES.has(latest.status) && fresh.length === 0) {
          send('done', { job: toPublicJob(latest) });
          close();
        }
      } catch (error) {
        context.logger.error({ err: error, jobId: id }, 'flux SSE interrompu');
        send('closed', { reason: 'erreur interne' });
        close();
      }
    }, intervalMs);

    const close = (): void => {
      clearInterval(interval);
      reply.raw.end();
    };

    request.raw.on('close', () => {
      clearInterval(interval);
      context.logger.debug({ jobId: id, lastSequence }, 'client SSE déconnecté');
    });
  });
}
