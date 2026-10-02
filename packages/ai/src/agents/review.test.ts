import { describe, expect, it } from 'vitest';
import { createManualClock } from '@aia/shared';
import { ScriptedLLMProvider } from '../providers/scripted';
import { createCriticAgent, createFactCheckerAgent } from './review';

const usagePrice = {
  provider: 'scripted',
  model: 'review',
  inputPerMillionUsd: 1,
  cachedInputPerMillionUsd: 1,
  outputPerMillionUsd: 1,
  effectiveFrom: '2026-01-01',
  verified: true,
};
const prompt = { promptVersionId: 'p1', filePath: 'test.md', body: 'Consigne de test.' };

describe('agents critic et fact_checker', () => {
  it('le critic juge sans jamais fournir de texte de remplacement', async () => {
    const provider = new ScriptedLLMProvider({
      model: 'review',
      price: usagePrice,
      clock: createManualClock(0),
      text: JSON.stringify({
        verdict: 'revise',
        score: 42,
        notes: [
          {
            type: 'clickbait',
            severity: 'haute',
            message: 'La promesse dépasse le corps.',
            anchor_text: 'Incroyable résultat',
          },
        ],
        repetition_report: 'Aucune répétition.',
      }),
    });
    const result = await createCriticAgent({ provider, prompt }).run(
      {
        platform: 'linkedin',
        title: null,
        hook: 'Incroyable résultat',
        body: 'Un texte suffisamment long pour être jugé.',
        recentPublishedBodies: [],
      },
      { callContext: { agent: 'critic', task: 'review' } },
    );
    expect(result.output.verdict).toBe('revise');
    expect(result.output.notes[0]?.type).toBe('clickbait');
    expect(result.output).not.toHaveProperty('rewrite');
  });

  it('le fact_checker extrait des claims structurés sans les promouvoir lui-même en faits', async () => {
    const provider = new ScriptedLLMProvider({
      model: 'review',
      price: usagePrice,
      clock: createManualClock(0),
      text: JSON.stringify({
        claims: [
          {
            text: 'Le gain est de 70 %.',
            claim_type: 'chiffre',
            verifiability: 'verifiable',
            risk: 'eleve',
            status: 'needs_user_confirmation',
            evidence: null,
            evidence_source: 'none',
          },
        ],
      }),
    });
    const result = await createFactCheckerAgent({ provider, prompt }).run(
      { title: null, hook: null, body: 'Le gain est de 70 %.', facts: [] },
      { callContext: { agent: 'fact_checker', task: 'assess' } },
    );
    expect(result.output.claims[0]).toMatchObject({
      risk: 'eleve',
      status: 'needs_user_confirmation',
    });
  });
});
