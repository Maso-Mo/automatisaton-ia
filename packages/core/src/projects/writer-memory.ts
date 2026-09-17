import { NotFoundError } from '@aia/shared';
import { getProjectContext } from './service';
import type { AudienceProfile, StyleProfile } from './profiles';
import type { ProjectSkillFact } from './skills';
import type { Project, ProjectFact, ProjectMemoryPorts } from './types';

/**
 * La **matière d'un rédacteur** : tout ce qu'un agent a le droit de dire d'un
 * projet, rassemblé en un objet (docs/04 §5.2).
 *
 * Pourquoi cette fonction vit-elle dans le domaine plutôt que dans chaque
 * application ? Parce que l'entretien, le plan éditorial et la rédaction doivent
 * voir **exactement la même mémoire**. L'API assemble ce paquet pour l'entretien
 * et le plan, le worker l'assemble pour la rédaction : deux implémentations
 * produiraient deux vérités — un fait « connu » côté plan et ignoré côté texte —
 * et personne ne saurait laquelle a produit le contenu publié.
 *
 * Elle ne parle à aucun fournisseur : elle lit la base et sélectionne. Les
 * valeurs retournées sont les objets du domaine, **structurellement** compatibles
 * avec l'entrée attendue par `@aia/ai` (`MemoryPackInput`), que l'application
 * appelle ensuite. Impossible d'oublier un champ : TypeScript le refuse au câblage.
 *
 * La sélection elle-même est celle de `getProjectContext` (importance × récence ÷
 * usages) : gratuite, reproductible, explicable — et **seuls les faits confirmés**
 * y entrent (docs/03 §6.1). Aucun embedding, aucun RAG en V1.
 */
export interface WriterMemorySource {
  project: Project;
  /** Les faits retenus, **dans l'ordre** où ils seront rendus au modèle. */
  facts: readonly ProjectFact[];
  skillFacts: readonly ProjectSkillFact[];
  /** Le **premier** profil d'audience du projet, ou `null` : rien plutôt qu'inventé. */
  audience: AudienceProfile | null;
  /** Le **premier** profil de voix du projet, ou `null`. */
  style: StyleProfile | null;
}

export function writerMemorySource(
  memory: ProjectMemoryPorts,
  projectId: string,
): WriterMemorySource {
  const project = memory.store.projects.byId(projectId);
  if (!project) {
    throw new NotFoundError(`Projet introuvable : ${projectId}`, {
      code: 'PROJECT_NOT_FOUND',
      details: { projectId },
    });
  }

  const context = getProjectContext(memory, projectId);

  return {
    project,
    facts: context.facts.map((selected) => selected.fact),
    skillFacts: memory.store.skillFacts.list(projectId),
    audience: memory.store.audienceProfiles.list(projectId)[0] ?? null,
    style: memory.store.styleProfiles.list(projectId)[0] ?? null,
  };
}
