import { describe, expect, it } from 'vitest';
import { PerformanceAdvisor } from './advisor';

describe('PerformanceAdvisor', () => {
  it('filtre le contexte, privilégie les preuves personnelles et expose les raisons', () => {
    const recommendations = new PerformanceAdvisor().advise({
      platform: 'linkedin',
      niche: 'dev',
      contentType: 'post',
      patterns: [
        {
          id: 'public',
          platform: 'linkedin',
          niche: null,
          contentType: 'post',
          feature: 'question',
          dimension: 'hook_type',
          observedEffectPercent: 30,
          confidenceX100: 90,
          sampleSize: 80,
          personalEvidence: 0,
          status: 'SUPPORTED',
        },
        {
          id: 'mine',
          platform: 'linkedin',
          niche: 'dev',
          contentType: 'post',
          feature: 'result_first',
          dimension: 'hook_type',
          observedEffectPercent: 20,
          confidenceX100: 70,
          sampleSize: 20,
          personalEvidence: 8,
          status: 'LIKELY',
        },
        {
          id: 'rejected',
          platform: 'linkedin',
          niche: 'dev',
          contentType: 'post',
          feature: 'link',
          dimension: 'format',
          observedEffectPercent: -20,
          confidenceX100: 60,
          sampleSize: 30,
          status: 'REJECTED',
        },
      ],
    });
    expect(recommendations.map((item) => item.evidenceIds[0])).toEqual(['mine', 'public']);
    expect(recommendations[0]?.reason).toContain('corrélation, pas causalité');
  });
});
