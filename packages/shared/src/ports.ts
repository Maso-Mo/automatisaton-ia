/**
 * Ports transverses : horloge et générateur aléatoire **injectés**.
 *
 * « Un test qui dépend de la date, de l'aléa ou du fuseau est un test faux »
 * (docs/09 §1.1). Ces deux ports sont la seule façon d'écrire un test
 * déterministe sur le lease, le backoff et les plafonds de budget.
 */

export interface Random {
  /** Nombre dans `[0, 1)`, comme `Math.random()`. */
  next(): number;
  /** Nombre dans `[min, max]` (bornes incluses). */
  between(min: number, max: number): number;
}

export function createSystemRandom(): Random {
  return {
    next: () => Math.random(),
    between: (min, max) => min + Math.random() * (max - min),
  };
}

/**
 * Générateur déterministe (mulberry32) : même graine, même séquence. Utilisé par
 * les tests du jitter de backoff et, plus tard, par les scénarios de rejeu.
 */
export function createSeededRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (min, max) => min + next() * (max - min),
  };
}
