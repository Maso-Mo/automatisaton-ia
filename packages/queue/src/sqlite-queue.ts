import {
  ValidationError,
  NotFoundError,
  ConflictError,
  encodeJson,
  serializeError,
  uuidv7,
  type Clock,
  type Random,
} from '@aia/shared';

import type { DatabaseHandle, JobRow } from '@aia/database';
import {
  addJobCost,
  appendJobEvent,
  claimNextJobs,
  completeJob,
  countJobEvents,
  countJobsByStatus,
  findActiveJobIdByDedupe,
  getJob,
  heartbeatJob,
  insertJob,
  listJobEvents,
  listJobs,
  markJobFailed,
  markJobForRetry,
  promoteDueJobs,
  reclaimExpiredJobs,
  setJobProgress,
} from '@aia/database';
import type { AppLogger } from '@aia/observability';
import { DEFAULT_BACKOFF, createBackoff } from './backoff';
import { decideRetry, isRetryAllowed } from './retry-policy';
import type { RegisteredJob } from './types';
import type { JobRegistry } from './registry';
import type { ClaimedJob, EnqueueOptions, JobContext, JobEventInput, Queue } from './types';

export interface SqliteQueueDeps {
  db: DatabaseHandle;
  registry: JobRegistry;
  clock: Clock;
  random: Random;
  logger: AppLogger;
  /** Lease par défaut (docs/08 §2.3 : 60 s). */
  leaseMs?: number;
  /** Mode hors ligne : ne rien réserver qui exige le réseau. */
  offline?: boolean;
  /** Nombre d'événements conservés par défaut à la lecture. */
  defaultEventLimit?: number;
}

/**
 * Driver V1 de la file : la table `jobs` porte la file, le lease et
 * l'historique. Aucun service externe, aucune dépendance système de plus.
 */
export class SqliteQueue implements Queue {
  private readonly db: DatabaseHandle;
  private readonly registry: JobRegistry;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly logger: AppLogger;
  private readonly leaseMs: number;
  private readonly offline: boolean;
  private readonly defaultEventLimit: number;

  constructor(deps: SqliteQueueDeps) {
    this.db = deps.db;
    this.registry = deps.registry;
    this.clock = deps.clock;
    this.random = deps.random;
    this.logger = deps.logger;
    this.leaseMs = deps.leaseMs ?? DEFAULT_BACKOFF.baseMs * 2;
    this.offline = deps.offline ?? false;
    this.defaultEventLimit = deps.defaultEventLimit ?? 200;
  }

  /** Enregistre un job. Avec `dedupeKey`, renvoie l'identifiant du job déjà en attente. */
  async enqueue<TInput>(type: string, input: TInput, opts: EnqueueOptions = {}): Promise<string> {
    const definition = this.requireDefinition(type);
    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError(
        `Entrée invalide pour le job « ${type} » : ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(racine)'} ${issue.message}`)
          .join(' ; ')}`,
        { code: 'JOB_INPUT_INVALID', details: { type } },
      );
    }

    const now = this.clock.nowMs();
    const dedupeKey =
      opts.dedupeKey ??
      (definition.dedupeKey ? definition.dedupeKey(parsed.data as never) : undefined) ??
      null;

    if (dedupeKey) {
      const existing = findActiveJobIdByDedupe(this.db, type, dedupeKey);
      if (existing) {
        this.logger.debug({ jobId: existing, type, dedupeKey }, 'job déjà en file : aucun doublon');
        return existing;
      }
    }

    const jobId = uuidv7(now);
    const delayMs = opts.delayMs ?? 0;
    insertJob(this.db, {
      id: jobId,
      type,
      priority: opts.priority ?? definition.priority ?? 5,
      inputJson: encodeJson(parsed.data),
      dedupeKey,
      idempotent: definition.idempotent,
      requiresNetwork: opts.requiresNetwork ?? definition.requiresNetwork ?? false,
      scheduledFor: now + delayMs,
      availableAt: now + delayMs,
      maxAttempts: definition.maxAttempts,
      projectId: opts.projectId ?? null,
      contentItemId: opts.contentItemId ?? null,
      parentJobId: opts.parentJobId ?? null,
      now,
    });

    return jobId;
  }

  async claim(
    workerId: string,
    limit: number,
    opts: { offline?: boolean } = {},
  ): Promise<ClaimedJob[]> {
    const offline = opts.offline ?? this.offline;
    const now = this.clock.nowMs();
    const rows = claimNextJobs(this.db, {
      workerId,
      limit,
      now,
      leaseMs: this.leaseMs,
      offline,
    });

    const claimed: ClaimedJob[] = [];
    for (const row of rows) {
      const definition = this.registry.get(row.type);
      if (!definition) {
        await this.fail(
          row.id,
          new ValidationError(`Aucun handler enregistré pour le type de job « ${row.type} »`, {
            code: 'JOB_TYPE_UNKNOWN',
          }),
          false,
        );
        continue;
      }

      // Un type qui a besoin d'un lease plus long (rendu vidéo) le prolonge ici.
      if (definition.leaseMs > this.leaseMs) {
        heartbeatJob(this.db, { jobId: row.id, now, leaseMs: definition.leaseMs });
      }

      const input = this.parseInput(row);
      if (input === undefined) continue; // entrée illisible : le job a été marqué en échec

      claimed.push({
        id: row.id,
        type: row.type,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        priority: row.priority,
        requiresNetwork: row.requires_network,
        input,
        leaseMs: definition.leaseMs,
      });
    }

    return claimed;
  }

  async complete(
    jobId: string,
    result: unknown,
    extra: { durationMs?: number } = {},
  ): Promise<void> {
    const row = this.requireJob(jobId);
    const now = this.clock.nowMs();
    const durationMs = extra.durationMs ?? (row.started_at ? now - row.started_at : 0);

    completeJob(this.db, {
      jobId,
      now,
      outputJson: result === undefined ? null : encodeJson(result),
      durationMs,
    });

    await this.appendEvent(jobId, {
      level: 'info',
      step: 'done',
      message: 'job terminé',
      progress: 100,
      durationMs,
    });
  }

  /**
   * Un échec n'est **pas** décidé par le handler : on applique la table de
   * décision de docs/02 §12 à la catégorie de l'erreur. `retry` peut forcer la
   * main, sauf pour un résultat ambigu — jamais rejoué automatiquement.
   */
  async fail(jobId: string, error: unknown, retry?: boolean): Promise<void> {
    const row = this.requireJob(jobId);
    const now = this.clock.nowMs();
    const serialized = serializeError(error);
    const decision = decideRetry(error, {
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      idempotent: row.idempotent,
    });

    const shouldRetry = decision.requiresHumanDecision
      ? false
      : (retry ?? decision.retry) && isRetryAllowed(decision.category);

    if (shouldRetry) {
      const delayMs = this.definitionBackoff(row.type)(row.attempt);
      markJobForRetry(this.db, {
        jobId,
        now,
        availableAt: now + delayMs,
        errorJson: encodeJson(serialized),
      });
      await this.appendEvent(jobId, {
        level: 'warn',
        step: 'retry',
        message: `nouvelle tentative dans ${Math.round(delayMs / 1000)} s (${decision.reason})`,
        data: { category: serialized.category, code: serialized.code },
      });
      return;
    }

    markJobFailed(this.db, { jobId, now, errorJson: encodeJson(serialized) });
    await this.appendEvent(jobId, {
      level: 'error',
      step: 'failed',
      message: `échec définitif : ${serialized.message}`,
      data: { category: serialized.category, code: serialized.code, reason: decision.reason },
    });
  }

  /** Reprise après crash : un job `running` dont le lease a expiré retourne en file. */
  async reclaimExpired(now: Date): Promise<number> {
    const ids = reclaimExpiredJobs(this.db, { now: now.getTime() });
    for (const jobId of ids) {
      await this.appendEvent(jobId, {
        level: 'warn',
        step: 'reclaim',
        message: 'lease expiré : job remis en file (aucune tentative supplémentaire consommée)',
      });
    }
    return ids.length;
  }

  /** Battement de cœur : le lease est prolongé, personne ne vole le job. */
  async heartbeat(jobId: string): Promise<boolean> {
    const row = getJob(this.db, jobId);
    const leaseMs = row ? this.definitionLeaseMs(row.type) : this.leaseMs;
    return heartbeatJob(this.db, { jobId, now: this.clock.nowMs(), leaseMs });
  }

  /** Rend disponibles les jobs dont l'échéance est passée (retry, cron) — docs/08 §2.1. */
  promoteScheduled(now: Date = this.clock.now()): number {
    return promoteDueJobs(this.db, { now: now.getTime() });
  }

  async appendEvent(jobId: string, event: JobEventInput): Promise<void> {
    const now = this.clock.nowMs();
    appendJobEvent(this.db, {
      id: uuidv7(now),
      jobId,
      level: event.level ?? 'info',
      message: event.message,
      step: event.step ?? null,
      dataJson: event.data === undefined ? null : encodeJson(event.data),
      progress: event.progress ?? null,
      durationMs: event.durationMs ?? null,
      now,
    });
  }

  /** Met à jour l'étape courante : c'est ce qui rend la reprise possible sans tout refaire. */
  async setStep(jobId: string, step: string, progress?: number): Promise<void> {
    setJobProgress(this.db, {
      jobId,
      progress: progress ?? 0,
      currentStep: step,
      now: this.clock.nowMs(),
    });
  }

  async recordCost(jobId: string, microUsd: number): Promise<void> {
    addJobCost(this.db, { jobId, microUsd, now: this.clock.nowMs() });
  }

  /** Annulation utilisateur : `cancelled` n'est jamais `failed` (docs/08 §3). */
  async cancel(jobId: string): Promise<void> {
    const row = this.requireJob(jobId);
    if (row.status === 'completed' || row.status === 'cancelled') {
      throw new ConflictError(`Job ${jobId} déjà terminé (${row.status})`, {
        code: 'JOB_NOT_CANCELLABLE',
      });
    }
    markJobFailed(this.db, {
      jobId,
      now: this.clock.nowMs(),
      errorJson: encodeJson({ name: 'CancelledError', category: 'conflict', message: 'annulé' }),
      status: 'cancelled',
    });
    await this.appendEvent(jobId, {
      level: 'info',
      step: 'cancelled',
      message: 'annulé par l’utilisateur',
    });
  }

  get(jobId: string): JobRow | undefined {
    return getJob(this.db, jobId);
  }

  list(filter: { statuses?: JobRow['status'][]; type?: string; limit?: number } = {}): JobRow[] {
    return listJobs(this.db, filter);
  }

  counts(): Record<string, number> {
    return countJobsByStatus(this.db);
  }

  events(jobId: string, afterSequence?: number, limit?: number) {
    return listJobEvents(this.db, {
      jobId,
      afterSequence,
      limit: limit ?? this.defaultEventLimit,
    });
  }

  eventCount(jobId: string): number {
    return countJobEvents(this.db, jobId);
  }

  /** Construit le contexte donné au handler : ni base, ni Drizzle, ni secret. */
  buildContext(job: ClaimedJob, workerId: string, signal: AbortSignal): JobContext {
    const logger = this.logger.child({ jobId: job.id, task: job.type, attempt: job.attempt });
    return {
      jobId: job.id,
      type: job.type,
      attempt: job.attempt,
      workerId,
      signal,
      logger,
      emitEvent: (event) => this.appendEvent(job.id, event),
      setStep: async (step, progress) => {
        await this.appendEvent(job.id, {
          step,
          message: `étape ${step}`,
          ...(progress === undefined ? {} : { progress }),
        });
        await this.setStep(job.id, step, progress);
      },
      recordCost: (microUsd) => this.recordCost(job.id, microUsd),
    };
  }

  private requireDefinition(type: string): RegisteredJob {
    const definition = this.registry.get(type);
    if (!definition) {
      throw new ValidationError(`Type de job inconnu : ${type}`, {
        code: 'JOB_TYPE_UNKNOWN',
        details: { known: this.registry.types() },
      });
    }
    return definition;
  }

  private requireJob(jobId: string): JobRow {
    const row = getJob(this.db, jobId);
    if (!row) {
      throw new NotFoundError(`Job introuvable : ${jobId}`, { code: 'JOB_NOT_FOUND' });
    }
    return row;
  }

  private definitionLeaseMs(type: string): number {
    return this.registry.get(type)?.leaseMs ?? this.leaseMs;
  }

  private definitionBackoff(type: string): (attempt: number) => number {
    const definition = this.registry.get(type);
    if (definition) return definition.backoff;
    return createBackoff(DEFAULT_BACKOFF, this.random);
  }

  /** Une entrée illisible est un échec de validation, pas un crash du worker. */
  private parseInput(row: JobRow): unknown {
    const definition = this.registry.get(row.type);
    if (!definition) return undefined;

    let raw: unknown;
    try {
      raw = JSON.parse(row.input_json) as unknown;
    } catch {
      void this.fail(
        row.id,
        new ValidationError(`Entrée JSON illisible pour le job ${row.id}`, {
          code: 'JOB_INPUT_CORRUPT',
        }),
        false,
      );
      return undefined;
    }

    const parsed = definition.inputSchema.safeParse(raw);
    if (!parsed.success) {
      void this.fail(
        row.id,
        new ValidationError(`Entrée invalide pour le job ${row.id}`, {
          code: 'JOB_INPUT_INVALID',
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        }),
        false,
      );
      return undefined;
    }
    return parsed.data;
  }
}
