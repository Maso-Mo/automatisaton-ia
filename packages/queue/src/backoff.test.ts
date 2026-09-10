import { MS_PER_MINUTE, createSeededRandom } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { createBackoff, theoreticalBackoffMs } from './backoff';

describe('backoff des jobs réessayables (docs/02 §9.3)', () => {
  it('suit la progression annoncée : 30 s, 2 min, 8 min, 32 min', () => {
    expect(theoreticalBackoffMs(1)).toBe(30_000);
    expect(theoreticalBackoffMs(2)).toBe(2 * MS_PER_MINUTE);
    expect(theoreticalBackoffMs(3)).toBe(8 * MS_PER_MINUTE);
    expect(theoreticalBackoffMs(4)).toBe(32 * MS_PER_MINUTE);
  });

  it('plafonne au maximum au lieu de croître indéfiniment', () => {
    expect(theoreticalBackoffMs(9)).toBe(32 * MS_PER_MINUTE);
    expect(theoreticalBackoffMs(50)).toBe(32 * MS_PER_MINUTE);
  });

  it('applique un jitter de ±20 % avec un générateur déterministe', () => {
    const random = createSeededRandom(42);
    const backoff = createBackoff({}, random);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const theoretical = theoreticalBackoffMs(attempt);
      for (let i = 0; i < 100; i += 1) {
        const value = backoff(attempt);
        expect(value).toBeGreaterThanOrEqual(Math.floor(theoretical * 0.8));
        expect(value).toBeLessThanOrEqual(Math.ceil(theoretical * 1.2));
      }
    }
  });

  it('est reproductible : même graine, même séquence', () => {
    const first = createBackoff({}, createSeededRandom(7));
    const second = createBackoff({}, createSeededRandom(7));
    expect([1, 2, 3].map((attempt) => first(attempt))).toEqual(
      [1, 2, 3].map((attempt) => second(attempt)),
    );
  });

  it('peut être rendu sans jitter pour un test lisible', () => {
    const backoff = createBackoff({ jitterRatio: 0 }, createSeededRandom(1));
    expect(backoff(2)).toBe(2 * MS_PER_MINUTE);
  });

  it('traite l’entrée 0 ou négative comme la première tentative', () => {
    expect(theoreticalBackoffMs(0)).toBe(30_000);
    expect(theoreticalBackoffMs(-3)).toBe(30_000);
  });
});
