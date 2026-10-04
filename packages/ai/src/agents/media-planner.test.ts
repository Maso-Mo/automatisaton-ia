import { describe, expect, it } from 'vitest';
import { createManualClock } from '@aia/shared';
import { ScriptedLLMProvider } from '../providers/scripted';
import {
  buildMediaPlannerPrompt,
  createMediaPlannerAgent,
  MEDIA_PLANNER_MAX_SEGMENTS,
  type MediaPlannerInput,
} from './media-planner';

/**
 * `media_planner` (docs/04 §4.7) : l'agent qui **propose** un extrait.
 *
 * Deux choses se prouvent ici, et rien d'autre : ce qu'on lui envoie, et ce
 * qu'on refuse de lui. Le fournisseur est scripté (`ScriptedLLMProvider`), donc
 * aucun appel réseau, aucun coût (docs/09 §1.1).
 */

const usagePrice = {
  provider: 'scripted',
  model: 'video_plan',
  inputPerMillionUsd: 1,
  cachedInputPerMillionUsd: 1,
  outputPerMillionUsd: 1,
  effectiveFrom: '2026-01-01',
  verified: true,
};
const prompt = {
  promptVersionId: 'p1',
  filePath: 'media_planner/video_plan.md',
  body: 'Consigne.',
};

function input(overrides: Partial<MediaPlannerInput> = {}): MediaPlannerInput {
  return {
    script: 'Voici comment j’automatise ma facturation avec n8n, étape par étape.',
    transcript: {
      text: 'Voici comment j’automatise ma facturation',
      segments: [
        { startMs: 2_000, endMs: 6_000, text: 'Voici comment j’automatise ma facturation' },
      ],
    },
    video: { durationMs: 120_000, width: 1920, height: 1080, hasAudio: true },
    maxClipMs: 60_000,
    targetLabel: 'tiktok_short',
    ...overrides,
  };
}

function providerWith(text: string): ScriptedLLMProvider {
  return new ScriptedLLMProvider({
    model: 'video_plan',
    price: usagePrice,
    clock: createManualClock(0),
    text,
  });
}

describe('ce que l’agent reçoit : le contexte disponible, rien de plus', () => {
  it('reçoit les recommandations vidéo sans qu’elles dépassent les contraintes', () => {
    const built = buildMediaPlannerPrompt(
      input({ performanceGuidance: ['hook avant 2 s', 'cuts toutes les 3 s'] }),
    );
    expect(built).toContain('PERFORMANCE GUIDANCE');
    expect(built).toContain('hook avant 2 s');
    expect(built.indexOf('PERFORMANCE GUIDANCE')).toBeLessThan(
      built.indexOf('Contraintes non négociables'),
    );
  });

  it('transmet durée, résolution, audio, texte approuvé et segments horodatés', () => {
    const built = buildMediaPlannerPrompt(input());
    expect(built).toContain('Durée totale : 120.0 s');
    expect(built).toContain('1920×1080');
    expect(built).toContain('avec audio');
    expect(built).toContain('Durée maximale de l’extrait : 60.0 s');
    expect(built).toContain('Voici comment j’automatise ma facturation');
    expect(built).toContain('[2.0 → 6.0]');
  });

  it('rappelle les seules valeurs acceptées, et interdit la détection de moment fort', () => {
    const built = buildMediaPlannerPrompt(input());
    expect(built).toContain('`subtitleMode` vaut `burned`');
    expect(built).toContain('`crop` vaut `vertical_center`');
    expect(built).not.toContain('score');
    expect(built).not.toContain('musique');
  });

  it('dit l’absence plutôt que d’inventer : pas de transcription, pas de sous-titres', () => {
    const built = buildMediaPlannerPrompt(
      input({ transcript: { text: '', segments: [] }, script: '' }),
    );
    expect(built).toContain('Aucun segment transcrit : aucun sous-titre n’est possible.');
    expect(built).toContain('Aucun texte approuvé fourni.');
  });

  it('borne l’entrée : un long transcript ne part pas entier', () => {
    const segments = Array.from({ length: MEDIA_PLANNER_MAX_SEGMENTS + 40 }, (_, index) => ({
      startMs: index * 1_000,
      endMs: index * 1_000 + 900,
      text: `Réplique ${index}`,
    }));
    const built = buildMediaPlannerPrompt(input({ transcript: { text: 'x', segments } }));
    expect(built).toContain(`Réplique ${MEDIA_PLANNER_MAX_SEGMENTS - 1}`);
    expect(built).not.toContain(`Réplique ${MEDIA_PLANNER_MAX_SEGMENTS + 5}`);
  });
});

describe('ce que l’agent a le droit de rendre : le schéma tranche', () => {
  it('accepte un plan conforme, y compris la provenance n’est pas de son ressort', async () => {
    const agent = createMediaPlannerAgent({
      provider: providerWith(
        JSON.stringify({
          startMs: 2_000,
          endMs: 32_000,
          subtitleMode: 'burned',
          crop: 'vertical_center',
          reason: 'Extrait qui explique la première étape de l’automatisation.',
        }),
      ),
      prompt,
    });
    const result = await agent.run(input(), {
      callContext: { agent: 'media_planner', task: 'video_plan' },
    });
    expect(result.output.startMs).toBe(2_000);
    expect(result.output.endMs).toBe(32_000);
    // `source` est ajouté par le domaine, jamais par le modèle.
    expect(result.output).not.toHaveProperty('source');
  });

  it('refuse un timecode inversé ou un extrait trop court', async () => {
    const run = (plan: Record<string, unknown>) =>
      createMediaPlannerAgent({ provider: providerWith(JSON.stringify(plan)), prompt }).run(
        input(),
        {
          callContext: { agent: 'media_planner', task: 'video_plan' },
        },
      );

    const base = {
      subtitleMode: 'burned',
      crop: 'vertical_center',
      reason: 'Extrait proposé pour illustrer le propos principal du texte.',
    };
    await expect(run({ ...base, startMs: 10_000, endMs: 5_000 })).rejects.toBeTruthy();
    await expect(run({ ...base, startMs: 0, endMs: 400 })).rejects.toBeTruthy();
  });

  it('refuse un sous-titre externe et un recadrage mobile : l’étape ne sait faire que le format unique', async () => {
    const run = (plan: Record<string, unknown>) =>
      createMediaPlannerAgent({ provider: providerWith(JSON.stringify(plan)), prompt }).run(
        input(),
        {
          callContext: { agent: 'media_planner', task: 'video_plan' },
        },
      );

    await expect(
      run({
        startMs: 0,
        endMs: 10_000,
        subtitleMode: 'srt',
        crop: 'face_tracking',
        reason: 'Extrait proposé pour illustrer le propos principal du texte.',
      }),
    ).rejects.toBeTruthy();
  });

  it('refuse une raison trop courte : elle doit dire *pourquoi*', async () => {
    await expect(
      createMediaPlannerAgent({
        provider: providerWith(
          JSON.stringify({
            startMs: 0,
            endMs: 10_000,
            subtitleMode: 'burned',
            crop: 'vertical_center',
            reason: 'court',
          }),
        ),
        prompt,
      }).run(input(), { callContext: { agent: 'media_planner', task: 'video_plan' } }),
    ).rejects.toBeTruthy();
  });
});
