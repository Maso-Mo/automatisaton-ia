import { describe, expect, it } from 'vitest';
import { decodeJson, encodeJson } from './json';
import { formatMicroUsd, microToUsd, sumMicroUsd, usdToMicro } from './money';
import { z } from 'zod';

describe('argent en micro-dollars (docs/03 §2.4)', () => {
  it('convertit sans flottant dans la base', () => {
    expect(usdToMicro(0.000074)).toBe(74);
    expect(usdToMicro(0.0814)).toBe(81_400);
    expect(usdToMicro(5)).toBe(5_000_000);
    expect(microToUsd(81_400)).toBeCloseTo(0.0814, 10);
  });

  it('s’additionne sans dérive', () => {
    const calls = Array.from({ length: 10_000 }, () => usdToMicro(0.000074));
    expect(sumMicroUsd(calls)).toBe(740_000);
    expect(formatMicroUsd(sumMicroUsd(calls))).toBe('$0.7400');
  });

  it('refuse un montant non fini', () => {
    expect(() => usdToMicro(Number.NaN)).toThrow(TypeError);
    expect(() => usdToMicro(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('JSON typé (docs/03 §2.5)', () => {
  const schema = z.object({ facts: z.array(z.string()), importance: z.number().int().min(1) });

  it('encode et décode avec validation', () => {
    const raw = encodeJson({ facts: ['n8n'], importance: 4 });
    const decoded = decodeJson(schema, raw, 'facts_json');
    expect(decoded).toEqual({ ok: true, value: { facts: ['n8n'], importance: 4 } });
  });

  it('ne lève pas d’exception sur une valeur absente ou illisible', () => {
    expect(decodeJson(schema, null).ok).toBe(false);
    expect(decodeJson(schema, '').ok).toBe(false);
    const broken = decodeJson(schema, '{oops}', 'facts_json');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.issues[0]).toContain('JSON illisible');
  });

  it('rapporte les champs fautifs', () => {
    const invalid = decodeJson(schema, encodeJson({ facts: 'non', importance: 0 }), 'facts_json');
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.issues.some((issue) => issue.startsWith('facts'))).toBe(true);
      expect(invalid.issues.some((issue) => issue.startsWith('importance'))).toBe(true);
    }
  });
});
