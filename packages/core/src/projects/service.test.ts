import {
  NotFoundError,
  ValidationError,
  createManualClock,
  type FactVerificationStatus,
  type ManualClock,
  type ProjectStatus,
} from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from '../errors';
import {
  addFact,
  archiveProject,
  createProject,
  getFact,
  getProject,
  getProjectContext,
  listProjectFacts,
  listProjects,
  projectFactSummary,
  replaceFact,
  setFactVerification,
  summarizeProjectFacts,
  updateFact,
  updateProject,
  verifyFact,
} from './service';
import type { Project, ProjectFact, ProjectMemoryPorts, ProjectMemoryStore } from './types';

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

/**
 * Faux dépôt en mémoire : le domaine se teste **sans base**, donc chaque règle
 * est vérifiée en quelques millisecondes. Le dépôt réel est testé séparément sur
 * un fichier SQLite (tests/integration/project-memory.test.ts) : les deux
 * couches ont leurs propres tests, et c'est le même contrat.
 */
function createMemoryPorts(): ProjectMemoryPorts & {
  /** Horloge **manuelle** : le test avance le temps explicitement. */
  clock: ManualClock;
  projects: Project[];
  facts: ProjectFact[];
} {
  const projects: Project[] = [];
  const facts: ProjectFact[] = [];
  let counter = 0;

  const store: ProjectMemoryStore = {
    projects: {
      insert: (record) => {
        projects.push(record);
      },
      patch: (id, patch) => {
        const index = projects.findIndex((project) => project.id === id);
        const current = projects[index];
        if (index < 0 || !current) return 0;
        projects[index] = { ...current, ...patch };
        return 1;
      },
      byId: (id) => projects.find((project) => project.id === id),
      bySlug: (slug) => projects.find((project) => project.slug === slug),
      list: (filter = {}) =>
        projects.filter((project) => {
          if (filter.statuses && filter.statuses.length > 0) {
            return filter.statuses.includes(project.status);
          }
          return filter.includeArchived === true ? true : project.status !== 'archived';
        }),
    },
    facts: {
      insert: (record) => {
        facts.push(record);
      },
      patch: (id, patch) => {
        const index = facts.findIndex((fact) => fact.id === id);
        const current = facts[index];
        if (index < 0 || !current) return 0;
        facts[index] = { ...current, ...patch };
        return 1;
      },
      byId: (id) => facts.find((fact) => fact.id === id),
      list: (filter) =>
        facts.filter((fact) => {
          if (fact.projectId !== filter.projectId) return false;
          if (filter.categories && !filter.categories.includes(fact.category)) return false;
          if (filter.statuses && !filter.statuses.includes(fact.verificationStatus)) return false;
          if (
            filter.includeInactive !== true &&
            (fact.verificationStatus === 'obsolete' || fact.verificationStatus === 'superseded')
          ) {
            return false;
          }
          if (filter.sinceMs !== undefined && fact.createdAt < filter.sinceMs) return false;
          if (filter.untilMs !== undefined && fact.createdAt > filter.untilMs) return false;
          return true;
        }),
    },
    owner: { currentId: () => 'owner-1' },
    transaction: (operation) => operation(),
  };

  const clock = createManualClock(NOW);
  const ports: ProjectMemoryPorts & { clock: ManualClock } = {
    store,
    clock,
    newId: () => `id-${(counter += 1)}`,
  };

  return { ...ports, projects, facts };
}

describe('cas d’usage des projets (docs/10 §4.2)', () => {
  it('crée un projet en découverte, avec un identifiant lisible et son propriétaire', () => {
    const ports = createMemoryPorts();
    const project = createProject(ports, { name: 'Automatisation IA' });

    expect(project.status).toBe('discovery');
    expect(project.slug).toBe('automatisation-ia');
    expect(project.ownerId).toBe('owner-1');
    expect(project.language).toBe('fr');
    expect(project.startDate).toBe(NOW);
    expect(project.createdAt).toBe(NOW);
    expect(getProject(ports, project.id).name).toBe('Automatisation IA');
  });

  it('enregistre la description initiale comme un fait, pas comme un champ opaque', () => {
    const ports = createMemoryPorts();
    const project = createProject(ports, {
      name: 'Projet',
      description: 'Contenu long, mais structuré',
    });

    const facts = listProjectFacts(ports, project.id);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.category).toBe('description');
    expect(facts[0]?.source).toBe('user_input');
    expect(facts[0]?.verificationStatus).toBe('user_provided');
  });

  it('départage deux projets de même nom sans collision de slug', () => {
    const ports = createMemoryPorts();
    const first = createProject(ports, { name: 'Veille IA' });
    const second = createProject(ports, { name: 'Veille IA' });
    expect(first.slug).toBe('veille-ia');
    expect(second.slug).toBe('veille-ia-2');
  });

  it('refuse un projet sans nom', () => {
    const ports = createMemoryPorts();
    expect(() => createProject(ports, { name: '   ' })).toThrow(ValidationError);
  });

  it('modifie un projet sans toucher à ce qui n’a pas changé', () => {
    const ports = createMemoryPorts();
    const project = createProject(ports, { name: 'Projet' });
    ports.clock.set(NOW + 5_000);

    const updated = updateProject(ports, project.id, {
      targetGoal: '500 abonnés',
      status: 'active',
    });
    expect(updated.targetGoal).toBe('500 abonnés');
    expect(updated.status).toBe('active');
    expect(updated.updatedAt).toBe(NOW + 5_000);
    expect(updated.createdAt).toBe(NOW);
  });

  it('archive sans supprimer, puis refuse toute modification', () => {
    const ports = createMemoryPorts();
    const project = createProject(ports, { name: 'Projet' });
    ports.clock.set(NOW + 1_000);
    const archived = archiveProject(ports, project.id);

    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(NOW + 1_000);
    // Le projet existe toujours : archivage n'est pas suppression.
    expect(getProject(ports, project.id).id).toBe(project.id);
    expect(() => updateProject(ports, project.id, { name: 'autre' })).toThrow(/lecture seule/);
    expect(() => addFact(ports, project.id, { category: 'note', statement: 'x' })).toThrow(
      /lecture seule/,
    );
  });

  it('liste les projets en masquant les archivés, sauf demande explicite', () => {
    const ports = createMemoryPorts();
    const actif = createProject(ports, { name: 'Actif' });
    const autre = createProject(ports, { name: 'Autre' });
    archiveProject(ports, autre.id);

    expect(listProjects(ports).map((project) => project.id)).toEqual([actif.id]);
    expect(listProjects(ports, { includeArchived: true })).toHaveLength(2);
    expect(listProjects(ports, { statuses: ['archived'] as ProjectStatus[] })).toHaveLength(1);
  });

  it('refuse une transition de statut interdite', () => {
    const ports = createMemoryPorts();
    const project = createProject(ports, { name: 'Projet' });
    updateProject(ports, project.id, { status: 'active' });
    expect(() => updateProject(ports, project.id, { status: 'discovery' })).toThrow(
      InvalidStateTransitionError,
    );
  });

  it('signale un projet inconnu par une erreur typée', () => {
    const ports = createMemoryPorts();
    expect(() => getProject(ports, 'inconnu')).toThrow(NotFoundError);
    expect(() => listProjectFacts(ports, 'inconnu')).toThrow(/introuvable/);
  });
});

describe('cas d’usage des faits', () => {
  function seeded() {
    const ports = createMemoryPorts();
    const project = createProject(ports, { name: 'Projet' });
    return { ports, project };
  }

  it('crée un fait fourni par l’utilisateur, non confirmé', () => {
    const { ports, project } = seeded();
    const fact = addFact(ports, project.id, {
      category: 'stack',
      statement: 'Node, TypeScript, SQLite',
      importance: 4,
    });

    expect(fact.source).toBe('user_input');
    expect(fact.verificationStatus).toBe('user_provided');
    expect(fact.verifiedByUser).toBe(false);
    expect(fact.verifiedAt).toBeNull();
    expect(fact.importance).toBe(4);
    expect(getFact(ports, project.id, fact.id).statement).toBe('Node, TypeScript, SQLite');
  });

  it('fait naître un fait proposé par l’IA en « proposed » et refuse qu’il naisse confirmé', () => {
    const { ports, project } = seeded();
    const proposed = addFact(ports, project.id, {
      category: 'motivation',
      statement: 'Motivation déduite',
      source: 'ai_proposal',
    });
    expect(proposed.verificationStatus).toBe('proposed');
    expect(proposed.verifiedByUser).toBe(false);

    expect(() =>
      addFact(ports, project.id, {
        category: 'motivation',
        statement: 'Motivation déduite',
        source: 'ai_proposal',
        verificationStatus: 'verified',
      }),
    ).toThrow(/acte explicite de l’utilisateur/);
  });

  it('confirme un fait : la date de l’acte humain est enregistrée', () => {
    const { ports, project } = seeded();
    const fact = addFact(ports, project.id, { category: 'chiffre', statement: '3 projets livrés' });
    ports.clock.set(NOW + 60_000);

    const verified = verifyFact(ports, project.id, fact.id);
    expect(verified.verificationStatus).toBe('verified');
    expect(verified.verifiedByUser).toBe(true);
    expect(verified.verifiedAt).toBe(NOW + 60_000);

    // Retirer la confirmation est possible, et efface la date : l'état et la
    // date ne peuvent pas diverger (garanti aussi par la base).
    const doubted = setFactVerification(
      ports,
      project.id,
      fact.id,
      'uncertain',
      'chiffre à revérifier',
    );
    expect(doubted.verificationStatus).toBe('uncertain');
    expect(doubted.verifiedAt).toBeNull();
    expect(doubted.verificationNote).toBe('chiffre à revérifier');
  });

  it('invalide un fait sans le supprimer', () => {
    const { ports, project } = seeded();
    const fact = addFact(ports, project.id, { category: 'contrainte', statement: 'budget serré' });
    const obsolete = setFactVerification(ports, project.id, fact.id, 'obsolete', 'plus vrai');

    expect(obsolete.verificationStatus).toBe('obsolete');
    // Toujours là : la mémoire ne se supprime pas.
    expect(getFact(ports, project.id, fact.id).id).toBe(fact.id);
    // Mais absente du listage courant.
    expect(listProjectFacts(ports, project.id).map((item) => item.id)).not.toContain(fact.id);
    expect(listProjectFacts(ports, project.id, { includeInactive: true })).toHaveLength(1);
  });

  it('remplace un fait en conservant l’ancien et la chaîne d’historique', () => {
    const { ports, project } = seeded();
    const ancien = addFact(ports, project.id, {
      category: 'etat_actuel',
      statement: 'v1 en ligne',
    });
    verifyFact(ports, project.id, ancien.id);
    ports.clock.set(NOW + 1_000);

    const { superseded, replacement } = replaceFact(ports, project.id, ancien.id, {
      category: 'etat_actuel',
      statement: 'v2 en ligne',
      note: 'la v1 est retirée',
    });

    expect(replacement.supersedesFactId).toBe(ancien.id);
    expect(replacement.verificationStatus).toBe('user_provided');
    expect(superseded.verificationStatus).toBe('superseded');
    expect(superseded.supersededByFactId).toBe(replacement.id);
    expect(superseded.supersededAt).toBe(NOW + 1_000);
    expect(superseded.verificationNote).toBe('la v1 est retirée');

    const stored = getFact(ports, project.id, ancien.id);
    expect(stored.statement).toBe('v1 en ligne'); // le texte d'origine est intact
    expect(stored.verificationStatus).toBe('superseded');
    expect(listProjectFacts(ports, project.id).map((fact) => fact.id)).toEqual([replacement.id]);
  });

  it('refuse de remplacer deux fois le même fait, et un fait d’un autre projet', () => {
    const { ports, project } = seeded();
    const autre = createProject(ports, { name: 'Autre projet' });
    const fact = addFact(ports, project.id, { category: 'note', statement: 'note' });
    replaceFact(ports, project.id, fact.id, { category: 'note', statement: 'note corrigée' });

    expect(() =>
      replaceFact(ports, project.id, fact.id, { category: 'note', statement: 'encore' }),
    ).toThrow(InvalidStateTransitionError);

    expect(() => getFact(ports, autre.id, fact.id)).toThrow(NotFoundError);
  });

  it('met à jour le contenu sans changer l’état de vérification', () => {
    const { ports, project } = seeded();
    const fact = addFact(ports, project.id, { category: 'note', statement: 'v1' });
    verifyFact(ports, project.id, fact.id);

    const updated = updateFact(ports, project.id, fact.id, { statement: 'v2', importance: 5 });
    expect(updated.statement).toBe('v2');
    expect(updated.importance).toBe(5);
    expect(updated.verificationStatus).toBe('verified');
  });

  it('refuse une écriture invalide', () => {
    const { ports, project } = seeded();
    const fact = addFact(ports, project.id, { category: 'note', statement: 'valide' });
    expect(() => updateFact(ports, project.id, fact.id, { statement: '  ' })).toThrow(
      ValidationError,
    );
    expect(() =>
      addFact(ports, project.id, { category: 'url', statement: 'adresse manquante' }),
    ).toThrow(/adresse http/);
    expect(() =>
      setFactVerification(ports, project.id, fact.id, 'superseded' as FactVerificationStatus),
    ).toThrow(/route de remplacement/);
  });

  it('filtre les faits par catégorie, par état et par date', () => {
    const { ports, project } = seeded();
    addFact(ports, project.id, { category: 'stack', statement: 'Node' });
    const decision = addFact(ports, project.id, { category: 'decision', statement: 'SQLite' });
    verifyFact(ports, project.id, decision.id);

    expect(listProjectFacts(ports, project.id, { categories: ['stack'] })).toHaveLength(1);
    expect(listProjectFacts(ports, project.id, { statuses: ['verified'] })).toHaveLength(1);
    expect(listProjectFacts(ports, project.id, { sinceMs: NOW + 1 })).toHaveLength(0);
    expect(listProjectFacts(ports, project.id, { untilMs: NOW })).toHaveLength(2);
  });

  it('résume l’état de la mémoire d’un projet', () => {
    const { ports, project } = seeded();
    const a = addFact(ports, project.id, { category: 'stack', statement: 'Node' });
    addFact(ports, project.id, { category: 'note', statement: 'note' });
    verifyFact(ports, project.id, a.id);

    const summary = projectFactSummary(ports, project.id);
    expect(summary.total).toBe(2);
    expect(summary.trusted).toBe(1);
    expect(summary.byStatus.verified).toBe(1);
    expect(summary.byCategory.stack).toBe(1);

    expect(summarizeProjectFacts([])).toEqual({
      total: 0,
      byStatus: {},
      byCategory: {},
      trusted: 0,
    });
  });

  it('compose un contexte déterministe, sans écrire en base', () => {
    const { ports, project } = seeded();
    const fact = addFact(ports, project.id, {
      category: 'probleme',
      statement: 'veille trop chère',
    });
    verifyFact(ports, project.id, fact.id);
    addFact(ports, project.id, { category: 'note', statement: 'note non confirmée' });

    const context = getProjectContext(ports, project.id);
    expect(context.facts.map((entry) => entry.fact.id)).toEqual([fact.id]);
    expect(context.excluded.unverified).toBe(1);
    expect(context.missingCategories).toContain('stack');

    // Sélectionner n'incrémente pas `used_count` : c'est l'injection réelle dans
    // un prompt qui le fera (étape 4).
    expect(getFact(ports, project.id, fact.id).usedCount).toBe(0);
  });
});
