/**
 * Temps : horodatages en `INTEGER` (millisecondes epoch), jamais en `DATETIME`
 * (docs/03 §2.2). Toutes les bornes de période passent par ici : « Toutes les
 * dates passent par une fonction unique (`nowMs()`, `toDateKey()`), jamais par
 * un `Date` local implicite » (docs/03 §17.2).
 *
 * L'horloge est un **port injecté** : un test qui dépend de la date est un test
 * faux (docs/09 §1.1).
 */

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60 * MS_PER_SECOND;
export const MS_PER_HOUR = 60 * MS_PER_MINUTE;
export const MS_PER_DAY = 24 * MS_PER_HOUR;
export const MS_PER_WEEK = 7 * MS_PER_DAY;

export interface Clock {
  nowMs(): number;
  now(): Date;
}

export function createSystemClock(): Clock {
  return {
    nowMs: () => Date.now(),
    now: () => new Date(),
  };
}

export interface ManualClock extends Clock {
  advance(ms: number): void;
  set(ms: number): void;
}

/** Horloge contrôlée par le test (ou par un scénario de rejeu). */
export function createManualClock(startMs: number): ManualClock {
  let current = startMs;
  return {
    nowMs: () => current,
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
    set: (ms) => {
      current = ms;
    },
  };
}

export interface ZonedParts {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
  hour: number; // 0–23
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone);
  if (cached) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, created);
  return created;
}

function readPart(parts: Intl.DateTimeFormatPart[], type: string): number {
  const found = parts.find((part) => part.type === type);
  return found ? Number.parseInt(found.value, 10) : 0;
}

/** Décompose un instant dans le fuseau demandé (le fuseau de l'utilisateur, docs/03 §2.2). */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = zonedFormatter(timeZone).formatToParts(new Date(ms));
  return {
    year: readPart(parts, 'year'),
    month: readPart(parts, 'month'),
    day: readPart(parts, 'day'),
    // `hour12: false` peut rendre « 24 » pour minuit selon la plateforme.
    hour: readPart(parts, 'hour') % 24,
    minute: readPart(parts, 'minute'),
    second: readPart(parts, 'second'),
  };
}

/** Décalage du fuseau (ms) à cet instant : `heure locale - heure UTC`. */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(ms / MS_PER_SECOND) * MS_PER_SECOND;
}

/** Clé de date locale `YYYY-MM-DD` — le seul format utilisé pour regrouper par jour. */
export function toDateKey(ms: number, timeZone: string): string {
  const { year, month, day } = zonedParts(ms, timeZone);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

/**
 * Début du jour local. Le calcul utilise le décalage observé à l'instant donné :
 * un passage à l'heure d'été peut décaler la borne d'une heure deux jours par an.
 * Cette limite est assumée (un plafond journalier peut être franchi d'une heure).
 */
export function startOfDayMs(ms: number, timeZone: string): number {
  const offset = zoneOffsetMs(ms, timeZone);
  return ms - ((((ms + offset) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY);
}

/** Début de la semaine ISO (lundi) dans le fuseau donné. */
export function startOfWeekMs(ms: number, timeZone: string): number {
  const dayStart = startOfDayMs(ms, timeZone);
  const weekday = weekdayIndex(ms, timeZone); // 0 = lundi
  return dayStart - weekday * MS_PER_DAY;
}

/** 0 = lundi … 6 = dimanche. */
export function weekdayIndex(ms: number, timeZone: string): number {
  const { year, month, day } = zonedParts(ms, timeZone);
  const utcNoon = Date.UTC(year, month - 1, day, 12, 0, 0);
  return (new Date(utcNoon).getUTCDay() + 6) % 7;
}

export function startOfMonthMs(ms: number, timeZone: string): number {
  const { year, month } = zonedParts(ms, timeZone);
  const guess = Date.UTC(year, month - 1, 1, 0, 0, 0);
  // Deux passes : le décalage au 1er du mois peut différer de celui d'aujourd'hui.
  return guess - zoneOffsetMs(guess - zoneOffsetMs(guess, timeZone), timeZone);
}

export type BudgetPeriodName = 'day' | 'week' | 'month';

export function periodStartMs(period: BudgetPeriodName, ms: number, timeZone: string): number {
  switch (period) {
    case 'day':
      return startOfDayMs(ms, timeZone);
    case 'week':
      return startOfWeekMs(ms, timeZone);
    case 'month':
      return startOfMonthMs(ms, timeZone);
  }
}
