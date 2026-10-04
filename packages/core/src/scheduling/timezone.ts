import { ValidationError, zonedParts } from '@aia/shared';

export interface LocalDateTimeInput {
  localDate: string;
  localTime: string;
  timeZone: string;
}

export interface LocalDateTimeValue {
  localDate: string;
  localTime: string;
  timeZone: string;
  epochMs: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('fr-FR', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function parseLocal(input: LocalDateTimeInput) {
  const date = DATE_RE.exec(input.localDate);
  const time = TIME_RE.exec(input.localTime);
  if (!date || !time || !isValidTimeZone(input.timeZone)) {
    throw new ValidationError('Date, heure ou fuseau horaire invalide.', {
      code: 'CALENDAR_LOCAL_DATETIME_INVALID',
    });
  }
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  const hour = Number(time[1]);
  const minute = Number(time[2]);
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59
  ) {
    throw new ValidationError('La date ou l’heure locale n’existe pas.', {
      code: 'CALENDAR_LOCAL_DATETIME_INVALID',
    });
  }
  return { year, month, day, hour, minute };
}

function sameLocal(
  epochMs: number,
  timeZone: string,
  expected: ReturnType<typeof parseLocal>,
): boolean {
  const actual = zonedParts(epochMs, timeZone);
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute
  );
}

/**
 * Convertit une saisie locale en instant canonique. Les offsets possibles sont
 * calculés autour de la date : cela couvre les fuseaux à demi-heure et les
 * changements d'heure sans dépendre du fuseau de la machine.
 *
 * Une heure inexistante (passage à l'heure d'été) ou ambiguë (heure répétée en
 * automne) est refusée : le calendrier ne choisit jamais silencieusement entre
 * deux instants différents.
 */
export function localDateTimeToEpochMs(input: LocalDateTimeInput): number {
  const local = parseLocal(input);
  const naiveUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = naiveUtc + delta * 60 * 60 * 1_000;
    const parts = zonedParts(probe, input.timeZone);
    offsets.add(
      Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
        Math.floor(probe / 1_000) * 1_000,
    );
  }
  const matches = [...offsets]
    .map((offset) => naiveUtc - offset)
    .filter((epochMs) => sameLocal(epochMs, input.timeZone, local));
  const unique = [...new Set(matches)].sort((a, b) => a - b);
  if (unique.length === 0) {
    throw new ValidationError(
      'Cette heure locale n’existe pas dans ce fuseau (changement d’heure). Choisissez une autre heure.',
      { code: 'CALENDAR_LOCAL_TIME_GAP' },
    );
  }
  if (unique.length > 1) {
    throw new ValidationError(
      'Cette heure locale est ambiguë dans ce fuseau (changement d’heure). Choisissez une autre heure.',
      { code: 'CALENDAR_LOCAL_TIME_AMBIGUOUS' },
    );
  }
  return unique[0]!;
}

export function epochMsToLocalDateTime(epochMs: number, timeZone: string): LocalDateTimeValue {
  if (!Number.isFinite(epochMs) || !isValidTimeZone(timeZone)) {
    throw new ValidationError('Instant ou fuseau horaire invalide.', {
      code: 'CALENDAR_INSTANT_INVALID',
    });
  }
  const value = zonedParts(epochMs, timeZone);
  return {
    localDate: `${String(value.year).padStart(4, '0')}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`,
    localTime: `${String(value.hour).padStart(2, '0')}:${String(value.minute).padStart(2, '0')}`,
    timeZone,
    epochMs,
  };
}

export function addLocalDays(localDate: string, days: number): string {
  const match = DATE_RE.exec(localDate);
  if (!match) {
    throw new ValidationError('Date locale invalide.', { code: 'CALENDAR_LOCAL_DATE_INVALID' });
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${date.getUTCFullYear().toString().padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
