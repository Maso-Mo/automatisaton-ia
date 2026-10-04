import { describe, expect, it } from 'vitest';
import { classifyPerformance, deriveMetrics, percentileOf } from './performance';

describe('métriques de performance', () => {
  it('préserve les métriques absentes au lieu de les transformer en zéro', () => {
    const result = deriveMetrics({
      metrics: { views: 1_000, likes: 50 },
      publishedAt: 0,
      capturedAt: 3_600_000,
    });
    expect(result.engagementRateX10000).toBe(500);
    expect(result.shareRateX10000).toBeNull();
    expect(result.ctrX10000).toBeNull();
  });

  it('calcule vitesse, performance relative et percentile avec une référence explicite', () => {
    const result = deriveMetrics({
      metrics: { views: 800, followersAtPublish: 1_000 },
      publishedAt: 0,
      capturedAt: 6 * 3_600_000,
      previous: { views: 200, capturedAt: 2 * 3_600_000 },
      baselineMedian: 0.4,
      baselineValues: [0.1, 0.2, 0.4, 0.5],
    });
    expect(result.viewVelocityX100).toBe(15_000);
    expect(result.relativePerformanceX100).toBe(200);
    expect(result.percentileX100).toBe(10_000);
    expect(percentileOf(0.4, [0.1, 0.4, 0.8])).toBe(5_000);
  });

  it('classe relativement et réserve VIRAL aux références suffisantes', () => {
    expect(classifyPerformance(null, 100).classification).toBe('NORMAL');
    expect(classifyPerformance(50, 20).classification).toBe('UNDERPERFORMING');
    expect(classifyPerformance(180, 20).classification).toBe('STRONG');
    expect(classifyPerformance(600, 20).classification).toBe('BREAKOUT');
    expect(classifyPerformance(600, 50).classification).toBe('VIRAL');
    expect(classifyPerformance(600, 2).reason).toContain('insuffisante');
  });
});
