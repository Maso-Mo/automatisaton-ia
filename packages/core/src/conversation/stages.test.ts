import { describe, expect, it } from 'vitest';
import { ValidationError } from '@aia/shared';
import {
  MIN_VERIFIED_FACTS_FOR_BRIEF,
  SLOT_GUIDANCE,
  assertStageTransition,
  canTransitionStage,
  computeMissingSlots,
  nextStage,
} from './stages';
import type { ConversationMemorySnapshot } from './types';

/**
 * Les lacunes et la phase courante sont la **clé du produit** : c'est ce qui
 * évite de poser une question dont la réponse est déjà en base (docs/03 §7.1).
 * Ces règles sont locales, donc gratuites et testables sans base ni modèle.
 */

function snapshot(overrides: Partial<ConversationMemorySnapshot> = {}): ConversationMemorySnapshot {
  return {
    projectId: 'p1',
    projectName: 'Projet',
    positioning: null,
    targetGoal: null,
    verifiedFacts: 0,
    skillFacts: 0,
    audienceProfiles: 0,
    styleProfiles: 0,
    goals: 0,
    ...overrides,
  };
}

describe('lacunes et phases de l’entretien (docs/03 §7.1, docs/05 §3.1)', () => {
  it('liste les lacunes dans l’ordre documenté des phases', () => {
    expect(computeMissingSlots(snapshot())).toEqual([
      'skills',
      'positioning',
      'audience',
      'voice',
      'facts',
      'strategy',
    ]);
  });

  it('ne signale jamais une information déjà en mémoire', () => {
    const missing = computeMissingSlots(
      snapshot({
        skillFacts: 2,
        positioning: 'Automatiser sa facturation',
        audienceProfiles: 1,
        styleProfiles: 1,
        verifiedFacts: 3,
        targetGoal: '500 abonnés LinkedIn',
      }),
    );
    expect(missing).toEqual([]);
  });

  it('exige un minimum de faits confirmés, pas un fait isolé', () => {
    expect(
      computeMissingSlots(snapshot({ verifiedFacts: MIN_VERIFIED_FACTS_FOR_BRIEF - 1 })),
    ).toContain('facts');
    expect(
      computeMissingSlots(snapshot({ verifiedFacts: MIN_VERIFIED_FACTS_FOR_BRIEF })),
    ).not.toContain('facts');
  });

  it('conserve l’ordre des phases même quand plusieurs informations manquent', () => {
    // L'audience existe, la voix manque : la lacune courante reste « voice »,
    // pas « skills » (déjà là) ni « facts » (plus loin dans l'ordre).
    const missing = computeMissingSlots(
      snapshot({ skillFacts: 1, positioning: 'Position', audienceProfiles: 1, verifiedFacts: 5 }),
    );
    expect(missing).toEqual(['voice', 'strategy']);
  });

  it('désigne la phase par la première lacune, et `strategy` quand tout est là', () => {
    expect(nextStage(['audience'], { hasBrief: false })).toBe('audience');
    expect(nextStage(['facts'], { hasBrief: true })).toBe('fact_extraction');
    expect(nextStage([], { hasBrief: false })).toBe('strategy');
    expect(nextStage([], { hasBrief: true })).toBe('brief_ready');
    expect(nextStage([], { hasBrief: true, closed: true })).toBe('closed');
  });

  it('interdit de rouvrir un entretien terminé sans geste explicite', () => {
    expect(canTransitionStage('closed', 'brief_ready')).toBe(true);
    expect(canTransitionStage('closed', 'intake')).toBe(false);
    expect(() => assertStageTransition('closed', 'intake')).toThrow(ValidationError);

    // Une phase peut reculer : un fait invalidé rouvre la phase de faits.
    expect(() => assertStageTransition('brief_ready', 'fact_extraction')).not.toThrow();
  });

  it('donne une trame locale pour chaque lacune, jamais une question inventée', () => {
    for (const guidance of Object.values(SLOT_GUIDANCE)) {
      expect(guidance.length).toBeGreaterThan(20);
    }
  });
});
