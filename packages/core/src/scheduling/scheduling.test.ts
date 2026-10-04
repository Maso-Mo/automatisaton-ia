import { describe, expect, it } from 'vitest';
import {
  cadenceWarning,
  canProposeAutomaticMove,
  detectCalendarConflicts,
  epochMsToLocalDateTime,
  localDateTimeToEpochMs,
} from '.';

describe('calendrier : fuseaux, conflits et rigidité', () => {
  it('convertit une saisie Europe/Paris en instant canonique puis la restitue', () => {
    const epochMs = localDateTimeToEpochMs({
      localDate: '2026-10-05',
      localTime: '10:00',
      timeZone: 'Europe/Paris',
    });
    expect(new Date(epochMs).toISOString()).toBe('2026-10-05T08:00:00.000Z');
    expect(epochMsToLocalDateTime(epochMs, 'Europe/Paris')).toMatchObject({
      localDate: '2026-10-05',
      localTime: '10:00',
    });
  });

  it('gère un fuseau à demi-heure sans hypothèse sur Madagascar', () => {
    const epochMs = localDateTimeToEpochMs({
      localDate: '2026-01-12',
      localTime: '09:15',
      timeZone: 'Asia/Kolkata',
    });
    expect(new Date(epochMs).toISOString()).toBe('2026-01-12T03:45:00.000Z');
  });

  it('refuse les heures inexistantes et ambiguës aux changements d’heure', () => {
    expect(() =>
      localDateTimeToEpochMs({
        localDate: '2026-03-29',
        localTime: '02:30',
        timeZone: 'Europe/Paris',
      }),
    ).toThrow(/n’existe pas/);
    expect(() =>
      localDateTimeToEpochMs({
        localDate: '2026-10-25',
        localTime: '02:30',
        timeZone: 'Europe/Paris',
      }),
    ).toThrow(/ambiguë/);
  });

  it('signale une proximité de compte sans bloquer la décision humaine', () => {
    const conflicts = detectCalendarConflicts(
      { platformAccountId: 'a1', scheduledFor: 1_000_000 },
      [
        {
          id: 's1',
          platformAccountId: 'a1',
          platform: 'linkedin',
          scheduledFor: 1_000_000 + 20 * 60_000,
          rigidity: 'FLEXIBLE',
          status: 'scheduled',
        },
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.kind).toBe('account_proximity');
  });

  it('ne propose jamais de déplacer LOCKED et avertit sur la cadence', () => {
    expect(canProposeAutomaticMove('LOCKED')).toBe(false);
    expect(canProposeAutomaticMove('FLEXIBLE')).toBe(true);
    expect(canProposeAutomaticMove('EVERGREEN')).toBe(true);
    expect(
      cadenceWarning({ platform: 'linkedin', countForLocalDay: 3, recommendedPerDay: 1 }),
    ).toContain('3 publications');
  });
});
