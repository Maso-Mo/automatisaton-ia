import { MS_PER_DAY, MS_PER_MINUTE } from '@aia/shared';
import { addLocalDays, epochMsToLocalDateTime, localDateTimeToEpochMs } from './timezone';

export const CALENDAR_RIGIDITIES = ['LOCKED', 'FLEXIBLE', 'EVERGREEN'] as const;
export type CalendarRigidity = (typeof CALENDAR_RIGIDITIES)[number];

export const CALENDAR_SLOT_STATUSES = [
  'draft',
  'scheduled',
  'due',
  'publishing',
  'published',
  'manual_required',
  'cancelled',
  'missed',
  'failed',
] as const;
export type CalendarSlotStatus = (typeof CALENDAR_SLOT_STATUSES)[number];

export const CALENDAR_PROPOSAL_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type CalendarProposalStatus = (typeof CALENDAR_PROPOSAL_STATUSES)[number];

export const CALENDAR_CONFLICT_WINDOW_MS = 30 * MS_PER_MINUTE;
export const CALENDAR_LATE_TOLERANCE_MS = 15 * MS_PER_MINUTE;

export interface SchedulableSlot {
  id: string;
  platformAccountId: string;
  platform: string;
  scheduledFor: number;
  rigidity: CalendarRigidity;
  status: CalendarSlotStatus;
}

export interface CalendarConflict {
  kind: 'account_proximity' | 'simultaneous';
  slotId: string;
  message: string;
}

export function detectCalendarConflicts(
  candidate: Pick<SchedulableSlot, 'platformAccountId' | 'scheduledFor'>,
  slots: readonly SchedulableSlot[],
  excludeSlotId?: string,
): CalendarConflict[] {
  const active = new Set<CalendarSlotStatus>(['scheduled', 'due', 'publishing']);
  return slots
    .filter(
      (slot) =>
        slot.id !== excludeSlotId &&
        active.has(slot.status) &&
        Math.abs(slot.scheduledFor - candidate.scheduledFor) < CALENDAR_CONFLICT_WINDOW_MS,
    )
    .map((slot) => ({
      kind:
        slot.platformAccountId === candidate.platformAccountId
          ? 'account_proximity'
          : 'simultaneous',
      slotId: slot.id,
      message:
        slot.platformAccountId === candidate.platformAccountId
          ? 'Deux publications du même compte sont prévues à moins de 30 minutes.'
          : 'Plusieurs publications sont prévues au même moment.',
    }));
}

export function canProposeAutomaticMove(rigidity: CalendarRigidity): boolean {
  return rigidity === 'FLEXIBLE' || rigidity === 'EVERGREEN';
}

export function assertProposalAllowed(rigidity: CalendarRigidity): void {
  if (!canProposeAutomaticMove(rigidity)) {
    throw new Error('Un créneau LOCKED ne peut pas faire l’objet d’un déplacement automatique.');
  }
}

export function cadenceWarning(input: {
  platform: string;
  countForLocalDay: number;
  recommendedPerDay: number;
}): string | null {
  return input.countForLocalDay > input.recommendedPerDay
    ? `${input.countForLocalDay} publications ${input.platform} sont prévues ce jour (recommandation : ${input.recommendedPerDay}/jour).`
    : null;
}

export function calendarRange(
  nowMs: number,
  timeZone: string,
  view: 'today' | 'tomorrow' | 'week',
): { from: number; to: number } {
  const today = epochMsToLocalDateTime(nowMs, timeZone).localDate;
  let first = today;
  let days = 1;
  if (view === 'tomorrow') first = addLocalDays(today, 1);
  if (view === 'week') {
    // Horizon glissant : « demain » reste visible même un dimanche, ce qui est
    // indispensable pour réellement préparer les sept prochains jours.
    first = today;
    days = 7;
  }
  const from = localDateTimeToEpochMs({ localDate: first, localTime: '00:00', timeZone });
  const after = addLocalDays(first, days);
  const to = localDateTimeToEpochMs({ localDate: after, localTime: '00:00', timeZone });
  return { from, to };
}

/** Valeur suffisamment large pour les recherches globales sans utiliser Infinity en SQL. */
export const CALENDAR_QUERY_HORIZON_MS = 365 * MS_PER_DAY;
