import { BudgetExceededError, createManualClock } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findPrice } from './pricing';
import { ScriptedLLMProvider, parseWithRepair } from './providers/scripted';
import { createInMemoryLlmCallRecorder, fingerprintContext } from './recorder';
import { withRecording } from './recording-provider';

const clock = createManualClock(Date.UTC(2026, 2, 10, 12, 0, 0));
const price = findPrice('deepseek', 'deepseek-chat');

function makeProvider(
  overrides: Partial<ConstructorParameters<typeof ScriptedLLMProvider>[0]> = {},
) {
  return new ScriptedLLMProvider({ model: 'deepseek-chat', price, clock, ...overrides });
}

describe('appel enregistré et coût calculé (docs/02 §9.1)', () => {
  it('journalise chaque appel avec son agent, sa tâche et son coût', async () => {
    const recorder = createInMemoryLlmCallRecorder();
    const provider = withRecording(makeProvider({ text: 'bonjour' }), { recorder, clock });

    const result = await provider.generate(
      'question courte',
      {},
      { agent: 'system', task: 'noop' },
    );

    expect(result.text).toBe('bonjour');
    expect(recorder.entries).toHaveLength(1);
    const entry = recorder.entries[0];
    expect(entry?.agent).toBe('system');
    expect(entry?.task).toBe('noop');
    expect(entry?.status).toBe('success');
    expect(entry?.costMicroUsd).toBe(result.usage.costMicroUsd);
    expect(entry?.costMicroUsd).toBeGreaterThan(0);
    expect(entry?.contextFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('cumule le coût sur le job via le rappel `onCost`', async () => {
    const recorder = createInMemoryLlmCallRecorder();
    const costs: number[] = [];
    const provider = withRecording(makeProvider(), {
      recorder,
      clock,
      onCost: (microUsd) => {
        costs.push(microUsd);
      },
    });

    await provider.generate('a', {}, { agent: 'system', task: 'noop' });
    await provider.generate('b', {}, { agent: 'system', task: 'noop' });
    expect(costs).toHaveLength(2);
    expect(costs[0]).toBeGreaterThan(0);
  });

  it('refuse l’appel avant de dépenser quand le budget est épuisé', async () => {
    const recorder = createInMemoryLlmCallRecorder();
    const inner = makeProvider();
    const provider = withRecording(inner, {
      recorder,
      clock,
      budget: () => ({ remainingMicroUsd: 0, hardStop: true, periodLabel: 'journalier' }),
    });

    await expect(
      provider.generate('une question un peu longue', {}, { agent: 'system', task: 'noop' }),
    ).rejects.toThrow(BudgetExceededError);

    // Rien n'a été envoyé et rien n'est facturé : le veto agit avant l'appel.
    expect(inner.calls).toHaveLength(0);
    expect(recorder.entries).toHaveLength(0);
  });

  it('journalise aussi un appel en erreur, avec un statut lisible et un coût nul', async () => {
    const recorder = createInMemoryLlmCallRecorder();
    const provider = withRecording(makeProvider({ mode: 'timeout' }), { recorder, clock });

    await expect(provider.generate('x', {}, { agent: 'system', task: 'noop' })).rejects.toThrow(
      /délai dépassé/,
    );

    expect(recorder.entries).toHaveLength(1);
    expect(recorder.entries[0]?.status).toBe('timeout');
    expect(recorder.entries[0]?.costMicroUsd).toBe(0);
    expect(recorder.entries[0]?.errorCode).toBe('LLM_TIMEOUT');
  });

  it('valide la sortie structurée et répare un emballage Markdown', async () => {
    const recorder = createInMemoryLlmCallRecorder();
    const provider = withRecording(makeProvider({ responses: ['```json\n{"ok":true}\n```'] }), {
      recorder,
      clock,
    });

    const schema = z.object({ ok: z.boolean() });
    const result = await provider.structuredOutput(
      'donne-moi du JSON',
      schema,
      {},
      {
        agent: 'system',
        task: 'noop',
      },
    );

    expect(result.data).toEqual({ ok: true });
    expect(result.repaired).toBe(true);
    expect(recorder.entries[0]?.status).toBe('success');
  });

  it('rejette une sortie non conforme au schéma', async () => {
    const provider = withRecording(makeProvider({ responses: ['{"ok":"peut-être"}'] }), {
      recorder: createInMemoryLlmCallRecorder(),
      clock,
    });
    const schema = z.object({ ok: z.boolean() });

    await expect(
      provider.structuredOutput('x', schema, {}, { agent: 'system', task: 'noop' }),
    ).rejects.toThrow(/non conforme au schéma/);
  });

  it('produit une empreinte de contexte stable', () => {
    expect(fingerprintContext({ a: 1, b: [1, 2] })).toBe(fingerprintContext({ b: [1, 2], a: 1 }));
    expect(fingerprintContext({ a: 1 })).not.toBe(fingerprintContext({ a: 2 }));
  });

  it('répare uniquement l’emballage, pas un JSON invalide', () => {
    expect(parseWithRepair('{"a":1}')).toEqual({ value: { a: 1 }, repaired: false });
    expect(parseWithRepair('```json\n{"a":1}\n```')).toEqual({ value: { a: 1 }, repaired: true });
    expect(() => parseWithRepair('{invalide}')).toThrow();
  });
});
