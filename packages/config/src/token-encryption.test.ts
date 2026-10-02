import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken, isEncryptedToken } from './token-encryption';

describe('chiffrement des jetons de plateforme', () => {
  it('stocke une enveloppe AES-GCM sans le secret en clair et détecte toute altération', () => {
    const key = Buffer.alloc(32, 7);
    const secret = 'jeton-canari-tres-secret';
    const encrypted = encryptToken(secret, key, 1);
    expect(isEncryptedToken(encrypted)).toBe(true);
    expect(encrypted).not.toContain(secret);
    expect(decryptToken(encrypted, new Map([[1, key]]))).toBe(secret);
    const parts = encrypted.split(':');
    parts[4] = `${parts[4]?.slice(0, -2)}AA`;
    expect(() => decryptToken(parts.join(':'), new Map([[1, key]]))).toThrow(/déchiffrer/);
  });
});
