import { MS_PER_MINUTE, type Random } from '@aia/shared';

/**
 * Backoff exponentiel des jobs réessayables (docs/02 §9.3) : 30 s, 2 min, 8 min,
 * 32 min — soit un facteur 4 par tentative.
 *
 * Le **jitter** (±20 % par défaut) est indispensable dès qu'il y a plus d'un
 * job : sans lui, tous les jobs échoués au même instant repartent au même
 * instant, et la reprise se transforme en rafale.
 */

export interface BackoffOptions {
  baseMs?: number;
  factor?: number;
  maxMs?: number;
  /** Proportion d'aléa appliquée à la valeur théorique (0,2 = ±20 %). */
  jitterRatio?: number;
}

export const DEFAULT_BACKOFF: Required<BackoffOptions> = {
  baseMs: 30_000,
  factor: 4,
  maxMs: 32 * MS_PER_MINUTE,
  jitterRatio: 0.2,
};

export type BackoffFn = (attempt: number) => number;

/**
 * Construit la fonction de backoff d'un type de job.
 * `attempt` est le numéro de la tentative qui vient d'échouer (1 pour la première).
 */
export function createBackoff(options: BackoffOptions = {}, random: Random): BackoffFn {
  const { baseMs, factor, maxMs, jitterRatio } = { ...DEFAULT_BACKOFF, ...options };

  return (attempt: number): number => {
    const safeAttempt = Math.max(1, Math.floor(attempt));
    const theoretical = Math.min(baseMs * factor ** (safeAttempt - 1), maxMs);
    if (jitterRatio <= 0) return Math.round(theoretical);
    const spread = theoretical * jitterRatio;
    return Math.round(random.between(theoretical - spread, theoretical + spread));
  };
}

/** Valeurs théoriques, sans jitter : ce que la documentation promet. */
export function theoreticalBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const { baseMs, factor, maxMs } = { ...DEFAULT_BACKOFF, ...options };
  return Math.min(baseMs * factor ** (Math.max(1, Math.floor(attempt)) - 1), maxMs);
}
