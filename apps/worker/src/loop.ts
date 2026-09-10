import { releaseJobLease, type DatabaseHandle } from '@aia/database';
import type { AppLogger } from '@aia/observability';
import type { Clock } from '@aia/shared';
import type { JobRegistry, SqliteQueue } from '@aia/queue';

/**
 * La boucle du worker, exactement dans l'ordre décrit par docs/08 §2.1 :
 *
 * ```text
 *   reclaimExpired()   jobs 'running' dont le lease a expiré → 'queued'
 *   promoteScheduled() available_at = now pour les jobs échus
 *   claim()            réservation atomique des N jobs prioritaires
 *   run()              exécution, un job à la fois dans ce processus
 *   heartbeat()        toutes les 10 s pendant l'exécution
 * ```
 *
 * L'arrêt propre suit docs/08 §2.4 : on cesse de réserver, on laisse le job
 * courant terminer son étape, on libère le lease, on ferme la base. Le job repris
 * ailleurs **ne consomme pas** de tentative supplémentaire.
 */

export interface WorkerLoopOptions {
  handle: DatabaseHandle;
  queue: SqliteQueue;
  registry: JobRegistry;
  logger: AppLogger;
  clock: Clock;
  workerId: string;
  pollMs: number;
  heartbeatMs: number;
  batchSize: number;
  offline: boolean;
  /** Délai maximal accordé au job courant avant libération du lease (docs/08 §2.4). */
  shutdownGraceMs?: number;
}

export interface WorkerLoop {
  /** Un tour complet : reprise, promotion, réservation, exécution. Nombre de jobs traités. */
  runOnce(): Promise<number>;
  start(): void;
  stop(): Promise<void>;
  /** Identifiant du job en cours d'exécution, s'il y en a un. */
  currentJobId(): string | null;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export function createWorkerLoop(options: WorkerLoopOptions): WorkerLoop {
  const {
    handle,
    queue,
    registry,
    logger,
    clock,
    workerId,
    pollMs,
    heartbeatMs,
    batchSize,
    offline,
  } = options;
  const shutdownGraceMs = options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<unknown> | null = null;
  let currentJobId: string | null = null;
  let currentController: AbortController | null = null;

  const schedule = (delayMs: number): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  };

  const withGrace = async (execution: Promise<unknown>): Promise<void> => {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        currentController?.abort();
        resolve();
      }, shutdownGraceMs);
      timeout.unref?.();
      void execution.finally(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  };

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      const processed = await loopRunOnce();
      // « Immédiatement après la fin d'un job » : pas d'attente inutile de 60 s.
      schedule(processed > 0 ? 0 : pollMs);
    } catch (error) {
      logger.error({ err: error }, 'erreur pendant un tour de worker : la boucle continue');
      schedule(pollMs);
    }
  };

  const loopRunOnce = async (): Promise<number> => {
    const reclaimed = await queue.reclaimExpired(clock.now());
    if (reclaimed > 0) {
      logger.warn({ reclaimed }, 'jobs repris après expiration de leur lease');
    }
    const promoted = queue.promoteScheduled();
    if (promoted > 0) {
      logger.debug({ promoted }, 'jobs échus rendus disponibles');
    }

    const claimed = await queue.claim(workerId, batchSize, { offline });
    let processed = 0;

    for (const job of claimed) {
      if (stopping) {
        // Arrêt demandé : le job réservé est rendu immédiatement à la file.
        releaseJobLease(handle, { jobId: job.id, now: clock.nowMs() });
        await queue.appendEvent(job.id, {
          level: 'info',
          step: 'released',
          message: 'lease libéré : arrêt du worker demandé',
        });
        continue;
      }

      const definition = registry.get(job.type);
      if (!definition) {
        await queue.fail(job.id, new Error(`Handler absent pour le type ${job.type}`), false);
        continue;
      }

      const controller = new AbortController();
      currentController = controller;
      currentJobId = job.id;
      const context = queue.buildContext(job, workerId, controller.signal);
      const heartbeat = setInterval(() => {
        void queue.heartbeat(job.id).catch((error: unknown) => {
          logger.debug({ err: error, jobId: job.id }, 'battement de cœur refusé');
        });
      }, heartbeatMs);
      heartbeat.unref?.();

      const execution = (async () => {
        logger.info({ type: job.type, attempt: job.attempt }, 'job réservé');
        try {
          const output = await definition.handler(job.input, context);
          await queue.complete(job.id, output);
          logger.info({ type: job.type }, 'job terminé');
        } catch (error) {
          // Le handler ne décide pas de la reprise : la file applique la politique.
          await queue.fail(job.id, error);
          logger.warn({ type: job.type, err: error }, 'job en échec');
        } finally {
          clearInterval(heartbeat);
          currentJobId = null;
          currentController = null;
        }
      })();

      current = execution;
      if (stopping) {
        await withGrace(execution);
      } else {
        await execution;
      }
      processed += 1;
    }

    return processed;
  };

  return {
    async runOnce() {
      return loopRunOnce();
    },

    start() {
      if (timer) return;
      stopping = false;
      logger.info({ workerId, pollMs, batchSize, offline }, 'boucle du worker démarrée');
      void tick();
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      logger.info('arrêt demandé : plus aucune réservation de job');
      if (current) {
        await withGrace(current);
      }
      logger.info('boucle du worker arrêtée');
    },

    currentJobId: () => currentJobId,
  };
}
