import { afterEach, describe, expect, it } from 'vitest';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createNoopStack } from '../support/noop-stack';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Tests d'intégration de l'API : la vraie instance Fastify, la vraie base, le
 * vrai journal — via `inject()` pour le REST et via un vrai port pour le flux SSE
 * (un flux qu'on ne peut pas interrompre ne se teste pas avec `inject`).
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function makeApi() {
  context = createTestContext();
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
  });
  const app = buildServer(api);
  return { api, app, stack: createNoopStack(context) };
}

describe('API de l’étape 1', () => {
  it('décrit le service sur la racine', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Le libellé d'étape est une **affirmation produit** : il nomme ce que
    // l'application sait faire aujourd'hui. Ce test le fige pour qu'il ne
    // régresse pas et n'annonce jamais une étape inexistante.
    expect(body.step).toBe('étape 2 — mémoire des projets');
    expect(body.endpoints).toContain('GET /system/health');
  });

  it('sert le diagnostic : base migrée, worker, clé IA, budget du jour', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'GET', url: '/system/health' });
    expect(response.statusCode).toBe(200);

    const health = response.json();
    const ids = health.checks.map((check: { id: string }) => check.id);
    expect(ids).toEqual(expect.arrayContaining(['database', 'worker', 'llm', 'budget']));

    const database = health.checks.find((check: { id: string }) => check.id === 'database');
    expect(database.status).toBe('ok');
    expect(health.database.tableCount).toBeGreaterThanOrEqual(13);
    expect(health.database.walEnabled).toBe(true);
    expect(health.budget.todayMicroUsd).toBe(0);

    // Sans clé IA configurée, le socle est « dégradé », jamais « bloqué ».
    expect(health.status).toBe('degraded');
  });

  it('liste les jobs et détecte un worker actif dès qu’un job est réservé', async () => {
    const { app, stack } = makeApi();
    const jobId = await stack.queue.enqueue('noop', { message: 'api' });
    await stack.queue.claim('worker-api', 1);

    const list = await app.inject({ method: 'GET', url: '/jobs?limit=10' });
    expect(list.statusCode).toBe(200);
    const jobs = list.json().jobs as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe(jobId);
    expect(jobs[0]?.status).toBe('running');

    const health = (await app.inject({ method: 'GET', url: '/system/health' })).json();
    expect(health.worker.active).toBe(true);
    expect(health.worker.jobs.running).toBe(1);
  });

  it('renvoie un job avec ses événements, dans l’ordre', async () => {
    const { app, stack } = makeApi();
    const jobId = await stack.queue.enqueue('noop', { message: 'api' });
    await stack.queue.claim('worker-api', 1);
    await stack.queue.appendEvent(jobId, { message: 'premier', step: 'prompt' });
    await stack.queue.appendEvent(jobId, { message: 'second', step: 'llm_call' });

    const response = await app.inject({ method: 'GET', url: `/jobs/${jobId}` });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.job.id).toBe(jobId);
    expect(body.events.map((event: { step: string }) => event.step)).toEqual([
      'prompt',
      'llm_call',
    ]);
    expect(body.events.map((event: { sequence: number }) => event.sequence)).toEqual([1, 2]);
  });

  it('répond 404 avec une erreur typée pour un job inconnu', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'GET', url: '/jobs/job-inexistant' });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.category).toBe('not_found');
    expect(body.error.code).toBe('JOB_NOT_FOUND');
  });

  it('répond 404 pour une route inconnue, sans exposer de trace', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'POST', url: '/jobs/noop' });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(body.error.category).toBe('not_found');
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('diffuse les événements d’un job en SSE, avec un état complet d’abord', async () => {
    const { app, stack } = makeApi();
    const jobId = await stack.queue.enqueue('noop', { message: 'sse' });
    await stack.queue.claim('worker-api', 1);
    await stack.queue.appendEvent(jobId, { message: 'en cours', step: 'prompt', progress: 40 });
    await stack.queue.complete(jobId, { ok: true });

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const response = await fetch(`http://127.0.0.1:${port}/events/jobs/${jobId}?intervalMs=100`, {
      headers: { accept: 'text/event-stream' },
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"type":"noop"');
    expect(text).toContain('event: job_event');
    expect(text).toContain('event: done');

    await app.close();
  });

  it('refuse un `lastSequence` invalide sans casser le flux', async () => {
    const { app, stack } = makeApi();
    const jobId = await stack.queue.enqueue('noop', { message: 'sse' });

    const response = await app.inject({
      method: 'GET',
      url: `/events/jobs/${jobId}?lastSequence=abc`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.category).toBe('validation');
  });
});
