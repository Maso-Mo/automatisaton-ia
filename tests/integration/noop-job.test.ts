import { afterEach, describe, expect, it } from 'vitest';
import { listRecentLlmCalls, promptSummary } from '@aia/database';
import { createNoopStack } from '../support/noop-stack';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Le critère de sortie de l'étape 1 (docs/10 §4.1), vérifié de bout en bout :
 *
 * > un job `noop` s'exécute, s'écrit dans `jobs`/`job_events`, et une ligne
 * > `llm_calls` porte un coût calculé.
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

describe('job noop : la chaîne complète de l’étape 1', () => {
  it('exécute, journalise le coût et laisse une trace complète', async () => {
    context = createTestContext();
    const stack = createNoopStack(context);
    expect(stack.syncReport.inserted).toBeGreaterThan(0);
    expect(stack.syncReport.active).toBeGreaterThan(0);

    const jobId = await stack.queue.enqueue('noop', { message: 'vérification de bout en bout' });
    expect(await stack.loop.runOnce()).toBe(1);

    // 1. Le job : terminé, daté, chiffré.
    const job = stack.queue.get(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.attempt).toBe(1);
    expect(job?.progress).toBe(100);
    expect(job?.current_step).toBe('validate');
    expect(job?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(job?.cost_micro_usd).toBeGreaterThan(0);
    expect(job?.output_json).toContain(stack.prompt.promptVersionId);

    // 2. Les événements : séquence strictement croissante de 1 à n, étapes lisibles.
    const events = stack.queue.events(jobId);
    const steps = events.map((event) => event.step);
    for (const step of ['start', 'prompt', 'llm_call', 'validate', 'result', 'done']) {
      expect(steps, `étape attendue : ${step}`).toContain(step);
    }
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));

    // 3. L'appel LLM : une ligne, un coût calculé, la version de prompt utilisée.
    const calls = listRecentLlmCalls(context.handle, 10);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.status).toBe('success');
    expect(call?.task).toBe('cost_probe');
    expect(call?.provider).toBe('deepseek');
    expect(call?.prompt_version_id).toBe(stack.prompt.promptVersionId);
    expect(call?.job_id).toBe(jobId);
    expect(call?.cost_micro_usd).toBeGreaterThan(0);
    expect(call?.cost_micro_usd).toBe(job?.cost_micro_usd);
    expect(call?.prompt_tokens).toBeGreaterThan(0);
    expect(call?.completion_tokens).toBeGreaterThan(0);
    expect(call?.total_tokens).toBe((call?.prompt_tokens ?? 0) + (call?.completion_tokens ?? 0));
    expect(call?.context_fingerprint).toMatch(/^[0-9a-f]{64}$/);

    // 4. Le budget et l'index des prompts reflètent la réalité.
    expect(stack.budget.status().day.spentMicroUsd).toBeGreaterThan(0);
    expect(promptSummary(context.handle).active).toBeGreaterThan(0);
  });

  it('reprend un job interrompu par un crash du worker, sans intervention', async () => {
    context = createTestContext();
    const stack = createNoopStack(context, { seed: 11 });
    const jobId = await stack.queue.enqueue('noop', { message: 'crash simulé' });

    // Un premier worker réserve le job puis « meurt » sans rien terminer.
    const [claimed] = await stack.queue.claim('worker-mort', 1);
    expect(claimed?.id).toBe(jobId);
    expect(stack.queue.get(jobId)?.status).toBe('running');

    context.clock.advance(61_000);
    expect(await stack.loop.runOnce()).toBe(1);

    const job = stack.queue.get(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.worker_id).toBeNull();
    expect(stack.queue.events(jobId).some((event) => event.step === 'reclaim')).toBe(true);
  });

  it('ne rejoue pas le job quand la déduplication est active', async () => {
    context = createTestContext();
    const stack = createNoopStack(context);

    const first = await stack.queue.enqueue(
      'noop',
      { message: 'a' },
      { dedupeKey: 'diagnostic:noop' },
    );
    const second = await stack.queue.enqueue(
      'noop',
      { message: 'b' },
      { dedupeKey: 'diagnostic:noop' },
    );
    expect(second).toBe(first);
    expect(await stack.loop.runOnce()).toBe(1);
    expect(listRecentLlmCalls(context.handle, 10)).toHaveLength(1);
  });
});
