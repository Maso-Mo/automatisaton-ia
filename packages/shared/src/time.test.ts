import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  createManualClock,
  periodStartMs,
  startOfDayMs,
  startOfMonthMs,
  startOfWeekMs,
  toDateKey,
  weekdayIndex,
  zonedParts,
} from './time';

// 2026-03-10T15:45:00Z — un mardi, en hiver pour l'Europe, en heure d'été pour Paris ? non : hiver.
const TUESDAY = Date.UTC(2026, 2, 10, 15, 45, 0);

describe('temps (docs/03 §2.2, §17.2)', () => {
  it('décompose un instant dans le fuseau demandé', () => {
    expect(zonedParts(TUESDAY, 'UTC')).toEqual({
      year: 2026,
      month: 3,
      day: 10,
      hour: 15,
      minute: 45,
      second: 0,
    });
    // Paris est UTC+1 en mars (avant le dernier dimanche de mars).
    expect(zonedParts(TUESDAY, 'Europe/Paris').hour).toBe(16);
    expect(toDateKey(TUESDAY, 'Europe/Paris')).toBe('2026-03-10');
  });

  it('calcule la clé de date locale, jamais la date UTC', () => {
    // 23 h 30 UTC le 9 mars = 00 h 30 le 10 mars à Paris → deux jours différents.
    const late = Date.UTC(2026, 2, 9, 23, 30, 0);
    expect(toDateKey(late, 'UTC')).toBe('2026-03-09');
    expect(toDateKey(late, 'Europe/Paris')).toBe('2026-03-10');
  });

  it('trouve le début du jour et de la semaine ISO (lundi)', () => {
    const dayStart = startOfDayMs(TUESDAY, 'UTC');
    expect(new Date(dayStart).toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(weekdayIndex(TUESDAY, 'UTC')).toBe(1);
    const weekStart = startOfWeekMs(TUESDAY, 'UTC');
    expect(new Date(weekStart).toISOString()).toBe('2026-03-09T00:00:00.000Z');
  });

  it('résout le début du mois et les bornes de période budgétaire', () => {
    expect(new Date(startOfMonthMs(TUESDAY, 'UTC')).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(periodStartMs('month', TUESDAY, 'UTC')).toBe(startOfMonthMs(TUESDAY, 'UTC'));
    expect(periodStartMs('week', TUESDAY, 'UTC')).toBe(startOfWeekMs(TUESDAY, 'UTC'));
    expect(periodStartMs('day', TUESDAY, 'UTC')).toBe(startOfDayMs(TUESDAY, 'UTC'));
  });

  it('garde le décalage du fuseau sur le début de journée de Paris', () => {
    const parisDayStart = startOfDayMs(TUESDAY, 'Europe/Paris');
    expect(new Date(parisDayStart).toISOString()).toBe('2026-03-09T23:00:00.000Z');
  });

  it('injecte l’horloge : un test ne dépend jamais de la date du jour', () => {
    const clock = createManualClock(TUESDAY);
    expect(clock.nowMs()).toBe(TUESDAY);
    clock.advance(MS_PER_DAY);
    expect(clock.nowMs()).toBe(TUESDAY + MS_PER_DAY);
    clock.set(TUESDAY);
    expect(clock.now().getTime()).toBe(TUESDAY);
  });
});
