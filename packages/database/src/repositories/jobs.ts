import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../client';
import { jobs } from '../schema';

/**
 * Persistance de la file de jobs — **uniquement du SQL**. La politique (retry,
 * backoff, événements) vit dans `@aia/queue` : un handler ne décide jamais de
 * réessayer, et le SQL ne décide de rien (docs/02 §12).
 */

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueJobInput {
  id: string;
  type: string;
  priority: number;
  inputJson: string;
  dedupeKey: string | null;
  idempotent: boolean;
  requiresNetwork: boolean;
  scheduledFor: number;
  availableAt: number;
  maxAttempts: number;
  projectId?: string | null;
  contentItemId?: string | null;
  parentJobId?: string | null;
  now: number;
}

export function findActiveJobIdByDedupe(
  handle: DatabaseHandle,
  type: string,
  dedupeKey: string,
): string | undefined {
  const row = handle.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, type),
        eq(jobs.dedupe_key, dedupeKey),
        inArray(jobs.status, ['queued', 'running']),
      ),
    )
    .get();
  return row?.id;
}

export function insertJob(handle: DatabaseHandle, input: EnqueueJobInput): void {
  handle.db
    .insert(jobs)
    .values({
      id: input.id,
      type: input.type,
      status: 'queued',
      priority: input.priority,
      input_json: input.inputJson,
      project_id: input.projectId ?? null,
      content_item_id: input.contentItemId ?? null,
      parent_job_id: input.parentJobId ?? null,
      dedupe_key: input.dedupeKey,
      idempotent: input.idempotent,
      requires_network: input.requiresNetwork,
      scheduled_for: input.scheduledFor,
      available_at: input.availableAt,
      attempt: 0,
      max_attempts: input.maxAttempts,
      created_at: input.now,
      updated_at: input.now,
    })
    .run();
}

export function getJob(handle: DatabaseHandle, id: string): JobRow | undefined {
  return handle.db.select().from(jobs).where(eq(jobs.id, id)).get();
}

export interface ListJobsFilter {
  statuses?: JobRow['status'][];
  type?: string;
  limit?: number;
}

export function listJobs(handle: DatabaseHandle, filter: ListJobsFilter = {}): JobRow[] {
  const conditions = [];
  if (filter.statuses && filter.statuses.length > 0) {
    conditions.push(inArray(jobs.status, filter.statuses));
  }
  if (filter.type) conditions.push(eq(jobs.type, filter.type));

  const base = handle.db.select().from(jobs).orderBy(desc(jobs.created_at));
  const filtered = conditions.length > 0 ? base.where(and(...conditions)) : base;
  return filtered.limit(filter.limit ?? 50).all();
}

export function countJobsByStatus(handle: DatabaseHandle): Record<string, number> {
  const rows = handle.db
    .select({ status: jobs.status, total: count() })
    .from(jobs)
    .groupBy(jobs.status)
    .all();
  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row.total;
  return result;
}

export interface ClaimParams {
  workerId: string;
  limit: number;
  now: number;
  leaseMs: number;
  offline: boolean;
}

/**
 * **Le cœur de la file** (docs/08 §2.2) : réservation atomique dans une
 * transaction `BEGIN IMMEDIATE`, `attempt` incrémenté à la réservation.
 *
 * `BEGIN IMMEDIATE` prend le verrou d'écriture immédiatement : sans lui, deux
 * transactions commencent en lecture puis échouent en `SQLITE_BUSY` une fois sur
 * cent — c'est précisément ce mécanisme qui remplace Redis ici.
 */
export function claimNextJobs(handle: DatabaseHandle, params: ClaimParams): JobRow[] {
  const run = handle.db.transaction(
    (tx) =>
      (p: ClaimParams): JobRow[] => {
        const candidates = tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(
            and(
              eq(jobs.status, 'queued'),
              lte(jobs.available_at, p.now),
              p.offline ? eq(jobs.requires_network, false) : undefined,
            ),
          )
          .orderBy(asc(jobs.priority), asc(jobs.available_at), asc(jobs.created_at))
          .limit(p.limit)
          .all();

        const ids = candidates.map((row) => row.id);
        if (ids.length === 0) return [];

        tx.update(jobs)
          .set({
            status: 'running',
            worker_id: p.workerId,
            started_at: p.now,
            attempt: sql`${jobs.attempt} + 1`,
            lease_expires_at: p.now + p.leaseMs,
            heartbeat_at: p.now,
            updated_at: p.now,
          })
          .where(and(inArray(jobs.id, ids), eq(jobs.status, 'queued')))
          .run();

        return tx.select().from(jobs).where(inArray(jobs.id, ids)).all();
      },
    { behavior: 'immediate' },
  );

  return run(params);
}

export function heartbeatJob(
  handle: DatabaseHandle,
  params: { jobId: string; now: number; leaseMs: number },
): boolean {
  const result = handle.db
    .update(jobs)
    .set({
      heartbeat_at: params.now,
      lease_expires_at: params.now + params.leaseMs,
      updated_at: params.now,
    })
    .where(and(eq(jobs.id, params.jobId), eq(jobs.status, 'running')))
    .run();
  return result.changes > 0;
}

export function setJobProgress(
  handle: DatabaseHandle,
  params: { jobId: string; progress: number; currentStep: string | null; now: number },
): void {
  handle.db
    .update(jobs)
    .set({ progress: params.progress, current_step: params.currentStep, updated_at: params.now })
    .where(eq(jobs.id, params.jobId))
    .run();
}

/** Le coût d'un job s'accumule : il n'est jamais écrasé (docs/08 §7). */
export function addJobCost(
  handle: DatabaseHandle,
  params: { jobId: string; microUsd: number; now: number },
): void {
  handle.db
    .update(jobs)
    .set({
      cost_micro_usd: sql`${jobs.cost_micro_usd} + ${params.microUsd}`,
      updated_at: params.now,
    })
    .where(eq(jobs.id, params.jobId))
    .run();
}

export function completeJob(
  handle: DatabaseHandle,
  params: { jobId: string; now: number; outputJson: string | null; durationMs: number },
): void {
  handle.db
    .update(jobs)
    .set({
      status: 'completed',
      output_json: params.outputJson,
      finished_at: params.now,
      duration_ms: params.durationMs,
      progress: 100,
      worker_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
      updated_at: params.now,
    })
    .where(eq(jobs.id, params.jobId))
    .run();
}

/** Retry réessayable : le job retourne en file avec un `available_at` futur. */
export function markJobForRetry(
  handle: DatabaseHandle,
  params: { jobId: string; now: number; availableAt: number; errorJson: string },
): void {
  handle.db
    .update(jobs)
    .set({
      status: 'queued',
      available_at: params.availableAt,
      error_json: params.errorJson,
      worker_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
      updated_at: params.now,
    })
    .where(eq(jobs.id, params.jobId))
    .run();
}

export function markJobFailed(
  handle: DatabaseHandle,
  params: {
    jobId: string;
    now: number;
    errorJson: string;
    status?: 'failed' | 'cancelled' | 'dead';
  },
): void {
  handle.db
    .update(jobs)
    .set({
      status: params.status ?? 'failed',
      error_json: params.errorJson,
      finished_at: params.now,
      worker_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
      updated_at: params.now,
    })
    .where(eq(jobs.id, params.jobId))
    .run();
}

/**
 * Récupère les jobs `running` dont le lease a expiré : le worker est mort.
 * La reprise **ne consomme pas de tentative supplémentaire** (docs/08 §2.3) —
 * c'est pour cela que `attempt` n'est pas modifié ici.
 */
export function reclaimExpiredJobs(handle: DatabaseHandle, params: { now: number }): string[] {
  return handle.db.transaction(
    (tx) =>
      (p: { now: number }): string[] => {
        const expired = tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.status, 'running'), lte(jobs.lease_expires_at, p.now)))
          .all();

        const ids = expired.map((row) => row.id);
        if (ids.length === 0) return [];

        tx.update(jobs)
          .set({
            status: 'queued',
            worker_id: null,
            lease_expires_at: null,
            heartbeat_at: null,
            available_at: p.now,
            updated_at: p.now,
          })
          .where(and(inArray(jobs.id, ids), eq(jobs.status, 'running')))
          .run();

        return ids;
      },
    { behavior: 'immediate' },
  )(params);
}

/** Rend disponibles les jobs dont l'échéance (`scheduled_for`) est dépassée. */
export function promoteDueJobs(handle: DatabaseHandle, params: { now: number }): number {
  const result = handle.db
    .update(jobs)
    .set({ available_at: params.now, updated_at: params.now })
    .where(
      and(
        eq(jobs.status, 'queued'),
        lte(jobs.scheduled_for, params.now),
        gte(jobs.available_at, params.now),
      ),
    )
    .run();
  return result.changes;
}

export function lastCompletedJob(handle: DatabaseHandle): JobRow | undefined {
  return handle.db
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'completed'))
    .orderBy(desc(jobs.finished_at))
    .limit(1)
    .get();
}

export function oldestQueuedJob(handle: DatabaseHandle): JobRow | undefined {
  return handle.db
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'queued'))
    .orderBy(asc(jobs.created_at))
    .limit(1)
    .get();
}

/** Dernier battement de cœur d'un job en cours : le worker est-il vivant ? */
export function latestHeartbeatAt(handle: DatabaseHandle): number | null {
  const row = handle.db
    .select({ heartbeatAt: jobs.heartbeat_at })
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), isNull(jobs.finished_at)))
    .orderBy(desc(jobs.heartbeat_at))
    .limit(1)
    .get();
  return row?.heartbeatAt ?? null;
}

export function countJobsWithStatus(handle: DatabaseHandle, status: JobRow['status']): number {
  const row = handle.db.select({ total: count() }).from(jobs).where(eq(jobs.status, status)).get();
  return row?.total ?? 0;
}

/** Libère le lease sans consommer de tentative : arrêt propre du worker (docs/08 §2.4). */
export function releaseJobLease(
  handle: DatabaseHandle,
  params: { jobId: string; now: number },
): boolean {
  const result = handle.db
    .update(jobs)
    .set({
      status: 'queued',
      worker_id: null,
      lease_expires_at: null,
      heartbeat_at: null,
      available_at: params.now,
      updated_at: params.now,
    })
    .where(and(eq(jobs.id, params.jobId), eq(jobs.status, 'running')))
    .run();
  return result.changes > 0;
}

/** Nombre de jobs en cours d'exécution : sert au diagnostic et à l'arrêt propre. */
export function countRunningJobs(handle: DatabaseHandle): number {
  const row = handle.db
    .select({ total: count() })
    .from(jobs)
    .where(eq(jobs.status, 'running'))
    .get();
  return row?.total ?? 0;
}
