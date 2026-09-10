/**
 * Argent : tout montant est un **entier de micro-dollars** (`1 USD = 1 000 000`),
 * jamais un flottant (docs/03 §2.4, docs/08 §7.1).
 *
 * Un flottant ne s'additionne pas de façon fiable : sur des milliers d'appels à
 * 0,000074 $, les arrondis dérivent. Un entier se somme, se compare et se
 * plafonne sans ambiguïté, y compris dans une clause `WHERE total < limit`.
 */

export const MICRO_USD_PER_USD = 1_000_000;

/** Convertit un montant en dollars vers l'entier stocké en base. */
export function usdToMicro(usd: number): number {
  if (!Number.isFinite(usd)) {
    throw new TypeError(`Montant non fini : ${String(usd)}`);
  }
  return Math.round(usd * MICRO_USD_PER_USD);
}

/** Convertit l'entier stocké vers des dollars (affichage, estimation). */
export function microToUsd(microUsd: number): number {
  return microUsd / MICRO_USD_PER_USD;
}

/** Affichage lisible : `$0.0814`. L'arrondi n'a lieu qu'à cet endroit. */
export function formatMicroUsd(microUsd: number, fractionDigits = 4): string {
  return `$${microToUsd(microUsd).toFixed(fractionDigits)}`;
}

export function sumMicroUsd(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}
