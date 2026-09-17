import { buildMemoryPack, type MemoryPack } from '@aia/ai';
import { writerMemorySource, type ProjectMemoryPorts } from '@aia/core';

/**
 * Le **paquet de mémoire** d'un projet, construit de la même façon pour tous les
 * agents (docs/04 §5.2).
 *
 * Ce fichier est une **jointure**, pas une règle : la sélection (quels faits, quel
 * public, quelle voix) appartient au domaine et vit dans
 * `@aia/core` → `writerMemorySource`. Ici, on se contente de passer du domaine à
 * l'agent : c'est exactement ce que fait une application, et c'est ce qui évite
 * que le domaine ne dépende du paquet qui parle aux fournisseurs (docs/02 §5).
 *
 * Le worker de rédaction appelle la même fonction de domaine, puis `buildMemoryPack` :
 * l'entretien, le plan et le rédacteur voient donc **la même** matière.
 */
export interface MemoryPackDeps {
  memory: ProjectMemoryPorts;
}

export function projectMemoryPack(deps: MemoryPackDeps, projectId: string): MemoryPack {
  return buildMemoryPack(writerMemorySource(deps.memory, projectId));
}
