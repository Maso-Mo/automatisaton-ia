import { describe, expect, it } from 'vitest';
import { extractContentFeatures } from './features';

describe('extraction déterministe de caractéristiques', () => {
  it('extrait hook, structure, CTA et signaux vidéo sans réseau', () => {
    const features = extractContentFeatures({
      hook: 'Comment obtenir ce résultat ?',
      body: 'Voici le résultat. Étape 1. Étape 2. Et vous, qu’en pensez-vous ?',
      durationMs: 10_000,
      fps: 30,
      subtitleGenerated: true,
      sceneChangesMs: [0, 2_000, 5_000, 9_000],
      transcriptSegments: [
        { startMs: 0, endMs: 2_000, text: 'Voici.' },
        { startMs: 3_000, endMs: 7_000, text: 'La suite.' },
      ],
    });
    expect(features.hookType).toBe('question');
    expect(features.structure).toBe('list');
    expect(features.ctaType).toBe('question');
    expect(features.hasSubtitles).toBe(true);
    expect(features.sceneChangeCount).toBe(4);
    expect(features.speechDensityX100).toBe(60);
    expect(features.averagePhraseDurationMs).toBe(3_000);
  });
});
