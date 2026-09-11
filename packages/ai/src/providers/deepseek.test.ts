import {
  createManualClock,
  MissingCredentialError,
  TransientError,
  ValidationError,
} from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findPrice } from '../pricing';
import { createLlmProvider, DeepSeekProvider, type DeepSeekProviderOptions } from './deepseek';
import type { FetchLike } from './openai-compatible';

/**
 * Le fournisseur DeepSeek est testé **sans réseau** : `fetch` est injecté, donc le
 * client réel (URL, en-têtes, corps JSON, mapping de l'usage, traduction des
 * erreurs) est exercé pour de vrai, mais aucun jeton n'est dépensé et aucun test
 * ne dépend d'un service tiers (docs/09 §1.1, §2 famille 6).
 */

const CLOCK = createManualClock(Date.UTC(2026, 2, 10, 12, 0, 0));
const CTX = { agent: 'interviewer', task: 'converse' };
const Schema = z.object({ reply: z.string().min(1) });

function completion(content: string): string {
  return JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1_000, completion_tokens: 200, prompt_cache_hit_tokens: 400 },
  });
}

interface RecordedCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(responses: Array<{ status?: number; body: string } | Error>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse(init.body || '{}') as unknown,
      headers: init.headers,
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return {
      ok: (next?.status ?? 200) < 400,
      status: next?.status ?? 200,
      text: async () => next?.body ?? '',
    };
  };
  return { fetchImpl, calls };
}

function provider(options: Partial<DeepSeekProviderOptions> = {}): DeepSeekProvider {
  return new DeepSeekProvider({
    apiKey: 'sk-test',
    clock: CLOCK,
    fetchImpl: stubFetch([{ body: completion(JSON.stringify({ reply: 'ok' })) }]).fetchImpl,
    ...options,
  });
}

describe('provider DeepSeek (docs/02 §9.1, docs/08 §7.3)', () => {
  it('n’expose jamais DeepSeek au domaine : il n’est qu’un `LLMProvider`', () => {
    const instance = provider();
    expect(instance.id).toBe('deepseek:deepseek-chat');
    expect(instance.capabilities().jsonMode).toBe(true);
  });

  it('envoie une requête compatible OpenAI avec le mode JSON et calcule le coût', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: completion(JSON.stringify({ reply: 'Bonjour' })) },
    ]);
    const instance = new DeepSeekProvider({ apiKey: 'sk-test', clock: CLOCK, fetchImpl });

    const result = await instance.structuredOutput('Tu es un intervieweur.', Schema, {}, CTX);
    expect(result.data.reply).toBe('Bonjour');
    expect(result.repaired).toBe(false);

    const call = calls[0]!;
    expect(call.url).toBe('https://api.deepseek.com/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer sk-test');
    const body = call.body as { model: string; response_format: unknown; stream: boolean };
    expect(body.model).toBe('deepseek-chat');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.stream).toBe(false);

    // Le cache d'entrée se facture moins cher que les jetons d'entrée standards.
    const price = findPrice('deepseek', 'deepseek-chat');
    const expectedUsd =
      (600 * price.inputPerMillionUsd +
        400 * price.cachedInputPerMillionUsd +
        200 * price.outputPerMillionUsd) /
      1_000_000;
    expect(result.usage.costUsd).toBeCloseTo(expectedUsd, 10);
    expect(result.usage.cachedTokens).toBe(400);
  });

  it('répare une sortie invalide par **un** appel de correction, puis échoue explicitement', async () => {
    const { fetchImpl, calls } = stubFetch([
      { body: completion('pas du JSON du tout') },
      { body: completion(JSON.stringify({ reply: 'Réponse corrigée' })) },
    ]);
    const instance = new DeepSeekProvider({ apiKey: 'sk-test', clock: CLOCK, fetchImpl });

    const repaired = await instance.structuredOutput('prompt', Schema, {}, CTX);
    expect(repaired.repaired).toBe(true);
    expect(repaired.data.reply).toBe('Réponse corrigée');
    expect(calls).toHaveLength(2);

    const failing = provider({
      fetchImpl: stubFetch([{ body: completion('toujours pas du JSON') }]).fetchImpl,
    });
    await expect(failing.structuredOutput('prompt', Schema, {}, CTX)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('traduit les statuts HTTP en catégories d’erreur, jamais en codes de fournisseur', async () => {
    const cases: Array<{ status: number; expected: unknown }> = [
      { status: 401, expected: MissingCredentialError },
      { status: 429, expected: { category: 'transient', code: 'RATE_LIMITED' } },
      { status: 503, expected: TransientError },
    ];

    for (const item of cases) {
      const instance = provider({
        fetchImpl: stubFetch([{ status: item.status, body: '{"error":"refus"}' }]).fetchImpl,
      });
      const rejection = instance.generate('p', {}, CTX);
      if (typeof item.expected === 'function') {
        await expect(rejection).rejects.toBeInstanceOf(item.expected as never);
      } else {
        await expect(rejection).rejects.toMatchObject(item.expected as object);
      }
    }
  });

  it('refuse d’appeler sans clé, mais ne bloque pas le démarrage de l’application', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: completion('{}') }]);
    const instance = new DeepSeekProvider({ apiKey: null, clock: CLOCK, fetchImpl });

    await expect(instance.generate('p', {}, CTX)).rejects.toBeInstanceOf(MissingCredentialError);
    expect(calls).toHaveLength(0);
    expect(await instance.healthCheck()).toEqual({ ok: false, error: 'clé API absente' });
  });

  it('ne se bloque jamais indéfiniment : une coupure réseau devient `LLM_PROVIDER_ERROR`', async () => {
    const instance = provider({
      fetchImpl: stubFetch([new Error('socket hang up')]).fetchImpl,
    });
    await expect(instance.generate('p', {}, CTX)).rejects.toMatchObject({
      code: 'LLM_PROVIDER_ERROR',
      category: 'transient',
    });
  });

  it('refuse un fournisseur sans tarif daté plutôt que de deviner son prix', () => {
    expect(() =>
      createLlmProvider({ providerId: 'openai', apiKey: 'x', model: null, clock: CLOCK }),
    ).toThrow(/PRICE_TABLE/);

    const ollama = createLlmProvider({
      providerId: 'ollama',
      apiKey: null,
      model: null,
      clock: CLOCK,
      localBaseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(ollama.id).toBe('ollama:llama3.1');
  });
});
