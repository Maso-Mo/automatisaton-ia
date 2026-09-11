import { describe, expect, it } from 'vitest';
import {
  FACT_CATEGORY_LABELS,
  FACT_CATEGORIES,
  FACT_SOURCE_LABELS,
  FACT_SOURCES,
  FACT_VERIFICATION_STATUS_LABELS,
  FACT_VERIFICATION_STATUSES,
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
} from './enums';

/**
 * L'interface ne doit jamais afficher une valeur brute (`etat_actuel`) ni un
 * libellé vide. Les tables de libellés sont typées `Record<valeur, string>` :
 * une valeur oubliée ne compile pas. Ce test protège le cas symétrique —
 * un libellé vide, ou une entrée en trop (valeur supprimée de l'énumération).
 */
describe('libellés d’interface (docs/09 §14)', () => {
  const tables = [
    { name: 'PROJECT_STATUS_LABELS', values: PROJECT_STATUSES, labels: PROJECT_STATUS_LABELS },
    { name: 'FACT_CATEGORY_LABELS', values: FACT_CATEGORIES, labels: FACT_CATEGORY_LABELS },
    {
      name: 'FACT_VERIFICATION_STATUS_LABELS',
      values: FACT_VERIFICATION_STATUSES,
      labels: FACT_VERIFICATION_STATUS_LABELS,
    },
    { name: 'FACT_SOURCE_LABELS', values: FACT_SOURCES, labels: FACT_SOURCE_LABELS },
  ];

  it('couvre exactement les valeurs, sans doublon et sans libellé vide', () => {
    for (const { name, values, labels } of tables) {
      expect(Object.keys(labels).sort(), `${name} : valeurs couvertes`).toEqual([...values].sort());
      for (const [key, label] of Object.entries(labels)) {
        expect(label.trim().length, `${name}.${key} est vide`).toBeGreaterThan(0);
      }
    }
  });

  it('nomme les seize informations de projet attendues à l’étape 2', () => {
    const knowledge = [
      'description',
      'motivation',
      'probleme',
      'stack',
      'technologie',
      'architecture',
      'fonctionnalite',
      'decision',
      'difficulte',
      'erreur',
      'solution',
      'apprentissage',
      'etat_actuel',
      'prochaine_etape',
      'url',
      'note',
    ] as const;

    for (const category of knowledge) {
      expect(FACT_CATEGORIES, `catégorie manquante : ${category}`).toContain(category);
      expect(FACT_CATEGORY_LABELS[category].length).toBeGreaterThan(0);
    }
    // Les catégories de biographie restent disponibles pour les étapes 3 à 8.
    expect(FACT_CATEGORIES).toContain('experience');
    expect(FACT_CATEGORIES).toContain('echec');
  });
});
