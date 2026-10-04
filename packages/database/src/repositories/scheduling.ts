import { and, asc, count, desc, eq, gte, inArray, lt, lte, ne, sql } from 'drizzle-orm';
import { uuidv7, type PlatformId } from '@aia/shared';
import type { DatabaseHandle } from '../client';
import {
  appSettings,
  calendarChangeProposals,
  calendarSlots,
  contentItems,
  jobs,
  publications,
} from '../schema';

export type CalendarRigidityRecord = 'LOCKED' | 'FLEXIBLE' | 'EVERGREEN';
export type CalendarSlotStatusRecord =
  | 'draft'
  | 'scheduled'
  | 'due'
  | 'publishing'
  | 'published'
  | 'manual_required'
  | 'cancelled'
  | 'missed'
  | 'failed';
export type CalendarProposalStatusRecord = 'pending' | 'accepted' | 'rejected';

export interface CalendarSlotRecord {
  id: string;
  projectId: string;
  contentItemId: string;
  contentVersionId: string;
  platformAccountId: string;
  platform: PlatformId;
  scheduledFor: number;
  timezone: string;
  rigidity: CalendarRigidityRecord;
  status: CalendarSlotStatusRecord;
  publicationId: string | null;
  jobId: string | null;
  missedReason: string | null;
  cancelledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CalendarChangeProposalRecord {
  id: string;
  calendarSlotId: string;
  proposedScheduledFor: number | null;
  proposedTimezone: string | null;
  proposedRigidity: CalendarRigidityRecord | null;
  reason: string;
  status: CalendarProposalStatusRecord;
  proposedAt: number;
  resolvedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function toSlot(row: typeof calendarSlots.$inferSelect): CalendarSlotRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    contentItemId: row.content_item_id,
    contentVersionId: row.content_version_id,
    platformAccountId: row.platform_account_id,
    platform: row.platform as PlatformId,
    scheduledFor: row.scheduled_for,
    timezone: row.timezone,
    rigidity: row.rigidity as CalendarRigidityRecord,
    status: row.status as CalendarSlotStatusRecord,
    publicationId: row.publication_id,
    jobId: row.job_id,
    missedReason: row.missed_reason,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProposal(
  row: typeof calendarChangeProposals.$inferSelect,
): CalendarChangeProposalRecord {
  return {
    id: row.id,
    calendarSlotId: row.calendar_slot_id,
    proposedScheduledFor: row.proposed_scheduled_for,
    proposedTimezone: row.proposed_timezone,
    proposedRigidity: row.proposed_rigidity as CalendarRigidityRecord | null,
    reason: row.reason,
    status: row.status as CalendarProposalStatusRecord,
    proposedAt: row.proposed_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createSchedulingStore(handle: DatabaseHandle, nowMs: () => number) {
  const touchRevision = (): void => {
    const now = nowMs();
    handle.db
      .insert(appSettings)
      .values({
        key: 'calendar.revision',
        value_json: '1',
        value_type: 'number',
        updated_at: now,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value_json: sql`cast(cast(${appSettings.value_json} as integer) + 1 as text)`,
          value_type: 'number',
          updated_at: now,
        },
      })
      .run();
  };
  const slot = (id: string): CalendarSlotRecord | null => {
    const row = handle.db.select().from(calendarSlots).where(eq(calendarSlots.id, id)).get();
    return row ? toSlot(row) : null;
  };
  const proposal = (id: string): CalendarChangeProposalRecord | null => {
    const row = handle.db
      .select()
      .from(calendarChangeProposals)
      .where(eq(calendarChangeProposals.id, id))
      .get();
    return row ? toProposal(row) : null;
  };

  return {
    getSlot: slot,
    getByPublication(publicationId: string): CalendarSlotRecord | null {
      const row = handle.db
        .select()
        .from(calendarSlots)
        .where(eq(calendarSlots.publication_id, publicationId))
        .get();
      return row ? toSlot(row) : null;
    },
    findActiveForVersionAccount(
      contentVersionId: string,
      platformAccountId: string,
    ): CalendarSlotRecord | null {
      const row = handle.db
        .select()
        .from(calendarSlots)
        .where(
          and(
            eq(calendarSlots.content_version_id, contentVersionId),
            eq(calendarSlots.platform_account_id, platformAccountId),
            inArray(calendarSlots.status, ['draft', 'scheduled', 'due', 'publishing']),
          ),
        )
        .get();
      return row ? toSlot(row) : null;
    },
    createSlot(input: {
      projectId: string;
      contentItemId: string;
      contentVersionId: string;
      platformAccountId: string;
      platform: PlatformId;
      scheduledFor: number;
      timezone: string;
      rigidity: CalendarRigidityRecord;
      publicationId: string;
      jobId: string;
    }): CalendarSlotRecord {
      const now = nowMs();
      const id = uuidv7(now);
      handle.db
        .insert(calendarSlots)
        .values({
          id,
          project_id: input.projectId,
          content_item_id: input.contentItemId,
          content_version_id: input.contentVersionId,
          platform_account_id: input.platformAccountId,
          platform: input.platform,
          scheduled_for: input.scheduledFor,
          timezone: input.timezone,
          rigidity: input.rigidity,
          status: 'scheduled',
          publication_id: input.publicationId,
          job_id: input.jobId,
          created_at: now,
          updated_at: now,
        })
        .run();
      handle.db
        .update(contentItems)
        .set({ scheduled_for: input.scheduledFor, updated_at: now })
        .where(eq(contentItems.id, input.contentItemId))
        .run();
      touchRevision();
      return slot(id)!;
    },
    list(input: {
      from: number;
      to: number;
      projectId?: string;
      includeCancelled?: boolean;
    }): CalendarSlotRecord[] {
      const conditions = [
        gte(calendarSlots.scheduled_for, input.from),
        lt(calendarSlots.scheduled_for, input.to),
      ];
      if (input.projectId) conditions.push(eq(calendarSlots.project_id, input.projectId));
      if (!input.includeCancelled) conditions.push(ne(calendarSlots.status, 'cancelled'));
      return handle.db
        .select()
        .from(calendarSlots)
        .where(and(...conditions))
        .orderBy(asc(calendarSlots.scheduled_for), asc(calendarSlots.created_at))
        .all()
        .map(toSlot);
    },
    listAllActive(): CalendarSlotRecord[] {
      return handle.db
        .select()
        .from(calendarSlots)
        .where(inArray(calendarSlots.status, ['scheduled', 'due', 'publishing']))
        .orderBy(asc(calendarSlots.scheduled_for))
        .all()
        .map(toSlot);
    },
    updateSchedule(
      id: string,
      input: { scheduledFor: number; timezone: string; rigidity?: CalendarRigidityRecord },
    ): CalendarSlotRecord | null {
      const current = slot(id);
      if (!current || !['scheduled', 'due', 'missed'].includes(current.status)) return null;
      const now = nowMs();
      handle.db
        .update(calendarSlots)
        .set({
          scheduled_for: input.scheduledFor,
          timezone: input.timezone,
          ...(input.rigidity ? { rigidity: input.rigidity } : {}),
          status: 'scheduled',
          missed_reason: null,
          updated_at: now,
        })
        .where(eq(calendarSlots.id, id))
        .run();
      if (current.jobId) {
        handle.db
          .update(jobs)
          .set({
            status: 'queued',
            scheduled_for: input.scheduledFor,
            available_at: input.scheduledFor,
            finished_at: null,
            error_json: null,
            updated_at: now,
          })
          .where(and(eq(jobs.id, current.jobId), inArray(jobs.status, ['queued', 'cancelled'])))
          .run();
      }
      if (current.publicationId) {
        handle.db
          .update(publications)
          .set({ status: 'planned', scheduled_for: input.scheduledFor, updated_at: now })
          .where(eq(publications.id, current.publicationId))
          .run();
      }
      handle.db
        .update(contentItems)
        .set({ scheduled_for: input.scheduledFor, updated_at: now })
        .where(eq(contentItems.id, current.contentItemId))
        .run();
      touchRevision();
      return slot(id);
    },
    setRigidity(id: string, rigidity: CalendarRigidityRecord): CalendarSlotRecord | null {
      const now = nowMs();
      const changed = handle.db
        .update(calendarSlots)
        .set({ rigidity, updated_at: now })
        .where(and(eq(calendarSlots.id, id), inArray(calendarSlots.status, ['scheduled', 'due'])))
        .run();
      if (changed.changes > 0) touchRevision();
      return changed.changes > 0 ? slot(id) : null;
    },
    cancel(id: string, reason: string): CalendarSlotRecord | null {
      const current = slot(id);
      if (!current || !['scheduled', 'due', 'missed'].includes(current.status)) return null;
      const now = nowMs();
      handle.db
        .update(calendarSlots)
        .set({ status: 'cancelled', cancelled_at: now, missed_reason: reason, updated_at: now })
        .where(eq(calendarSlots.id, id))
        .run();
      if (current.jobId) {
        handle.db
          .update(jobs)
          .set({
            status: 'cancelled',
            error_json: JSON.stringify({ category: 'cancelled', message: reason }),
            finished_at: now,
            updated_at: now,
          })
          .where(and(eq(jobs.id, current.jobId), eq(jobs.status, 'queued')))
          .run();
      }
      if (current.publicationId) {
        handle.db
          .update(publications)
          .set({ status: 'cancelled', decision_note: reason, updated_at: now })
          .where(
            and(
              eq(publications.id, current.publicationId),
              inArray(publications.status, ['planned', 'queued']),
            ),
          )
          .run();
      }
      handle.db
        .update(contentItems)
        .set({ scheduled_for: null, updated_at: now })
        .where(eq(contentItems.id, current.contentItemId))
        .run();
      touchRevision();
      return slot(id);
    },
    publishNow(id: string): CalendarSlotRecord | null {
      const current = slot(id);
      if (!current || !['scheduled', 'due', 'missed'].includes(current.status)) return null;
      const now = nowMs();
      handle.db
        .update(calendarSlots)
        .set({ status: 'due', scheduled_for: now, missed_reason: null, updated_at: now })
        .where(eq(calendarSlots.id, id))
        .run();
      if (current.jobId) {
        handle.db
          .update(jobs)
          .set({
            status: 'queued',
            scheduled_for: now,
            available_at: now,
            finished_at: null,
            error_json: null,
            updated_at: now,
          })
          .where(and(eq(jobs.id, current.jobId), inArray(jobs.status, ['queued', 'cancelled'])))
          .run();
      }
      if (current.publicationId) {
        handle.db
          .update(publications)
          .set({ status: 'planned', scheduled_for: null, updated_at: now })
          .where(eq(publications.id, current.publicationId))
          .run();
      }
      touchRevision();
      return slot(id);
    },
    setStatusByPublication(
      publicationId: string,
      status: CalendarSlotStatusRecord,
      reason?: string | null,
    ): CalendarSlotRecord | null {
      const now = nowMs();
      const changed = handle.db
        .update(calendarSlots)
        .set({ status, missed_reason: reason ?? null, updated_at: now })
        .where(eq(calendarSlots.publication_id, publicationId))
        .run();
      if (changed.changes > 0) touchRevision();
      return this.getByPublication(publicationId);
    },
    rescheduleByPublication(
      publicationId: string,
      scheduledFor: number,
      reason: string,
      jobId?: string,
    ): CalendarSlotRecord | null {
      const current = this.getByPublication(publicationId);
      if (!current) return null;
      const now = nowMs();
      handle.db
        .update(calendarSlots)
        .set({
          status: 'scheduled',
          scheduled_for: scheduledFor,
          ...(jobId ? { job_id: jobId } : {}),
          missed_reason: reason,
          updated_at: now,
        })
        .where(eq(calendarSlots.id, current.id))
        .run();
      touchRevision();
      return slot(current.id);
    },
    promoteDue(now: number, lateToleranceMs: number): { due: string[]; missed: string[] } {
      const candidates = handle.db
        .select()
        .from(calendarSlots)
        .where(and(eq(calendarSlots.status, 'scheduled'), lte(calendarSlots.scheduled_for, now)))
        .orderBy(asc(calendarSlots.scheduled_for))
        .all();
      const due: string[] = [];
      const missed: string[] = [];
      handle.db.transaction(
        (tx) => {
          for (const row of candidates) {
            const lateBy = now - row.scheduled_for;
            if (lateBy <= lateToleranceMs) {
              tx.update(calendarSlots)
                .set({ status: 'due', updated_at: now })
                .where(and(eq(calendarSlots.id, row.id), eq(calendarSlots.status, 'scheduled')))
                .run();
              due.push(row.id);
              continue;
            }
            const reason = `Créneau dépassé de ${Math.ceil(lateBy / 60_000)} min : publication manuelle requise.`;
            tx.update(calendarSlots)
              .set({ status: 'missed', missed_reason: reason, updated_at: now })
              .where(and(eq(calendarSlots.id, row.id), eq(calendarSlots.status, 'scheduled')))
              .run();
            if (row.job_id) {
              tx.update(jobs)
                .set({
                  status: 'cancelled',
                  error_json: JSON.stringify({ category: 'missed', message: reason }),
                  finished_at: now,
                  updated_at: now,
                })
                .where(and(eq(jobs.id, row.job_id), eq(jobs.status, 'queued')))
                .run();
            }
            missed.push(row.id);
          }
        },
        { behavior: 'immediate' },
      );
      if (due.length > 0 || missed.length > 0) touchRevision();
      return { due, missed };
    },
    createProposal(input: {
      calendarSlotId: string;
      proposedScheduledFor?: number | null;
      proposedTimezone?: string | null;
      proposedRigidity?: CalendarRigidityRecord | null;
      reason: string;
    }): CalendarChangeProposalRecord {
      const now = nowMs();
      const id = uuidv7(now);
      handle.db
        .insert(calendarChangeProposals)
        .values({
          id,
          calendar_slot_id: input.calendarSlotId,
          proposed_scheduled_for: input.proposedScheduledFor ?? null,
          proposed_timezone: input.proposedTimezone ?? null,
          proposed_rigidity: input.proposedRigidity ?? null,
          reason: input.reason,
          status: 'pending',
          proposed_at: now,
          created_at: now,
          updated_at: now,
        })
        .run();
      touchRevision();
      return proposal(id)!;
    },
    listProposals(calendarSlotId?: string): CalendarChangeProposalRecord[] {
      const rows = calendarSlotId
        ? handle.db
            .select()
            .from(calendarChangeProposals)
            .where(eq(calendarChangeProposals.calendar_slot_id, calendarSlotId))
            .orderBy(desc(calendarChangeProposals.created_at))
            .all()
        : handle.db
            .select()
            .from(calendarChangeProposals)
            .orderBy(desc(calendarChangeProposals.created_at))
            .all();
      return rows.map(toProposal);
    },
    resolveProposal(
      id: string,
      decision: 'accepted' | 'rejected',
    ): CalendarChangeProposalRecord | null {
      const current = proposal(id);
      if (!current || current.status !== 'pending') return null;
      const now = nowMs();
      handle.db
        .update(calendarChangeProposals)
        .set({ status: decision, resolved_at: now, updated_at: now })
        .where(
          and(eq(calendarChangeProposals.id, id), eq(calendarChangeProposals.status, 'pending')),
        )
        .run();
      if (decision === 'accepted') {
        const currentSlot = slot(current.calendarSlotId);
        if (currentSlot) {
          this.updateSchedule(currentSlot.id, {
            scheduledFor: current.proposedScheduledFor ?? currentSlot.scheduledFor,
            timezone: current.proposedTimezone ?? currentSlot.timezone,
            rigidity: current.proposedRigidity ?? currentSlot.rigidity,
          });
        }
      }
      touchRevision();
      return proposal(id);
    },
    countByPlatformDay(platform: string, from: number, to: number): number {
      const row = handle.db
        .select({ total: count() })
        .from(calendarSlots)
        .where(
          and(
            eq(calendarSlots.platform, platform),
            gte(calendarSlots.scheduled_for, from),
            lt(calendarSlots.scheduled_for, to),
            inArray(calendarSlots.status, ['scheduled', 'due', 'publishing', 'published']),
          ),
        )
        .get();
      return row?.total ?? 0;
    },
    latestUpdatedAt(): number {
      const row = handle.db
        .select({ value: appSettings.value_json })
        .from(appSettings)
        .where(eq(appSettings.key, 'calendar.revision'))
        .get();
      return Number(row?.value ?? 0);
    },
  };
}
