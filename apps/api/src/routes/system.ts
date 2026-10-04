import { accessSync, constants, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';
import { computeDiagnostics } from '../diagnostics';

/**
 * Diagnostic : le seul écran de l'étape 1 (docs/10 §4.1). Il répond à une
 * question simple — *le socle est-il en état de fonctionner ?* — sans exiger
 * d'ouvrir un terminal.
 *
 * L'étape 12 sépare trois questions qui n'ont ni le même usage ni le même coût :
 *
 * - `GET /health` — **vivacité**. Le processus répond-il ? Ni base, ni disque :
 *   une sonde peut l'appeler toutes les secondes sans rien payer.
 * - `GET /ready` — **disponibilité**. La base est-elle saine, le disque
 *   inscriptible ? Renvoie **503** tant que ce n'est pas le cas, pour qu'aucun
 *   trafic n'arrive sur une instance incomplète.
 * - `GET /system/diagnostics` — **exploitation**. Place disque, dernière
 *   sauvegarde, jobs en échec, services configurés.
 */

const PUBLIC_HINT = 'cette route reste publique (sonde de supervision)';

function isWritable(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function registerSystemRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
    version: '0.1.0',
    uptimeMs: Date.now() - context.startedAtMs,
    note: PUBLIC_HINT,
  }));

  app.get('/ready', async (_request, reply) => {
    const health = context.health();
    const blocking = health.checks.filter((check) => check.status === 'error');
    const storage = {
      database: isWritable(context.config.paths.dataDir),
      media: isWritable(context.config.paths.mediaRoot),
      backups: isWritable(context.config.paths.backupDir),
    };
    const storageReady = Object.values(storage).every(Boolean);
    const ready = blocking.length === 0 && storageReady;

    reply.code(ready ? 200 : 503);
    return {
      ready,
      status: health.status,
      generatedAt: health.generatedAt,
      uptimeMs: health.uptimeMs,
      retryAfterMs: ready ? null : 5_000,
      storage,
      // On renvoie les vérifications bloquantes en clair : c'est l'action à
      // mener qui intéresse l'exploitant, pas un booléen.
      blocking: blocking.map((check) => ({
        id: check.id,
        label: check.label,
        detail: check.detail,
      })),
      checks: health.checks.map((check) => ({
        id: check.id,
        label: check.label,
        status: check.status,
        detail: check.detail,
      })),
      note: PUBLIC_HINT,
    };
  });

  app.get('/system/health', async () => context.health());

  app.get('/system/diagnostics', async () => {
    // Les échecs ne sont jamais supprimés automatiquement (docs/10 §12) : les
    // compter est le seul moyen de rendre le problème visible.
    const failed = context.jobs({ statuses: ['failed', 'dead'], limit: 500 });
    return computeDiagnostics({
      config: context.config,
      failedJobs: failed.length,
      nowMs: Date.now(),
    });
  });

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
