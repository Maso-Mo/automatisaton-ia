import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmbiguousOutcomeError, TransientError, ValidationError } from '@aia/shared';
import { createTestContext, type TestContext } from '../support/harness';
import { makeTestJob } from './queue-claim.test';

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
  context.registry.register(makeTestJob());
});

afterEach(() => {
  context.cleanup();
});

describe('reprise après erreur, décidée par la file (docs/02 §12, docs/08 §4)', () => {
  it('applique un backoff exponentiel avec jitter sur une erreur transitoire', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });
    await context.queue.claim('w1', 1);
    await context.queue.fail(jobId, new TransientError('502'));

    const row = context.queue.get(jobId);
    expect(row?.status).toBe('queued');
    expect(row?.attempt).toBe(1);
    const delay = (row?.available_at ?? 0) - context.clock.nowMs();
    expect(delay).toBeGreaterThanOrEqual(30_000 * 0.8 - 1);
    expect(delay).toBeLessThanOrEqual(30_000 * 1.2 + 1);
    expect(context.queue.get(jobId)?.error_json).toContain('transient');

    // Pas encore disponible, puis disponible après le délai.
    expect(await context.queue.claim('w1', 1)).toHaveLength(0);
    context.clock.advance(40_000);
    expect(await context.queue.claim('w1', 1)).toHaveLength(1);
  });

  it('échoue définitivement après épuisement des tentatives', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await context.queue.claim('w1', 1);
      await context.queue.fail(jobId, new TransientError('429'));
      context.clock.advance(60 * 60_000);
    }

    const row = context.queue.get(jobId);
    expect(row?.status).toBe('failed');
    expect(row?.attempt).toBe(3);
    expect(await context.queue.claim('w1', 1)).toHaveLength(0);
  });

  it('échoue immédiatement sur une erreur non réessayable', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });
    await context.queue.claim('w1', 1);
    await context.queue.fail(jobId, new ValidationError('entrée invalide'));

    const row = context.queue.get(jobId);
    expect(row?.status).toBe('failed');
    expect(row?.attempt).toBe(1);
  });

  it('ne rejoue jamais un résultat ambigu, même si la reprise est forcée', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });
    await context.queue.claim('w1', 1);
    await context.queue.fail(jobId, new AmbiguousOutcomeError('timeout après envoi'));
    expect(context.queue.get(jobId)?.status).toBe('failed');

    await context.queue.fail(jobId, new AmbiguousOutcomeError('timeout après envoi'), true);
    expect(context.queue.get(jobId)?.status).toBe('failed');
  });

  it('marque une annulation comme « annulé », jamais comme « échec »', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });
    await context.queue.claim('w1', 1);
    await context.queue.cancel(jobId);

    expect(context.queue.get(jobId)?.status).toBe('cancelled');
    expect(context.queue.counts().failed ?? 0).toBe(0);
    await expect(context.queue.cancel(jobId)).rejects.toThrow(/déjà terminé/);
  });

  it('laisse en attente les jobs qui exigent le réseau en mode hors ligne', async () => {
    const networkJob = await context.queue.enqueue(
      'test_job',
      { value: 1 },
      { requiresNetwork: true },
    );
    await context.queue.enqueue('test_job', { value: 2 });

    const offline = await context.queue.claim('w1', 5, { offline: true });
    expect(offline).toHaveLength(1);
    expect(offline.map((job) => job.id)).not.toContain(networkJob);

    const online = await context.queue.claim('w1', 5, { offline: false });
    expect(online.map((job) => job.id)).toContain(networkJob);
  });

  it('journalise chaque transition dans job_events, avec une séquence croissante', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });
    await context.queue.claim('w1', 1);
    await context.queue.appendEvent(jobId, { message: 'étape intermédiaire', step: 'prompt' });
    await context.queue.complete(jobId, { ok: true });

    const events = context.queue.events(jobId);
    const sequences = events.map((event) => event.sequence);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(context.queue.events(jobId, 1).every((event) => event.sequence > 1)).toBe(true);
    expect(context.queue.eventCount(jobId)).toBe(events.length);
  });
});
