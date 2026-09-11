import { interviewerOutputSchema } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import { createSystemClock } from '@aia/shared';
import { DeepSeekProvider } from './deepseek';

/**
 * Suite **live** : elle parle réellement à DeepSeek, donc elle consomme du budget
 * et dépend d'un service tiers. C'est exactement pour cela qu'elle est exclue de
 * l'exécution par défaut (`**\/*.live.test.ts`, docs/09 §1.2) : un test qui
 * consomme et qui dépend du réseau ne doit jamais bloquer un commit.
 *
 * Lancement :
 *
 * ```bash
 * DEEPSEEK_API_KEY=sk-... DEEPSEEK_MODEL=deepseek-chat pnpm test:live
 * ```
 *
 * Ce que ce test apporte qu'aucun test simulé n'apporte : la **preuve** que le
 * contrat `LLMProvider` fonctionne avec le vrai fournisseur — le mode JSON réel,
 * la forme exacte de `usage`, et le coût réel par appel (critère de sortie de
 * l'étape : « un coût mesuré connu »).
 */

const apiKey = process.env.DEEPSEEK_API_KEY ?? '';
const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';

describe.skipIf(apiKey.length === 0)('DeepSeek réel (suite live)', () => {
  it('respecte le schéma de l’intervieweur et renvoie un coût mesuré', async () => {
    const provider = new DeepSeekProvider({ apiKey, model, clock: createSystemClock() });

    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);

    const prompt = [
      'Tu es un intervieweur de projet. Réponds STRICTEMENT en JSON avec les clés :',
      'reply, message_type, question_options, extracted_facts, skill_deltas, project_edits,',
      'proposed_audiences, proposed_style, open_questions, suggested_next.',
      '',
      'Message de l’utilisateur : « J’ai automatisé 12 factures avec n8n. »',
      'Propose un fait unique dont la source_quote est un extrait littéral du message.',
    ].join('\n');

    const result = await provider.structuredOutput(
      prompt,
      interviewerOutputSchema,
      { maxOutputTokens: 900 },
      { agent: 'interviewer', task: 'converse', conversationId: 'live-test' },
    );

    expect(result.data.reply.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.usage.costMicroUsd).toBeGreaterThanOrEqual(0);

    // Le coût réel est **journalisé** : c'est la mesure qui permet de trancher
    // les décisions de modèles (docs/10 §4.3, décision D2).
    console.log(
      `coût mesuré : ${result.usage.costMicroUsd} µUSD · ${result.usage.inputTokens} in → ${result.usage.outputTokens} out · ${result.usage.latencyMs} ms · réparé=${result.repaired}`,
    );
  }, 120_000);
});
