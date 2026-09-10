import { describe, expect, it } from 'vitest';
import { ENUM_REGISTRY } from './enums';

interface EnumEntry {
  options: readonly string[];
  safeParse(value: unknown): { success: boolean };
}

function checkEnum(name: string, values: readonly string[], schema: EnumEntry): void {
  expect(values.length, `${name} est vide`).toBeGreaterThan(0);
  expect(new Set(values).size, `${name} contient un doublon`).toBe(values.length);
  expect([...schema.options], `${name} : tableau et schéma Zod divergent`).toEqual([...values]);
  for (const value of values) {
    expect(schema.safeParse(value).success, `${name} : ${value} refusé par le schéma`).toBe(true);
  }
  expect(schema.safeParse('valeur-inconnue').success, `${name} : valeur inconnue acceptée`).toBe(
    false,
  );
}

describe('énumérations (docs/03 §2.3)', () => {
  it('existe aux trois endroits : tableau, type TypeScript et schéma Zod', () => {
    for (const [name, entry] of Object.entries(ENUM_REGISTRY)) {
      checkEnum(name, entry.values, entry.schema);
    }
  });

  it('couvre les catégories d’erreur exactement comme la table de décision de docs/02 §12', () => {
    expect([...ENUM_REGISTRY.ERROR_CATEGORIES.values]).toEqual([
      'validation',
      'auth',
      'forbidden',
      'not_found',
      'conflict',
      'transient',
      'budget',
      'capability',
      'ambiguous',
      'internal',
    ]);
  });
});
