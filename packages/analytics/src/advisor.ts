import type { PatternStatus } from './viral-pattern-engine';

export interface AdvisorPattern {
  id: string;
  platform: string;
  niche: string | null;
  contentType: string | null;
  feature: string;
  dimension: string;
  observedEffectPercent: number | null;
  confidenceX100: number;
  sampleSize: number;
  personalEvidence?: number;
  status: PatternStatus;
}

export interface PerformanceRecommendation {
  recommendation: string;
  reason: string;
  confidenceX100: number;
  evidenceIds: string[];
}

export class PerformanceAdvisor {
  advise(input: {
    platform: string;
    niche?: string | null;
    contentType?: string | null;
    patterns: readonly AdvisorPattern[];
    limit?: number;
  }): PerformanceRecommendation[] {
    return input.patterns
      .filter(
        (pattern) =>
          pattern.platform === input.platform &&
          pattern.status !== 'REJECTED' &&
          (pattern.niche === null || !input.niche || pattern.niche === input.niche) &&
          (pattern.contentType === null ||
            !input.contentType ||
            pattern.contentType === input.contentType),
      )
      .sort(
        (left, right) =>
          (right.personalEvidence ?? 0) - (left.personalEvidence ?? 0) ||
          right.confidenceX100 - left.confidenceX100,
      )
      .slice(0, input.limit ?? 5)
      .map((pattern) => ({
        recommendation: `${pattern.dimension} : ${pattern.feature}`,
        reason: `Associé à ${pattern.observedEffectPercent ?? 0}% de performance relative sur ${pattern.sampleSize} observations ; corrélation, pas causalité.`,
        confidenceX100: pattern.confidenceX100,
        evidenceIds: [pattern.id],
      }));
  }

  guidance(recommendations: readonly PerformanceRecommendation[], limit = 4): string[] {
    return recommendations
      .slice(0, limit)
      .map((item) => `${item.recommendation} — confiance ${item.confidenceX100}% (${item.reason})`);
  }
}
