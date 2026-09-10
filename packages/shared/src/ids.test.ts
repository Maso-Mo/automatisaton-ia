import { describe, expect, it } from 'vitest';
import { isUuidV7, uuidv7, uuidv7Timestamp } from './ids';

describe('UUID v7 (docs/03 §2.1)', () => {
  it('respecte le format v7 et le variant RFC 4122', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = uuidv7();
      expect(isUuidV7(id)).toBe(true);
      expect(id[14]).toBe('7');
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('est trié par date de création (c’est tout l’intérêt de v7 sur SQLite)', () => {
    const ids = [1_700_000_000_000, 1_700_000_000_001, 1_800_000_000_000].map((ms) => uuidv7(ms));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
  });

  it('encode l’horodatage sans perte', () => {
    const ms = 1_760_000_123_456;
    expect(uuidv7Timestamp(uuidv7(ms))).toBe(ms);
  });

  it('ne collisionne pas sur 10 000 générations', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()));
    expect(ids.size).toBe(10_000);
  });

  it('refuse un identifiant qui n’est pas un UUID v7', () => {
    expect(isUuidV7('2f1c1f1e-1a2b-4c3d-8e4f-000000000000')).toBe(false);
    expect(isUuidV7('pas-un-uuid')).toBe(false);
    expect(() => uuidv7Timestamp('pas-un-uuid')).toThrow(TypeError);
  });
});
