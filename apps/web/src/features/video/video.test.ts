import { describe, expect, it } from 'vitest';
import type { VideoAssetView, VideoCapabilitiesView, VideoPlanView } from '../../api/client';
import {
  buildPlanDraft,
  describeSource,
  formatMs,
  formatTimecodeInput,
  parseTimecode,
  planSummary,
  statusLabel,
  transcriptionBlocker,
} from './video';

/**
 * Les décisions d'affichage de l'écran de montage, testées **sans navigateur**
 * (docs/09 §6.2) : lecture d'un timecode, bornes du plan, blocages annoncés.
 */

function asset(overrides: Partial<VideoAssetView> = {}): VideoAssetView {
  return {
    id: 'asset-1',
    projectId: 'project-1',
    role: 'original',
    parentAssetId: null,
    storageKey: '202603/ab/asset-1.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 1_024,
    width: 1920,
    height: 1080,
    durationMs: 120_000,
    codec: 'h264',
    hasAudio: true,
    source: 'upload',
    createdAt: 0,
    transcript: { available: true, edited: false, language: 'fr', segments: 12 },
    ...overrides,
  };
}

describe('timecodes : ce que l’utilisateur tape, ce que le produit comprend', () => {
  it('accepte les secondes, les décimales et `m:ss`', () => {
    expect(parseTimecode('90')).toBe(90_000);
    expect(parseTimecode(' 12.5 ')).toBe(12_500);
    expect(parseTimecode('12,5')).toBe(12_500);
    expect(parseTimecode('1:30')).toBe(90_000);
    expect(parseTimecode('0:12.500')).toBe(12_500);
  });

  it('refuse ce qui est ambigu au lieu de deviner', () => {
    // `1:2:3` pourrait être des heures, des minutes ou une faute de frappe : se
    // tromper de minutes coûterait un rendu entier.
    expect(parseTimecode('1:2:3')).toBeNull();
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:2a')).toBeNull();
    expect(parseTimecode('-5')).toBeNull();
  });

  it('rend un timecode éditable et une durée lisible', () => {
    expect(formatTimecodeInput(12_500)).toBe('0:12.5');
    expect(formatTimecodeInput(90_000)).toBe('1:30.0');
    expect(formatMs(3_723_456)).toBe('62:03.456');
    expect(formatMs(null)).toBe('—');
  });
});

describe('bornes du plan, côté écran : un confort, pas une autorité', () => {
  const bounds = { sourceDurationMs: 120_000, maxClipMs: 60_000 };

  it('accepte un extrait dans les bornes', () => {
    expect(buildPlanDraft('0:10', '0:40', bounds)).toEqual({
      ok: true,
      plan: { startMs: 10_000, endMs: 40_000 },
    });
  });

  it('explique chaque refus, sans code technique', () => {
    expect(buildPlanDraft('oui', '0:40', bounds)).toMatchObject({ ok: false });
    expect(buildPlanDraft('0:40', '0:40', bounds)).toMatchObject({
      ok: false,
      error: 'La fin doit être postérieure au début.',
    });
    expect(buildPlanDraft('0:00', '3:00', bounds)).toMatchObject({
      ok: false,
      error: 'La fin dépasse la durée de la vidéo (2:00.000).',
    });
    expect(buildPlanDraft('0:00', '1:30', bounds)).toMatchObject({ ok: false });
  });
});

describe('ce que l’écran annonce avant d’agir', () => {
  it('décrit une vidéo avec ses mesures, jamais avec des suppositions', () => {
    expect(describeSource(asset())).toBe('1920×1080 · 2:00.000 · h264 · avec audio');
    expect(describeSource(asset({ width: null, height: null, hasAudio: false }))).toContain(
      'résolution inconnue',
    );
  });

  it('dit pourquoi un montage ne peut pas être proposé', () => {
    expect(transcriptionBlocker(asset())).toBeNull();
    expect(transcriptionBlocker(asset({ hasAudio: false }))).toContain('piste audio');
    expect(
      transcriptionBlocker(
        asset({ transcript: { available: false, edited: false, language: null, segments: 0 } }),
      ),
    ).toContain('Transcrire la vidéo');
    expect(
      transcriptionBlocker(
        asset({ transcript: { available: true, edited: false, language: 'fr', segments: 0 } }),
      ),
    ).toContain('aucun segment horodaté');
  });

  it('lit le libellé d’un statut dans le vocabulaire servi par l’API', () => {
    const capabilities = {
      renderStatuses: [{ value: 'rendering', label: 'Encodage' }],
    } as VideoCapabilitiesView;
    expect(statusLabel(capabilities, 'rendering')).toBe('Encodage');
    // Un statut inconnu de l'écran n'est jamais inventé : il est montré brut.
    expect(statusLabel(capabilities, 'mystere')).toBe('mystere');
    expect(statusLabel(undefined, 'queued')).toBe('queued');
  });

  it('résume un plan proposé en une ligne', () => {
    const plan = {
      plan: { startMs: 6_000, endMs: 26_000 },
    } as VideoPlanView;
    expect(planSummary(plan)).toBe('0:06.000 → 0:26.000 (0:20.000)');
  });
});
