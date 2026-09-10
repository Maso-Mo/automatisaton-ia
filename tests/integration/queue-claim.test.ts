import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JobDefinition } from '@aia/queue';
import { createTestContext, type TestContext } from '../support/harness';

const inputSchema = z.object({ value: z.number().int().optional() });

export type TestInput = z.infer<typeof inputSchema>;

/** Définition de job de test : mêmes règles que la production, sans métier. */
export function makeTestJob(
  overrides: Partial<JobDefinition<TestInput, unknown>> = {},
): JobDefinition<TestInput, unknown> {
  return {
    type: 'test_job',
    inputSchema,
    maxAttempts: 3,
    backoff: (attempt) => 30_000 * 4 ** (Math.max(1, attempt) - 1),
    leaseMs: 60_000,
    idempotent: true,
    handler: async () => ({ ok: true }),
    ...overrides,
  };
}

let context: TestContext;

beforeEach(() => {
  context = createTestContext();
  context.registry.register(makeTestJob());
});

afterEach(() => {
  context.cleanup();
});

describe('réservation atomique et cycle de vie (docs/08 §2, docs/09 §5)', () => {
  it('ne réserve jamais deux fois le même job avec quatre workers concurrents', async () => {
    for (let i = 0; i < 12; i += 1) {
      await context.queue.enqueue('test_job', { value: i });
    }

    const claims = await Promise.all(
      ['w1', 'w2', 'w3', 'w4'].map((worker) => context.queue.claim(worker, 3)),
    );
    const ids = claims.flat().map((job) => job.id);

    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12); // aucun doublon
  });

  it('respecte la priorité avant l’ordre d’arrivée', async () => {
    const low = await context.queue.enqueue('test_job', { value: 1 }, { priority: 9 });
    const high = await context.queue.enqueue('test_job', { value: 2 }, { priority: 1 });

    const [first] = await context.queue.claim('w1', 1);
    expect(first?.id).toBe(high);
    const [second] = await context.queue.claim('w1', 1);
    expect(second?.id).toBe(low);
  });

  it('déduplique par clé logique, puis libère la clé à la fin du job', async () => {
    const first = await context.queue.enqueue('test_job', { value: 1 }, { dedupeKey: 'k' });
    const second = await context.queue.enqueue('test_job', { value: 1 }, { dedupeKey: 'k' });
    expect(second).toBe(first);
    expect(context.queue.list()).toHaveLength(1);

    await context.queue.claim('w1', 1);
    await context.queue.complete(first, { ok: true });

    const third = await context.queue.enqueue('test_job', { value: 1 }, { dedupeKey: 'k' });
    expect(third).not.toBe(first);
    expect(context.queue.list()).toHaveLength(2);
  });

  it('reprend un job dont le lease a expiré, sans que la reprise coûte une tentative', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 7 });
    const [claimed] = await context.queue.claim('worker-1', 1);
    expect(claimed?.attempt).toBe(1);

    // Le worker « meurt » : le lease n'est plus renouvelé.
    context.clock.advance(61_000);
    expect(await context.queue.reclaimExpired(context.clock.now())).toBe(1);

    const afterReclaim = context.queue.get(jobId);
    expect(afterReclaim?.status).toBe('queued');
    expect(afterReclaim?.worker_id).toBeNull();
    expect(afterReclaim?.attempt).toBe(1); // la reprise seule ne consomme rien

    const [again] = await context.queue.claim('worker-2', 1);
    expect(again?.id).toBe(jobId);
    expect(again?.attempt).toBe(2); // la nouvelle réservation, elle, compte
  });

  it('prolonge le lease au battement de cœur : personne ne vole le job', async () => {
    await context.queue.enqueue('test_job', { value: 1 });
    const [claimed] = await context.queue.claim('worker-1', 1);
    if (!claimed) throw new Error('job non réservé');

    context.clock.advance(50_000);
    expect(await context.queue.heartbeat(claimed.id)).toBe(true);

    context.clock.advance(20_000); // lease initial dépassé, lease renouvelé encore valide
    expect(await context.queue.reclaimExpired(context.clock.now())).toBe(0);
  });

  it('persiste l’étape courante et la progression', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });
    await context.queue.claim('w1', 1);
    await context.queue.setStep(jobId, 'llm_call', 50);

    const row = context.queue.get(jobId);
    expect(row?.current_step).toBe('llm_call');
    expect(row?.progress).toBe(50);
  });

  it('refuse un type de job inconnu, et une entrée invalide', async () => {
    await expect(context.queue.enqueue('type_inexistant', {})).rejects.toThrow(
      /Type de job inconnu/,
    );
    await expect(context.queue.enqueue('test_job', { value: 'pas-un-nombre' })).rejects.toThrow(
      /Entrée invalide/,
    );
  });

  it('cumule le coût d’un job sans jamais l’écraser', async () => {
    const jobId = await context.queue.enqueue('test_job', { value: 1 });
    await context.queue.recordCost(jobId, 81_400);
    await context.queue.recordCost(jobId, 12_000);
    expect(context.queue.get(jobId)?.cost_micro_usd).toBe(93_400);
  });
});
