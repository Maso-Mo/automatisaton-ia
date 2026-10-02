/**
 * **Sémaphore** : la contrainte de confort de docs/05 §6.4 — « un seul rendu lourd
 * à la fois ». Empêcher deux encodages simultanés garde la machine réactive
 * pendant un rendu, ce qui compte plus que de finir plus tôt.
 *
 * Il vit côté worker (et non dans `packages/media`) parce que c'est une politique
 * d'exécution, pas une propriété du média : un futur worker distant pourrait le
 * dimensionner autrement sans toucher au pipeline.
 */
export interface Semaphore {
  /** Exécute `task` quand une place est libre ; les appels s'enchaînent dans l'ordre. */
  run<T>(task: () => Promise<T>): Promise<T>;
  readonly active: number;
  readonly pending: number;
}

export function createSemaphore(limit = 1): Semaphore {
  if (limit < 1) throw new Error('Un sémaphore exige au moins une place.');
  let active = 0;
  const waiting: Array<() => void> = [];

  return {
    get active(): number {
      return active;
    },
    get pending(): number {
      return waiting.length;
    },
    async run<T>(task: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        await new Promise<void>((resolvePromise) => waiting.push(resolvePromise));
      }
      active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        waiting.shift()?.();
      }
    },
  };
}
