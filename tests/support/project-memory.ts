import { createProjectMemoryStore, type ProjectMemoryStoreImpl } from '@aia/database';
import { uuidv7, type Clock } from '@aia/shared';
import type { ProjectMemoryPorts } from '@aia/core';
import type { TestContext } from './harness';

/**
 * Câblage des ports de la mémoire de projet sur une base de test **réelle**
 * (fichier SQLite temporaire du harnais). C'est le même câblage que
 * `apps/api/src/bootstrap.ts` : un test qui n'exerce pas le chemin réel ne
 * teste rien (docs/09 §1).
 */
export interface MemoryStack extends ProjectMemoryPorts {
  store: ProjectMemoryStoreImpl;
  clock: Clock;
}

export function createMemoryStack(context: TestContext): MemoryStack {
  const store = createProjectMemoryStore(context.handle, {
    nowMs: () => context.clock.nowMs(),
  });
  return {
    store,
    clock: context.clock,
    newId: () => uuidv7(context.clock.nowMs()),
  };
}
