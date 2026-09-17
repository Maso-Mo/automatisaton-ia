import type { JobDefinition, JobSpec, RegisteredJob } from './types';

/**
 * Registre des types de jobs connus d'un processus. Un type non enregistré ne
 * peut pas être réservé : la file refuse l'`enqueue` plutôt que de créer un job
 * que personne ne saura exécuter.
 *
 * Deux façons d'enregistrer, et la différence est structurelle :
 *
 * - `register(definition)` — un **worker** : la spécification *et* le handler ;
 * - `registerSpec(spec)` — un **producteur** (l'API) : la spécification seule,
 *   parce qu'il enfile sans exécuter (docs/02 §3, docs/05 §4.3).
 */

export interface JobRegistry {
  register<TInput, TOutput>(definition: JobDefinition<TInput, TOutput>): void;
  /** Enregistre un type **sans** handler : le job peut être enfilé, pas exécuté. */
  registerSpec<TInput>(spec: JobSpec<TInput>): void;
  get(type: string): RegisteredJob | undefined;
  has(type: string): boolean;
  types(): string[];
}

export function createJobRegistry(): JobRegistry {
  const map = new Map<string, RegisteredJob>();

  const store = <TInput>(spec: JobSpec<TInput>, handler?: RegisteredJob['handler']): void => {
    if (map.has(spec.type)) {
      throw new Error(`Type de job déjà enregistré : ${spec.type}`);
    }
    map.set(spec.type, {
      ...(spec as JobSpec<unknown>),
      ...(handler ? { handler } : {}),
    });
  };

  return {
    register<TInput, TOutput>(definition: JobDefinition<TInput, TOutput>): void {
      const { handler, ...spec } = definition;
      store(spec, handler as unknown as RegisteredJob['handler']);
    },
    registerSpec<TInput>(spec: JobSpec<TInput>): void {
      store(spec);
    },
    get: (type) => map.get(type),
    has: (type) => map.has(type),
    types: () => [...map.keys()].sort(),
  };
}
