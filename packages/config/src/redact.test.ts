import { describe, expect, it } from 'vitest';
import { REDACTED, isSecretKey, redact, redactString, redactValue } from './redact';
import { MAX_REDACT_DEPTH } from './redact';

const FAKE_SECRETS = {
  openai: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
  anthropic: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  google: 'AIzaSyA1234567890abcdefghijklmnopqrstu',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmno',
  encryptionKey: 'f'.repeat(64),
};

describe('rédaction des secrets, au point de passage unique (docs/07 §8)', () => {
  it('reconnaît les noms de champs qui portent un secret', () => {
    expect(isSecretKey('DEEPSEEK_API_KEY')).toBe(true);
    expect(isSecretKey('access_token')).toBe(true);
    expect(isSecretKey('ENCRYPTION_KEY')).toBe(true);
    expect(isSecretKey('client_secret')).toBe(true);
    expect(isSecretKey('project_id')).toBe(false);
    expect(isSecretKey('cost_micro_usd')).toBe(false);
  });

  it('masque une valeur dont le nom est secret, quelle que soit sa forme', () => {
    expect(redactValue('api_key', 'n-importe-quoi')).toBe(REDACTED);
    expect(redactValue('model', 'deepseek-chat')).toBe('deepseek-chat');
  });

  it('masque les motifs de clés connus dans du texte libre', () => {
    for (const value of Object.values(FAKE_SECRETS)) {
      const redacted = redactString(`appel refusé avec la clé ${value} (401)`);
      expect(redacted).not.toContain(value);
      expect(redacted).toContain(REDACTED);
    }
  });

  it('masque récursivement une structure imbriquée sans perdre le reste', () => {
    const input = {
      provider: 'deepseek',
      apiKey: FAKE_SECRETS.openai,
      nested: { authorization: `Bearer ${FAKE_SECRETS.jwt}`, attempts: 2 },
      list: [{ token: 'x', label: 'ok' }],
      message: `échec avec ${FAKE_SECRETS.github}`,
    };
    const output = redact(input);
    const asText = JSON.stringify(output);
    for (const secret of Object.values(FAKE_SECRETS)) {
      expect(asText).not.toContain(secret);
    }
    expect(output.provider).toBe('deepseek');
    expect(output.nested.attempts).toBe(2);
    expect(output.message).toContain(REDACTED);
  });

  it('conserve les types non textuels et les erreurs', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    const date = new Date(0);
    expect(redact(date)).toBe(date);
    const error = new Error(`échec ${FAKE_SECRETS.google}`);
    const redactedError = redact(error);
    expect(redactedError.message).not.toContain(FAKE_SECRETS.google);
  });

  it('sert de canari : aucune clé ne survit à la rédaction', () => {
    const line = redact({
      level: 'error',
      message: 'échec http',
      request: { headers: { Authorization: `Bearer ${FAKE_SECRETS.jwt}` } },
      body: FAKE_SECRETS.anthropic,
      env: { ENCRYPTION_KEY: FAKE_SECRETS.encryptionKey },
    });
    const asText = JSON.stringify(line);
    for (const secret of Object.values(FAKE_SECRETS)) {
      expect(asText.includes(secret)).toBe(false);
    }
  });

  it('survit à une référence circulaire (objet de requête HTTP, client, logger)', () => {
    // Empêche un crash réel : la journalisation d'une requête Fastify provoquait
    // une récursion infinie (RangeError: Maximum call stack size exceeded).
    const request: Record<string, unknown> = { url: '/events/jobs/1', headers: { accept: '*/*' } };
    request.self = request;
    request.parent = { child: request };

    const output = redact({ request }) as { request: Record<string, unknown> };
    expect(output.request.url).toBe('/events/jobs/1');
    expect(output.request.self).toBe('[référence circulaire]');
    expect(JSON.stringify(output)).toContain('référence circulaire');
  });

  it('borne la profondeur et résume les objets de transport', () => {
    let deep: Record<string, unknown> = { value: 'fin' };
    for (let index = 0; index < MAX_REDACT_DEPTH + 5; index += 1) {
      deep = { nested: deep };
    }

    const output = JSON.stringify(redact({ deep, buffer: Buffer.from('secret-en-binaire') }));
    expect(output).toContain('profondeur maximale atteinte');
    expect(output).toMatch(/\[Buffer/);
    expect(output).not.toContain('secret-en-binaire');
  });
});
