import { afterEach, describe, expect, it } from 'vitest';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Protection d'accès par jeton (étape 12 §22).
 *
 * Trois affirmations sont vérifiées ici, et chacune protège une décision :
 *
 * 1. **sans jeton configuré, rien ne change** — l'usage local ne paie aucune
 *    complexité (docs/01 : il n'y a qu'un utilisateur) ;
 * 2. **avec jeton, le refus est le défaut** — y compris pour une écriture qui
 *    porterait le jeton dans l'URL, car un jeton d'URL finit dans un historique ;
 * 3. **le jeton n'apparaît jamais dans les journaux** — un journal n'est pas un
 *    coffre (docs/07 §4.3).
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

const TOKEN = 'jeton-de-test-0123456789abcdef';

function makeApi(env: Record<string, string> = {}) {
  const created = createTestContext({ env });
  context = created;
  const api = buildApi({ config: created.config, logger: created.logger, clock: created.clock });
  return { context: created, app: buildServer(api) };
}

describe('protection d’accès par jeton', () => {
  it('reste ouvert quand aucun jeton n’est configuré (accès local, défaut sûr)', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'GET', url: '/jobs' });
    expect(response.statusCode).toBe(200);
  });

  it('refuse une requête sans jeton dès qu’un jeton est configuré', async () => {
    const { app } = makeApi({ AUTH_TOKEN: TOKEN });
    const response = await app.inject({ method: 'GET', url: '/jobs' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('UNAUTHORIZED');
  });

  it('accepte le jeton par en-tête `Authorization: Bearer`', async () => {
    const { app } = makeApi({ AUTH_TOKEN: TOKEN });
    const response = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('accepte le jeton par en-tête `X-Auth-Token`', async () => {
    const { app } = makeApi({ AUTH_TOKEN: TOKEN });
    const response = await app.inject({
      method: 'GET',
      url: '/system/health',
      headers: { 'x-auth-token': TOKEN },
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuse un jeton faux', async () => {
    const { app } = makeApi({ AUTH_TOKEN: TOKEN });
    const response = await app.inject({
      method: 'GET',
      url: '/jobs',
      headers: { authorization: `Bearer ${TOKEN}-faux` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('laisse les sondes de supervision publiques, sans jamais connaître un secret', async () => {
    const { app } = makeApi({ AUTH_TOKEN: TOKEN });
    const liveness = await app.inject({ method: 'GET', url: '/health' });
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json().status).toBe('ok');

    // `/ready` répond 200 ou 503 selon l'état réel : dans les deux cas, il ne
    // demande pas de jeton. C'est le point testé.
    const readiness = await app.inject({ method: 'GET', url: '/ready' });
    expect([200, 503]).toContain(readiness.statusCode);
    expect(readiness.json().note).toContain('publique');
  });

  it('accepte le jeton en paramètre d’URL pour une lecture (SSE, image, vidéo)', async () => {
    const { app } = makeApi({ AUTH_TOKEN: TOKEN });
    const response = await app.inject({ method: 'GET', url: `/system/health?token=${TOKEN}` });
    expect(response.statusCode).toBe(200);
  });

  it('refuse un jeton d’URL sur une écriture : un jeton dans l’URL reste une lecture', async () => {
    const { app } = makeApi({ AUTH_TOKEN: TOKEN });
    const response = await app.inject({
      method: 'POST',
      url: `/projects?token=${TOKEN}`,
      payload: { name: 'Projet refusé', language: 'fr' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('ne laisse jamais le jeton dans les journaux ni dans une réponse d’erreur', async () => {
    const { app, context: created } = makeApi({ AUTH_TOKEN: TOKEN });
    await app.inject({ method: 'GET', url: `/system/health?token=${TOKEN}` });
    // Un refus journalise l'URL : elle doit être masquée là aussi.
    await app.inject({ method: 'GET', url: `/jobs?token=${TOKEN}-faux` });
    // Une route inconnue nomme l'URL dans son message d'erreur : même règle.
    const notFound = await app.inject({ method: 'GET', url: `/route-inconnue?token=${TOKEN}` });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.body).not.toContain(TOKEN);
    expect(notFound.body).toContain('token=***');

    const logs = created.logStream.text();
    expect(logs).not.toContain(TOKEN);
    expect(logs).toContain('token=***');
  });

  it('prévient au démarrage si l’API est exposée hors localhost sans jeton', async () => {
    // Une adresse de réseau local est acceptée par la configuration (seul
    // `0.0.0.0` est refusé) : c'est exactement le cas que le journal doit
    // signaler, sans bloquer le démarrage.
    const { context: created } = makeApi({ AUTH_TOKEN: '', APP_HOST: '192.168.1.20' });
    expect(created.logStream.text()).toContain('AUTH_TOKEN');
  });
});
