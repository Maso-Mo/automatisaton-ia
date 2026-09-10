import type { JobDefinition } from './types';

/**
 * Registre des types de jobs connus du worker. Un type non enregistré ne peut
 * pas être réservé : la file refuse l'`enqueue` plutôt que de créer un job que
 * personne ne saura exécuter.
 */

export type AnyJobDefinition = JobDefinition<unknown, unknown>;

export interface JobRegistry {
  register<TInput, TOutput>(definition: JobDefinition<TInput, TOutput>): void;
  get(type: string): AnyJobDefinition | undefined;
  has(type: string): boolean;
  types(): string[];
}

export function createJobRegistry(): JobRegistry {
  const map = new Map<string, AnyJobDefinition>();

  return {
    register<TInput, TOutput>(definition: JobDefinition<TInput, TOutput>): void {
      if (map.has(definition.type)) {
        throw new Error(`Type de job déjà enregistré : ${definition.type}`);
      }
      map.set(definition.type, definition as unknown as AnyJobDefinition);
    },
    get: (type) => map.get(type),
    has: (type) => map.has(type),
    types: () => [...map.keys()].sort(),
  };
}
