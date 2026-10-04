import { describe, expect, it } from 'vitest';
import { extractContentFeatures } from './features';
import { ViralPatternEngine, type PerformanceObservation } from './viral-pattern-engine';

const engine = new ViralPatternEngine();

function dataset(count: number, effect = false): PerformanceObservation[] {
  return Array.from({ length: count }, (_, index) => {
    const subtitles = index < count / 2;
    return {
      id: `o-${index}`,
      projectId: 'p1',
      platform: 'tiktok',
      niche: 'dev/IA',
      contentType: 'short_video',
      origin: index % 4 === 0 ? 'personal' : 'external',
      features: extractContentFeatures({
        body: subtitles ? 'Voici le résultat. Comment faire ?' : 'Une explication simple.',
        subtitleGenerated: subtitles,
      }),
      relativePerformanceX100: effect && subtitles ? 160 : 100,
      qualityX100: 90,
      observedAt: index + 1,
    };
  });
}

describe('ViralPatternEngine', () => {
  it('évite le biais du survivant quand gagnants et baseline sont identiques', () => {
    const subtitle = engine
      .analyze(dataset(100))
      .find((pattern) => pattern.dimension === 'has_subtitles' && pattern.feature === 'true');
    expect(subtitle?.observedEffectPercent).toBe(0);
    expect(subtitle?.status).toBe('REJECTED');
  });

  it('détecte une association réelle sans en faire une causalité', () => {
    const subtitle = engine
      .analyze(dataset(100, true))
      .find((pattern) => pattern.dimension === 'has_subtitles' && pattern.feature === 'true');
    expect(subtitle?.observedEffectPercent).toBe(60);
    expect(subtitle?.status).toBe('SUPPORTED');
    expect(subtitle?.baselineSampleSize).toBe(50);
  });

  it.each([
    [0, undefined],
    [3, undefined],
    [20, 'LIKELY'],
    [100, 'SUPPORTED'],
  ] as const)('fait évoluer le cold start pour %i observations', (count, status) => {
    const pattern = engine
      .analyze(dataset(count, true))
      .find((item) => item.dimension === 'has_subtitles' && item.feature === 'true');
    expect(pattern?.status).toBe(status);
  });

  it('donne davantage de poids aux performances personnelles', () => {
    const rows = dataset(20, true);
    const personal = rows.map((row, index) => ({
      ...row,
      origin: index < 10 ? ('personal' as const) : ('external' as const),
      relativePerformanceX100: index < 10 ? 200 : row.relativePerformanceX100,
    }));
    const publicOnly = rows.map((row) => ({ ...row, origin: 'external' as const }));
    const personalEffect = engine
      .analyze(personal)
      .find((item) => item.dimension === 'has_subtitles' && item.feature === 'true')!;
    const publicEffect = engine
      .analyze(publicOnly)
      .find((item) => item.dimension === 'has_subtitles' && item.feature === 'true')!;
    expect(personalEffect.observedEffectPercent).toBeGreaterThan(
      publicEffect.observedEffectPercent,
    );
  });
});
