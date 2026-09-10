import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@aia/shared';
import { CONFIG_HELP, ENV_KEYS } from './env';
import { describeConfig, loadConfig } from './load';

const VALID_SOURCE = {
  SESSION_SECRET: 'a'.repeat(48),
  ENCRYPTION_KEY: 'b'.repeat(64),
  DEEPSEEK_API_KEY: 'sk-secret-abcdefghijklmnop',
  // Neutralise la valeur héritée de `process.env` (posée par `tests/support/setup.ts`)
  // pour que le test porte bien sur les valeurs **par défaut** du schéma.
  DATABASE_URL: undefined,
};

function load(source: Record<string, string | undefined> = {}) {
  return loadConfig({
    dotenvPath: null,
    source: { ...VALID_SOURCE, ...source },
    rootDir: '/tmp/aia',
  });
}

function loadError(source: Record<string, string | undefined>): ConfigError {
  try {
    load(source);
  } catch (error) {
    return error as ConfigError;
  }
  throw new Error('la validation aurait dû échouer');
}

describe('validation de la configuration (docs/02 §11)', () => {
  it('applique des valeurs par défaut sûres', () => {
    const config = load();
    expect(config.env.APP_HOST).toBe('127.0.0.1');
    expect(config.env.APP_PORT).toBe(4317);
    expect(config.env.DATABASE_URL).toBe('file:./data/app.db');
    expect(config.env.MONTHLY_BUDGET_USD).toBe(5);
    expect(config.env.QUEUE_CONCURRENCY).toBe(3);
    expect(config.env.OFFLINE_MODE).toBe(false);
    expect(config.paths.databaseFile).toBe('/tmp/aia/data/app.db');
    expect(config.encryptionKey).toHaveLength(32);
  });

  it('refuse 0.0.0.0 au démarrage, avec un message explicatif (docs/07 §3.1)', () => {
    const error = loadError({ APP_HOST: '0.0.0.0' });
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toContain('APP_HOST');
    expect(error.message).toContain('127.0.0.1');
    expect(error.message).toContain(CONFIG_HELP);
    expect(error.details?.issues).toEqual([expect.stringContaining('APP_HOST')]);
  });

  it('refuse une clé cryptographique absente et donne la commande de génération', () => {
    expect(() => load({ SESSION_SECRET: '' })).toThrow(/SESSION_SECRET est obligatoire/);
    expect(() => load({ ENCRYPTION_KEY: 'trop-court' })).toThrow(/64 caractères hexadécimaux/);
    expect(loadError({ ENCRYPTION_KEY: undefined }).message).toContain('openssl rand -hex 32');
  });

  it('refuse une valeur malformée plutôt que de la corriger en silence', () => {
    expect(() => load({ APP_PORT: 'pas-un-port' })).toThrow(/APP_PORT/);
    expect(() => load({ APP_PORT: '70000' })).toThrow(/APP_PORT/);
    expect(() => load({ LOG_LEVEL: 'bavard' })).toThrow(/LOG_LEVEL/);
    expect(() => load({ OFFLINE_MODE: 'peut-être' })).toThrow(/OFFLINE_MODE/);
  });

  it('accepte les booléens lisibles et une variable vide comme « absente »', () => {
    expect(load({ LOG_PRETTY: 'non' }).env.LOG_PRETTY).toBe(false);
    expect(load({ OFFLINE_MODE: 'oui' }).env.OFFLINE_MODE).toBe(true);
    expect(load({ OPENAI_API_KEY: '' }).env.OPENAI_API_KEY).toBeUndefined();
  });

  it('résout les chemins relatifs depuis la racine', () => {
    const config = load({ DATABASE_URL: 'file:./db/test.sqlite', MEDIA_ROOT: 'data/media' });
    expect(config.paths.databaseFile).toBe('/tmp/aia/db/test.sqlite');
    expect(config.paths.mediaRoot).toBe('/tmp/aia/data/media');
    expect(config.paths.promptsDir).toBe('/tmp/aia/prompts');
  });

  it('expose la présence des secrets sans jamais exposer leur valeur (docs/07 §4.3)', () => {
    const config = load();
    expect(config.secretPresence.DEEPSEEK_API_KEY).toBe(true);
    expect(config.secretPresence.OPENAI_API_KEY).toBe(false);
    const description = describeConfig(config).join('\n');
    expect(description).toContain('DEEPSEEK_API_KEY: présent');
    expect(description).toContain('OPENAI_API_KEY: absent');
    expect(description).not.toContain(VALID_SOURCE.DEEPSEEK_API_KEY);
    expect(description).not.toContain(VALID_SOURCE.ENCRYPTION_KEY);
    expect(description).not.toContain(VALID_SOURCE.SESSION_SECRET);
  });

  it('garde `.env.example` exhaustif (docs/07 §4.2)', () => {
    const example = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8');
    const declared = new Set(
      example
        .split('\n')
        .map((line) => /^([A-Z0-9_]+)=/.exec(line.trim())?.[1])
        .filter((key): key is string => key !== undefined),
    );
    const missing = ENV_KEYS.filter((key) => !declared.has(key));
    const extra = [...declared].filter(
      (key) => !ENV_KEYS.includes(key as (typeof ENV_KEYS)[number]),
    );
    expect(missing, 'variables absentes de .env.example').toEqual([]);
    expect(extra, 'variables de .env.example inconnues de packages/config').toEqual([]);
  });
});
