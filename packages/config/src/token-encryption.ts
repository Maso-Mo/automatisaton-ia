import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ConfigError } from '@aia/shared';

const FORMAT = 'v1';
const ALGORITHM = 'aes-256-gcm';

export function encryptToken(token: string, key: Buffer, keyVersion = 1): string {
  if (key.length !== 32) throw new ConfigError('La clé de chiffrement doit faire 32 octets.');
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'enc',
    FORMAT,
    String(keyVersion),
    nonce.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
  ].join(':');
}

export function decryptToken(envelope: string, keys: ReadonlyMap<number, Buffer>): string {
  const parts = envelope.split(':');
  if (parts.length !== 6 || parts[0] !== 'enc' || parts[1] !== FORMAT) {
    throw new ConfigError('Jeton non chiffré ou format d’enveloppe inconnu.');
  }
  const keyVersion = Number(parts[2]);
  const key = keys.get(keyVersion);
  if (!key || key.length !== 32) throw new ConfigError(`Clé de jeton v${keyVersion} indisponible.`);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(parts[3] ?? '', 'base64'));
    decipher.setAuthTag(Buffer.from(parts[5] ?? '', 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[4] ?? '', 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ConfigError('Impossible de déchiffrer le jeton : enveloppe altérée ou mauvaise clé.');
  }
}

export function isEncryptedToken(value: string): boolean {
  return value.startsWith(`enc:${FORMAT}:`);
}
