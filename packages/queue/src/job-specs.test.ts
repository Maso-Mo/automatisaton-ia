import { describe, expect, it } from 'vitest';
import {
  analyzePerformanceSpec,
  collectMetricsSpec,
  extractContentFeaturesSpec,
  generateContentSpec,
  rebuildPatternsSpec,
} from './job-specs';

describe('déduplication des générations', () => {
  it('ne perd pas une régénération ciblée lorsqu’une génération initiale mono-cible existe', () => {
    const initial = generateContentSpec.dedupeKey?.({
      projectId: 'p1',
      angleId: 'a1',
      targets: ['linkedin_post'],
      mode: 'initial',
      contentItemId: 'c1',
      instruction: null,
    });
    const regenerated = generateContentSpec.dedupeKey?.({
      projectId: 'p1',
      angleId: 'a1',
      targets: ['linkedin_post'],
      mode: 'regenerated',
      contentItemId: 'c1',
      instruction: 'Rendre plus concret.',
    });
    expect(initial).not.toBe(regenerated);
    expect(initial).toBe('content:initial:c1');
    expect(regenerated).toBe('content:regenerated:c1');
  });
});

describe('jobs analytics', () => {
  it('sont idempotents, retryables et dédupliqués par portée', () => {
    for (const spec of [
      collectMetricsSpec,
      analyzePerformanceSpec,
      extractContentFeaturesSpec,
      rebuildPatternsSpec,
    ]) {
      expect(spec.idempotent).toBe(true);
      expect(spec.maxAttempts).toBeGreaterThan(1);
      expect(spec.dedupeKey).toBeTypeOf('function');
    }
  });
});
