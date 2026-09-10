import { describe, expect, it } from 'vitest';
import {
  PRICE_TABLE,
  computeCostMicroUsd,
  estimateCostMicroUsd,
  estimatePromptTokens,
  findPrice,
} from './pricing';

const deepseek = findPrice('deepseek', 'deepseek-chat');

describe('calcul du coût (docs/08 §7.3)', () => {
  it('applique la formule du document : entrée + cache + sortie, en micro-dollars entiers', () => {
    const cost = computeCostMicroUsd(
      { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 1_000_000 },
      deepseek,
    );
    // 1 M jetons d'entrée à 0,27 $ + 1 M de sortie à 1,10 $ = 1,37 $ = 1 370 000 µ$
    expect(cost).toBe(1_370_000);
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('facture les jetons en cache au tarif réduit', () => {
    const withCache = computeCostMicroUsd(
      { promptTokens: 1_000_000, cachedTokens: 1_000_000, completionTokens: 0 },
      deepseek,
    );
    const withoutCache = computeCostMicroUsd(
      { promptTokens: 1_000_000, cachedTokens: 0, completionTokens: 0 },
      deepseek,
    );
    expect(withCache).toBe(70_000);
    expect(withoutCache).toBe(270_000);
    expect(withCache).toBeLessThan(withoutCache);
  });

  it('ne facture rien pour un modèle local, quel que soit le volume', () => {
    const local = findPrice('local', 'local-small');
    expect(
      computeCostMicroUsd(
        { promptTokens: 5_000_000, cachedTokens: 0, completionTokens: 2_000_000 },
        local,
      ),
    ).toBe(0);
  });

  it('ne produit jamais de coût négatif, même avec un cache incohérent', () => {
    const cost = computeCostMicroUsd(
      { promptTokens: 10, cachedTokens: 999, completionTokens: 0 },
      deepseek,
    );
    expect(cost).toBe(Math.round(999 * deepseek.cachedInputPerMillionUsd));
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('estime avant l’appel, pour pouvoir refuser sans dépenser', () => {
    const estimate = estimateCostMicroUsd({ prompt: 'a'.repeat(4_000), price: deepseek });
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(1_000_000);
    expect(estimatePromptTokens('a'.repeat(400))).toBe(100);
  });

  it('refuse un modèle inconnu plutôt que d’inventer un tarif', () => {
    expect(() => findPrice('fournisseur-imaginaire', 'modele-x')).toThrow(/Aucun tarif connu/);
  });

  it('marque chaque tarif comme vérifié ou non (⚠️ docs/08 §7.3)', () => {
    for (const price of PRICE_TABLE) {
      expect(typeof price.verified).toBe('boolean');
      expect(Number.isNaN(Date.parse(price.effectiveFrom))).toBe(false);
      expect(price.inputPerMillionUsd).toBeGreaterThanOrEqual(0);
      expect(price.outputPerMillionUsd).toBeGreaterThanOrEqual(0);
    }
  });
});
