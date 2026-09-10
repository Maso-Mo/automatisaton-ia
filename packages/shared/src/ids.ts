import { randomBytes } from 'node:crypto';

/**
 * Identifiants : UUID v7 en `TEXT`, généré côté application, jamais par la base
 * (docs/03 §2.1).
 *
 * v7 plutôt que v4 : l'horodatage occupe les 48 premiers bits, donc les
 * identifiants sont **triés par date de création**. Les insertions restent
 * séquentielles et les index ne se fragmentent pas — ce qui compte sur SQLite.
 */

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MAX_UUID_MS = 2 ** 48 - 1;

/** Génère un UUID v7. `nowMs` est injectable pour rendre les tests déterministes. */
export function uuidv7(nowMs: number = Date.now()): string {
  const ts = Math.floor(nowMs);
  if (!Number.isFinite(ts) || ts < 0 || ts > MAX_UUID_MS) {
    throw new RangeError(`Horodatage hors plage pour un UUID v7 : ${String(nowMs)}`);
  }

  const time = ts.toString(16).padStart(12, '0');
  const rand = randomBytes(10).toString('hex');

  const version = '7';
  const variant = ((Number.parseInt(rand.slice(0, 1), 16) & 0b0011) | 0b1000).toString(16);

  return [
    time.slice(0, 8),
    time.slice(8, 12),
    `${version}${rand.slice(0, 3)}`,
    `${variant}${rand.slice(3, 6)}`,
    rand.slice(6, 18),
  ].join('-');
}

export function isUuidV7(value: string): boolean {
  return UUID_V7_RE.test(value);
}

/** Extrait l'horodatage (ms epoch) encodé dans un UUID v7. */
export function uuidv7Timestamp(value: string): number {
  if (!isUuidV7(value)) {
    throw new TypeError(`Identifiant UUID v7 invalide : ${value}`);
  }
  return Number.parseInt(value.replace(/-/g, '').slice(0, 12), 16);
}
