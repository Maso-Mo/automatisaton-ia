import { and, asc, eq, gt, lt, sql } from 'drizzle-orm';
import type { LogLevel } from '@aia/shared';
import type { DatabaseHandle } from '../client';
import { jobEvents } from '../schema';

/**
 * Journal append-only d'un job. Le champ `sequence` est **strictement croissant
 * par job** : c'est ce qui rend le flux SSE reprenable (docs/03 §14.2).
 */

export type JobEventRow = typeof jobEvents.$inferSelect;

export interface AppendJobEventInput {
  id: string;
  jobId: string;
  level: LogLevel;
  message: string;
  step?: string | null;
  dataJson?: string | null;
  progress?: number | null;
  durationMs?: number | null;
  now: number;
}

/**
 * Écrit un événement et calcule sa séquence dans la **même transaction** que
 * l'insertion : l'index unique `(job_id, sequence)` rend la double écriture
 * impossible, même si deux écritures concurrentes se présentent.
 */
export function appendJobEvent(handle: DatabaseHandle, input: AppendJobEventInput): JobEventRow {
  const run = handle.db.transaction(
    (tx) =>
      (p: AppendJobEventInput): JobEventRow => {
        const row = tx
          .select({ next: sql<number>`coalesce(max(${jobEvents.sequence}), 0) + 1` })
          .from(jobEvents)
          .where(eq(jobEvents.job_id, p.jobId))
          .get();
        const sequence = row?.next ?? 1;

        tx.insert(jobEvents)
          .values({
            id: p.id,
            job_id: p.jobId,
            sequence,
            level: p.level,
            step: p.step ?? null,
            message: p.message,
            data_json: p.dataJson ?? null,
            progress: p.progress ?? null,
            duration_ms: p.durationMs ?? null,
            created_at: p.now,
          })
          .run();

        const inserted = tx
          .select()
          .from(jobEvents)
          .where(and(eq(jobEvents.job_id, p.jobId), eq(jobEvents.sequence, sequence)))
          .get();
        if (!inserted) {
          throw new Error(`Événement introuvable après insertion (job ${p.jobId})`);
        }
        return inserted;
      },
    { behavior: 'immediate' },
  );

  return run(input);
}

export interface ListJobEventsFilter {
  jobId: string;
  /** Reprise SSE : on renvoie tout ce qui est strictement supérieur (docs/08 §5.3). */
  afterSequence?: number;
  limit?: number;
}

export function listJobEvents(handle: DatabaseHandle, filter: ListJobEventsFilter): JobEventRow[] {
  return handle.db
    .select()
    .from(jobEvents)
    .where(
      and(
        eq(jobEvents.job_id, filter.jobId),
        filter.afterSequence !== undefined
          ? gt(jobEvents.sequence, filter.afterSequence)
          : undefined,
      ),
    )
    .orderBy(asc(jobEvents.sequence))
    .limit(filter.limit ?? 200)
    .all();
}

export function latestJobEvent(handle: DatabaseHandle, jobId: string): JobEventRow | undefined {
  return handle.db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.job_id, jobId))
    .orderBy(sql`${jobEvents.sequence} desc`)
    .limit(1)
    .get();
}

export function countJobEvents(handle: DatabaseHandle, jobId: string): number {
  const row = handle.db
    .select({ total: sql<number>`count(*)` })
    .from(jobEvents)
    .where(eq(jobEvents.job_id, jobId))
    .get();
  return row?.total ?? 0;
}

/** Rétention (docs/03 §16.1) : `job_events` est la seule table purgée. */
export function purgeJobEventsBefore(handle: DatabaseHandle, ms: number): number {
  return handle.db.delete(jobEvents).where(lt(jobEvents.created_at, ms)).run().changes;
}
