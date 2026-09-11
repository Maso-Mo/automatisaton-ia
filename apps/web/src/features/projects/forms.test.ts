import { describe, expect, it } from 'vitest';
import type { ProjectsVocabulary } from '../../api/client';
import {
  allowedNextStatuses,
  emptyFactForm,
  emptyProjectForm,
  factFormToInput,
  factStatusTone,
  formatDate,
  labelFor,
  optionsFor,
  projectFormToInput,
} from './forms';

/**
 * Tests du **front minimal** de la mémoire des projets (étape 2).
 *
 * Le vocabulaire ci-dessous est un **fixture** : il reproduit ce que l'API sert
 * (`GET /projects/vocabulary`, apps/api/src/routes/projects.ts). Le tester ainsi
 * garde `apps/web` sans dépendance au domaine (docs/02 §4) et vérifie que la
 * logique de saisie ne redéfinit jamais une énumération : elle lit celle qui lui
 * est donnée.
 */
const vocabulary: ProjectsVocabulary = {
  projectStatuses: [
    { value: 'discovery', label: 'Découverte', next: ['active', 'paused'] },
    { value: 'active', label: 'Actif', next: ['paused', 'archived'] },
    { value: 'archived', label: 'Archivé', next: [] },
  ],
  factCategories: [
    { value: 'description', label: 'Description' },
    { value: 'url', label: 'URL' },
    { value: 'note', label: 'Note' },
  ],
  factSources: [
    { value: 'user_input', label: 'Saisie utilisateur' },
    { value: 'ai_proposal', label: 'Proposition IA' },
  ],
  factVerificationStatuses: [
    { value: 'user_provided', label: 'Fourni par l’utilisateur', next: ['verified', 'uncertain'] },
    { value: 'verified', label: 'Vérifié', next: ['uncertain', 'obsolete'] },
    { value: 'uncertain', label: 'Incertain', next: ['verified', 'obsolete'] },
    { value: 'obsolete', label: 'Obsolète', next: [] },
    { value: 'superseded', label: 'Remplacé', next: [] },
  ],
  knowledgeCategories: ['objectif', 'stack', 'architecture', 'urls', 'notes'],
  limits: {
    factStatementMaxLength: 200,
    factDetailMaxLength: 2_000,
    recencyHalfLifeDays: 30,
  },
};

describe('formulaire de projet (front minimal, étape 2)', () => {
  it('refuse un projet sans nom et ne remonte qu’un message par problème', () => {
    const result = projectFormToInput({ ...emptyProjectForm, name: '   ' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(['Le nom du projet est obligatoire.']);
  });

  it('normalise la saisie : espaces retirés, champs vides à null', () => {
    const result = projectFormToInput({
      name: '  Veille IA  ',
      positioning: '   ',
      targetGoal: '  500 abonnés ',
      description: '',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      name: 'Veille IA',
      positioning: null,
      targetGoal: '500 abonnés',
    });
    // La description vide ne crée aucun fait : la clé est absente, pas `null`.
    expect('description' in result.value).toBe(false);
  });

  it('transmet la description quand elle est renseignée (elle devient un fait)', () => {
    const result = projectFormToInput({ ...emptyProjectForm, name: 'P', description: ' Texte ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.description).toBe('Texte');
  });
});

describe('formulaire de fait (front minimal, étape 2)', () => {
  it('refuse une catégorie absente du vocabulaire servi par l’API', () => {
    const result = factFormToInput(
      { ...emptyFactForm(), category: 'categorie_inventee', statement: 'x' },
      vocabulary,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('Choisir une catégorie de fait valide.');
  });

  it('refuse un énoncé vide', () => {
    const result = factFormToInput({ ...emptyFactForm(), statement: '   ' }, vocabulary);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('L’énoncé du fait est obligatoire.');
  });

  it('applique les bornes de longueur venues du vocabulaire, pas des constantes locales', () => {
    const statement = 'a'.repeat(vocabulary.limits.factStatementMaxLength + 1);
    const result = factFormToInput({ ...emptyFactForm(), statement }, vocabulary);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      `L’énoncé dépasse ${vocabulary.limits.factStatementMaxLength} caractères.`,
    );

    const shortVocabulary: ProjectsVocabulary = {
      ...vocabulary,
      limits: { ...vocabulary.limits, factStatementMaxLength: 3 },
    };
    expect(factFormToInput({ ...emptyFactForm(), statement: 'abcd' }, shortVocabulary).ok).toBe(
      false,
    );
    expect(factFormToInput({ ...emptyFactForm(), statement: 'abc' }, shortVocabulary).ok).toBe(
      true,
    );
  });

  it('refuse une importance hors de l’intervalle 1–5 ou non entière', () => {
    for (const importance of ['0', '6', '2.5', 'abc']) {
      const result = factFormToInput(
        { ...emptyFactForm(), statement: 'x', importance },
        vocabulary,
      );
      expect(result.ok).toBe(false);
    }
    expect(
      factFormToInput({ ...emptyFactForm(), statement: 'x', importance: '5' }, vocabulary).ok,
    ).toBe(true);
  });

  it('exige une URL reconnaissable pour la catégorie « url »', () => {
    const result = factFormToInput(
      { category: 'url', statement: 'mon site', detail: 'exemple.com', importance: '3' },
      vocabulary,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain(
      'Un fait de catégorie « URL » doit commencer par http:// ou https://.',
    );
  });

  it('produit un fait valide, détail vide remplacé par null', () => {
    const result = factFormToInput(
      { category: 'note', statement: '  à creuser ', detail: '   ', importance: '4' },
      vocabulary,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      category: 'note',
      statement: 'à creuser',
      detail: null,
      importance: 4,
    });
  });
});

describe('lecture du vocabulaire servi par l’API', () => {
  it('n’affiche que les transitions autorisées par le domaine', () => {
    expect(allowedNextStatuses(vocabulary, 'user_provided')).toEqual(['verified', 'uncertain']);
    expect(allowedNextStatuses(vocabulary, 'obsolete')).toEqual([]);
    // Un état inconnu ne doit jamais inventer une transition.
    expect(allowedNextStatuses(vocabulary, 'inconnu')).toEqual([]);
  });

  it('retombe sur la valeur brute sans libellé, jamais sur une chaîne vide', () => {
    expect(labelFor(vocabulary.projectStatuses, 'discovery')).toBe('Découverte');
    expect(labelFor(vocabulary.projectStatuses, 'inconnu')).toBe('inconnu');
  });

  it('distingue visuellement un fait confirmé d’un fait incertain', () => {
    expect(factStatusTone('verified')).not.toBe(factStatusTone('uncertain'));
    expect(factStatusTone('user_provided')).not.toBe(factStatusTone('verified'));
    expect(factStatusTone('obsolete')).not.toBe(factStatusTone('verified'));
  });

  it('formate une date manquante par un tiret, jamais « Invalid Date »', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(Date.UTC(2026, 2, 10))).toMatch(/2026/);
  });
});

describe('optionsFor', () => {
  it('rend des options prêtes à afficher (valeur + libellé)', () => {
    expect(optionsFor(vocabulary.factCategories)).toEqual([
      { value: 'description', label: 'Description' },
      { value: 'url', label: 'URL' },
      { value: 'note', label: 'Note' },
    ]);
  });
});
