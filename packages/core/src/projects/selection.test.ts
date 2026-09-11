import { MS_PER_DAY } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_KNOWLEDGE_CATEGORIES,
  RECENCY_HALF_LIFE_DAYS,
  buildProjectContext,
  recencyFactor,
  scoreFact,
  selectProjectFacts,
} from './selection';
import type { Project, ProjectFact } from './types';

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

function makeFact(overrides: Partial<ProjectFact> = {}): ProjectFact {
  return {
    id: 'fact-1',
    projectId: 'projet-1',
    category: 'note',
    statement: 'un fait',
    detail: null,
    source: 'user_input',
    sourceMessageId: null,
    verificationStatus: 'verified',
    verificationNote: null,
    verifiedAt: NOW,
    verifiedByUser: true,
    importance: 3,
    usedCount: 0,
    lastUsedAt: null,
    supersedesFactId: null,
    supersededByFactId: null,
    supersededAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'projet-1',
    ownerId: 'user-1',
    name: 'Projet',
    slug: 'projet',
    positioning: null,
    status: 'active',
    targetGoal: null,
    startDate: NOW,
    timezone: null,
    language: 'fr',
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...overrides,
  };
}

describe('sélection déterministe du contexte (docs/03 §6.6)', () => {
  it('applique le score documenté : importance × récence ÷ (utilisations + 1)', () => {
    expect(scoreFact(makeFact({ importance: 5, usedCount: 0 }), NOW)).toBeCloseTo(5, 10);
    expect(scoreFact(makeFact({ importance: 5, usedCount: 4 }), NOW)).toBeCloseTo(1, 10);
    expect(
      scoreFact(
        makeFact({ importance: 5, updatedAt: NOW - RECENCY_HALF_LIFE_DAYS * MS_PER_DAY }),
        NOW,
      ),
    ).toBeCloseTo(2.5, 10);

    // Un fait très ancien n'est jamais ramené à zéro : il reste sélectionnable.
    const ancient = makeFact({
      importance: 4,
      updatedAt: NOW - 100 * RECENCY_HALF_LIFE_DAYS * MS_PER_DAY,
    });
    expect(scoreFact(ancient, NOW)).toBeGreaterThan(0);
    expect(recencyFactor(NOW + MS_PER_DAY, NOW)).toBe(1); // horloge qui recule : jamais négatif
  });

  it('produit le même ordre pour les mêmes données, quel que soit l’ordre d’entrée', () => {
    const facts = [
      makeFact({ id: 'c', importance: 3 }),
      makeFact({ id: 'a', importance: 5 }),
      makeFact({ id: 'b', importance: 5 }),
    ];
    const forward = selectProjectFacts(facts, { nowMs: NOW }).selected.map((s) => s.fact.id);
    const backward = selectProjectFacts([...facts].reverse(), { nowMs: NOW }).selected.map(
      (s) => s.fact.id,
    );
    // `a` et `b` ont le même score : l'identifiant tranche, dans les deux sens.
    expect(forward).toEqual(backward);
    expect(forward).toEqual(['a', 'b', 'c']);
  });

  it('n’injecte que les faits confirmés, sauf en mode brouillon', () => {
    const facts = [
      makeFact({ id: 'confirme', verificationStatus: 'verified' }),
      makeFact({ id: 'fourni', verificationStatus: 'user_provided' }),
      makeFact({ id: 'propose', verificationStatus: 'proposed' }),
    ];
    const strict = selectProjectFacts(facts, { nowMs: NOW });
    expect(strict.selected.map((s) => s.fact.id)).toEqual(['confirme']);
    expect(strict.excluded.unverified).toBe(2);

    const brouillon = selectProjectFacts(facts, { nowMs: NOW, includeUnverified: true });
    expect(brouillon.selected).toHaveLength(3);
  });

  it('écarte les faits obsolètes et remplacés, en le disant', () => {
    const facts = [
      makeFact({ id: 'vivant' }),
      makeFact({ id: 'obsolete', verificationStatus: 'obsolete' }),
      makeFact({ id: 'remplace', verificationStatus: 'superseded', supersededByFactId: 'vivant' }),
    ];
    const outcome = selectProjectFacts(facts, { nowMs: NOW });
    expect(outcome.selected.map((s) => s.fact.id)).toEqual(['vivant']);
    expect(outcome.excluded.inactive).toBe(2);
  });

  it('filtre par catégorie, par état et par date, et respecte la limite', () => {
    const facts = [
      makeFact({ id: 'stack', category: 'stack' }),
      makeFact({ id: 'erreur', category: 'erreur' }),
      makeFact({
        id: 'note-ancienne',
        category: 'note',
        createdAt: NOW - 10 * MS_PER_DAY,
        updatedAt: NOW - 10 * MS_PER_DAY,
      }),
      makeFact({ id: 'note-recente', category: 'note' }),
    ];

    const categories = selectProjectFacts(facts, { nowMs: NOW, categories: ['note'] });
    expect(categories.selected.map((s) => s.fact.id)).toEqual(['note-recente', 'note-ancienne']);
    expect(categories.excluded.filtered).toBe(2);

    const recentes = selectProjectFacts(facts, { nowMs: NOW, sinceMs: NOW - MS_PER_DAY });
    expect([...recentes.selected.map((s) => s.fact.id)].sort()).toEqual([
      'erreur',
      'note-recente',
      'stack',
    ]);

    const bornees = selectProjectFacts(facts, { nowMs: NOW, untilMs: NOW - MS_PER_DAY });
    expect(bornees.selected.map((s) => s.fact.id)).toEqual(['note-ancienne']);

    expect(selectProjectFacts(facts, { nowMs: NOW, limit: 2 }).selected).toHaveLength(2);

    const parEtat = selectProjectFacts(
      [makeFact({ id: 'x', verificationStatus: 'user_provided' })],
      {
        nowMs: NOW,
        includeUnverified: true,
        statuses: ['verified'],
      },
    );
    expect(parEtat.selected).toHaveLength(0);
    expect(parEtat.excluded.filtered).toBe(1);
  });
});

describe('paquet de contexte d’un projet', () => {
  it('nomme les informations encore absentes du projet', () => {
    const context = buildProjectContext(
      makeProject(),
      [makeFact({ category: 'stack' }), makeFact({ id: 'f2', category: 'note' })],
      { nowMs: NOW },
    );
    expect(context.projectId).toBe('projet-1');
    expect(context.missingCategories).not.toContain('stack');
    expect(context.missingCategories).not.toContain('note');
    expect(context.missingCategories).toContain('motivation');
    expect(context.missingCategories).toContain('architecture');
    expect(PROJECT_KNOWLEDGE_CATEGORIES).toHaveLength(16);
  });

  it('considère un fait remplacé comme absent du projet', () => {
    const facts = [makeFact({ category: 'motivation', verificationStatus: 'superseded' })];
    const context = buildProjectContext(makeProject(), facts, { nowMs: NOW });
    expect(context.missingCategories).toContain('motivation');
  });
});
