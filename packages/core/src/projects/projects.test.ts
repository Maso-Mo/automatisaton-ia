import { ValidationError } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { InvalidStateTransitionError } from '../errors';
import {
  PROJECT_NAME_MAX_LENGTH,
  SLUG_SUFFIX_LIMIT,
  assertProjectEditable,
  canTransitionProjectStatus,
  planProjectEdit,
  slugify,
  uniqueSlug,
} from './projects';
import type { Project } from './types';

const NOW = Date.UTC(2026, 2, 10, 12, 0, 0);

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'projet-1',
    ownerId: 'user-1',
    name: 'Automatisation IA',
    slug: 'automatisation-ia',
    positioning: null,
    status: 'discovery',
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

describe('identifiant lisible (slug, docs/03 §5.1)', () => {
  it('dérive un slug stable, sans accent ni casse', () => {
    expect(slugify('Automatisation IA : apprendre & partager')).toBe(
      'automatisation-ia-apprendre-partager',
    );
    expect(slugify('Été 2026 — édition « spéciale »')).toBe('ete-2026-edition-speciale');
  });

  it('tombe sur « projet » plutôt que sur une chaîne vide', () => {
    expect(slugify('   ')).toBe('projet');
    expect(slugify('!!!')).toBe('projet');
  });

  it('suffixe tant que le slug est pris, et s’arrête proprement', () => {
    const taken = new Set(['mon-projet', 'mon-projet-2']);
    expect(uniqueSlug('Mon projet', (slug) => taken.has(slug))).toBe('mon-projet-3');

    const everythingTaken = (): boolean => true;
    expect(() => uniqueSlug('tout pris', everythingTaken)).toThrow(/identifiant lisible unique/);

    const almostEverything = (slug: string): boolean => slug !== `tout-${SLUG_SUFFIX_LIMIT}`;
    expect(uniqueSlug('tout', almostEverything)).toBe(`tout-${SLUG_SUFFIX_LIMIT}`);
  });
});

describe('cycle de vie d’un projet (docs/03 §5.1)', () => {
  it('autorise découverte → actif → pause → actif, et refuse de sortir d’un archivage', () => {
    expect(canTransitionProjectStatus('discovery', 'active')).toBe(true);
    expect(canTransitionProjectStatus('active', 'paused')).toBe(true);
    expect(canTransitionProjectStatus('paused', 'active')).toBe(true);
    expect(canTransitionProjectStatus('active', 'discovery')).toBe(false);
    expect(canTransitionProjectStatus('archived', 'active')).toBe(false);
    expect(() =>
      planProjectEdit(makeProject({ status: 'archived' }), { status: 'active' }, NOW),
    ).toThrow(ValidationError);
  });

  it('met l’archive en lecture seule', () => {
    const archived = makeProject({ status: 'archived', archivedAt: NOW - 1_000 });
    expect(() => assertProjectEditable(archived)).toThrow(/lecture seule/);
    expect(() => planProjectEdit(archived, { name: 'autre nom' }, NOW)).toThrow(/lecture seule/);
  });

  it('refuse un nom vide et un nom trop long', () => {
    expect(() => planProjectEdit(makeProject(), { name: '   ' }, NOW)).toThrow(ValidationError);
    expect(() =>
      planProjectEdit(makeProject(), { name: 'x'.repeat(PROJECT_NAME_MAX_LENGTH + 1) }, NOW),
    ).toThrow(/ne dépasse pas/);
  });
});

describe('modification d’un projet', () => {
  it('n’écrit que les champs réellement modifiés', () => {
    const project = makeProject({ positioning: 'déjà là' });
    const patch = planProjectEdit(
      project,
      { name: 'Automatisation IA', positioning: 'déjà là', targetGoal: '500 abonnés' },
      NOW,
    );
    expect(patch.name).toBeUndefined();
    expect(patch.positioning).toBeUndefined();
    expect(patch.targetGoal).toBe('500 abonnés');
    expect(patch.updatedAt).toBe(NOW);
    expect(patch.status).toBeUndefined();
  });

  it('normalise un texte vide en absence de valeur', () => {
    const project = makeProject({ positioning: 'texte' });
    expect(planProjectEdit(project, { positioning: '   ' }, NOW).positioning).toBeNull();
    expect(planProjectEdit(project, { positioning: null }, NOW).positioning).toBeNull();
  });

  it('renseigne `archived_at` à l’archivage, et l’efface si l’on reprend', () => {
    const discovery = makeProject();
    const archived = planProjectEdit(discovery, { status: 'archived' }, NOW);
    expect(archived.status).toBe('archived');
    expect(archived.archivedAt).toBe(NOW);

    const paused = makeProject({ status: 'paused' });
    expect(planProjectEdit(paused, { status: 'active' }, NOW).archivedAt).toBeNull();
  });

  it('refuse une transition interdite avec une erreur de conflit typée', () => {
    expect(() =>
      planProjectEdit(makeProject({ status: 'discovery' }), { status: 'archived' }, NOW),
    ).not.toThrow();
    const active = makeProject({ status: 'active' });
    expect(() => planProjectEdit(active, { status: 'discovery' }, NOW)).toThrow(
      InvalidStateTransitionError,
    );
  });
});
