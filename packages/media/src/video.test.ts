import { describe, expect, it } from 'vitest';
import {
  assertSupportedVideoProbe,
  buildVerticalShortArgs,
  defaultRenderPlan,
  describeRenderPlan,
  detectVideoContainer,
  formatMs,
  hasSpeechInWindow,
  renderPlanWarnings,
  renderStorageKey,
  validateRenderPlan,
  videoStorageKey,
} from './video';
import { SUBTITLE_FILE_NAME } from './subtitles';
import type { MediaProbe } from './ffmpeg';

/**
 * La partie **pure** du pipeline vidéo (étape 7) : reconnaissance du conteneur,
 * vérification de ce que `ffprobe` a mesuré, bornes du plan, avertissements et
 * plan de repli.
 *
 * Ces tests ne lancent ni FFmpeg ni le réseau (docs/09 §1.1) : le graphe de
 * filtres est l'endroit où une erreur coûte des minutes d'encodage, et un test
 * qui l'exécuterait vraiment serait trop lent pour tourner à chaque modification
 * — donc il ne tournerait pas.
 */

/** Un MP4 minimal : `....ftypisom` (la marque décide du conteneur, pas le nom). */
function mp4Fixture(brand = 'isom'): Uint8Array {
  return Buffer.from(`\x00\x00\x00\x20ftyp${brand}\x00\x00\x00\x00`, 'binary');
}

const WEBM_HEADER = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

function probe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    durationMs: 12_000,
    width: 1_920,
    height: 1_080,
    videoCodec: 'h264',
    audioCodec: 'aac',
    container: 'mov,mp4,m4a,3gp,3g2,mj2',
    hasAudio: true,
    fps: 3_000,
    sizeBytes: 1_024,
    ...overrides,
  };
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('l’appel aurait dû échouer');
}

describe('conteneur vidéo : le contenu décide, jamais le nom (docs/05 §5.1)', () => {
  it('reconnaît MP4, MOV et WebM par leur signature', () => {
    expect(detectVideoContainer(mp4Fixture(), 'video/mp4')).toEqual({
      extension: 'mp4',
      mime: 'video/mp4',
    });
    expect(detectVideoContainer(mp4Fixture('qt  '), 'video/quicktime').extension).toBe('mov');
    expect(detectVideoContainer(WEBM_HEADER, 'video/webm').extension).toBe('webm');
  });

  it('accepte un type déclaré générique, refuse un type qui contredit le contenu', () => {
    expect(detectVideoContainer(mp4Fixture(), 'application/octet-stream').extension).toBe('mp4');
    expect(codeOf(() => detectVideoContainer(WEBM_HEADER, 'video/mp4'))).toBe(
      'VIDEO_MIME_MISMATCH',
    );
  });

  it('refuse un fichier trop court, un format inconnu et une image renommée', () => {
    expect(codeOf(() => detectVideoContainer(new Uint8Array([1, 2, 3]), 'video/mp4'))).toBe(
      'VIDEO_FORMAT_UNSUPPORTED',
    );
    expect(codeOf(() => detectVideoContainer(Buffer.alloc(64, 0x41), 'video/mp4'))).toBe(
      'VIDEO_FORMAT_UNSUPPORTED',
    );
    const png = Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', 'binary');
    expect(codeOf(() => detectVideoContainer(png, 'video/mp4'))).toBe('VIDEO_FORMAT_UNSUPPORTED');
  });
});

describe('ce que ffprobe a mesuré (docs/10 §4.7)', () => {
  it('accepte H.264 avec une durée exploitable', () => {
    expect(() => assertSupportedVideoProbe(probe())).not.toThrow();
  });

  it('nomme le codec refusé au lieu de convertir en silence', () => {
    expect(codeOf(() => assertSupportedVideoProbe(probe({ videoCodec: 'hevc' })))).toBe(
      'VIDEO_CODEC_UNSUPPORTED',
    );
    expect(codeOf(() => assertSupportedVideoProbe(probe({ videoCodec: null })))).toBe(
      'VIDEO_STREAM_MISSING',
    );
  });

  it('refuse une durée indéterminée', () => {
    expect(codeOf(() => assertSupportedVideoProbe(probe({ durationMs: null })))).toBe(
      'VIDEO_DURATION_UNKNOWN',
    );
  });
});

describe('clés de stockage : fabriquées par le serveur', () => {
  it('range la source par mois et par préfixe d’empreinte', () => {
    const key = videoStorageKey(
      'ab'.repeat(32),
      '0197c0de-0000-7000-8000-000000000000',
      'mp4',
      new Date(Date.UTC(2026, 2, 10)),
    );
    expect(key).toBe('202603/ab/0197c0de-0000-7000-8000-000000000000.mp4');
    expect(key).not.toContain('..');
  });

  it('range le rendu sous renders/, avec l’extension du format unique', () => {
    expect(renderStorageKey('0197c0de-0000-7000-8000-000000000001')).toBe(
      'renders/0197c0de-0000-7000-8000-000000000001.mp4',
    );
  });
});

describe('bornes du plan : ce que le schéma ne peut pas vérifier (docs/05 §6.3)', () => {
  const bounds = { sourceDurationMs: 60_000, maxClipMs: 30_000 };
  const plan = (startMs: number, endMs: number) => ({
    startMs,
    endMs,
    subtitleMode: 'burned' as const,
    crop: 'vertical_center' as const,
    reason: 'Extrait choisi pour sa clarté, sans invention de contenu.',
  });

  it('accepte un extrait dans les bornes', () => {
    expect(() => validateRenderPlan(plan(1_000, 31_000), bounds)).not.toThrow();
  });

  it('refuse un extrait négatif, inversé, au-delà de la source ou hors durée', () => {
    expect(codeOf(() => validateRenderPlan(plan(-1, 5_000), bounds))).toBe(
      'VIDEO_PLAN_START_NEGATIVE',
    );
    expect(codeOf(() => validateRenderPlan(plan(5_000, 5_000), bounds))).toBe(
      'VIDEO_PLAN_END_BEFORE_START',
    );
    expect(codeOf(() => validateRenderPlan(plan(59_000, 60_500), bounds))).toBe(
      'VIDEO_PLAN_BEYOND_SOURCE',
    );
    expect(codeOf(() => validateRenderPlan(plan(0, 500), bounds))).toBe('VIDEO_PLAN_TOO_SHORT');
    expect(codeOf(() => validateRenderPlan(plan(0, 31_000), bounds))).toBe('VIDEO_PLAN_TOO_LONG');
  });
});

describe('parole dans la fenêtre et avertissements honnêtes', () => {
  const segments = [
    { startMs: 2_000, endMs: 4_000, text: 'Bonjour' },
    { startMs: 10_000, endMs: 14_000, text: 'Voici le montage' },
    { startMs: 20_000, endMs: 22_000, text: '   ' },
  ];

  it('détecte un segment qui recoupe la fenêtre, ignore un blanc', () => {
    expect(hasSpeechInWindow(segments, { startMs: 0, endMs: 5_000 })).toBe(true);
    // Le segment 20 → 22 s n’a que des espaces : il n’afficherait rien.
    expect(hasSpeechInWindow(segments, { startMs: 19_000, endMs: 25_000 })).toBe(false);
    expect(hasSpeechInWindow(segments, { startMs: 5_000, endMs: 9_000 })).toBe(false);
  });

  it('avertit sans bloquer : pas de parole, ou recadrage qui coupe les bords', () => {
    const noSpeech = renderPlanWarnings({
      plan: { startMs: 0, endMs: 1_500 },
      sourceWidth: 1_920,
      sourceHeight: 1_080,
      transcriptSegments: segments,
    });
    expect(noSpeech.some((warning) => warning.includes('Aucune parole'))).toBe(true);
    // 1920×1080 : un recadrage centré 9:16 ne garde que ~32 % de la largeur.
    expect(noSpeech.some((warning) => warning.includes('Recadrage important'))).toBe(true);

    // Une source déjà verticale ne produit aucun avertissement de cadrage.
    expect(
      renderPlanWarnings({
        plan: { startMs: 2_000, endMs: 4_000 },
        sourceWidth: 1_080,
        sourceHeight: 1_920,
        transcriptSegments: segments,
      }),
    ).toHaveLength(0);
  });

  it('ne devine pas un cadrage quand les dimensions sont inconnues', () => {
    expect(
      renderPlanWarnings({
        plan: { startMs: 2_000, endMs: 4_000 },
        sourceWidth: null,
        sourceHeight: null,
        transcriptSegments: segments,
      }),
    ).toHaveLength(0);
  });
});

describe('plan par défaut : calculé en code, jamais par un modèle (docs/05 §6.3)', () => {
  it('part du premier passage transcrit, sur 60 s au plus', () => {
    const plan = defaultRenderPlan({
      sourceDurationMs: 300_000,
      maxClipMs: 180_000,
      transcriptSegments: [{ startMs: 12_000, endMs: 30_000 }],
    });
    expect(plan).toMatchObject({ startMs: 12_000, endMs: 72_000, subtitleMode: 'burned' });
    expect(plan.reason.length).toBeGreaterThan(10);
  });

  it('respecte la durée maximale d’extrait et la durée de la source', () => {
    const short = defaultRenderPlan({
      sourceDurationMs: 20_000,
      maxClipMs: 180_000,
      transcriptSegments: [],
    });
    expect(short.startMs).toBe(0);
    expect(short.endMs).toBe(20_000);

    const capped = defaultRenderPlan({
      sourceDurationMs: 300_000,
      maxClipMs: 8_000,
      transcriptSegments: [{ startMs: 0, endMs: 2_000 }],
    });
    expect(capped.endMs - capped.startMs).toBe(8_000);
  });

  it('décrit le plan en clair, sans dépendre de la locale', () => {
    expect(
      describeRenderPlan({
        startMs: 0,
        endMs: 61_500,
        subtitleMode: 'burned',
        crop: 'vertical_center',
        reason: 'Extrait de référence pour la démonstration.',
      }),
    ).toBe('0:00.000 → 1:01.500 (1:01.500, sous-titres brûlés, recadrage centré)');
    expect(formatMs(3_723_456)).toBe('62:03.456');
  });
});

describe('compilation du plan en arguments FFmpeg (docs/05 §6.4, docs/09 §4)', () => {
  const args = buildVerticalShortArgs({
    inputPath: '/data/media/202603/ab/source.mp4',
    outputPath: '/data/media/renders/0197c0de.mp4.part',
    plan: { startMs: 12_500, endMs: 42_500 },
    hasAudio: true,
    subtitleFileName: SUBTITLE_FILE_NAME,
  });

  it('encode en un seul passage, avec le format unique 1080 × 1920', () => {
    // Un seul `-i` : deux passages doubleraient le temps d’encodage.
    expect(args.filter((value) => value === '-i')).toHaveLength(1);
    expect(args).toContain('-c:v');
    expect(args[args.indexOf('-c:v') + 1]).toBe('libx264');
    expect(args[args.indexOf('-crf') + 1]).toBe('23');
    expect(args[args.indexOf('-pix_fmt') + 1]).toBe('yuv420p');
    expect(args[args.indexOf('-r') + 1]).toBe('30');
    expect(args).toContain('+faststart');
  });

  it('découpe exactement la fenêtre du plan, avant l’entrée (lecture rapide)', () => {
    expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '12.500']);
    expect(args.slice(args.indexOf('-t'), args.indexOf('-t') + 2)).toEqual(['-t', '30.000']);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
  });

  it('recadre en 9:16 au centre, avec un SAR carré', () => {
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toBe(
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,subtitles=subtitles.ass[v]',
    );
    expect(graph).toContain('crop=1080:1920');
  });

  it('ne passe qu’un **nom relatif** de sous-titres dans le filtre', () => {
    const graph = args[args.indexOf('-filter_complex') + 1];
    // Aucun chemin absolu, aucun `/` : rien à échapper, rien à injecter.
    expect(graph).toContain('subtitles=subtitles.ass');
    expect(graph).not.toContain('/data/media');
  });

  it('copie l’audio en AAC quand il existe, et le retire sinon', () => {
    expect(args).toContain('-c:a');
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac');
    expect(args[args.indexOf('-ar') + 1]).toBe('48000');

    const silent = buildVerticalShortArgs({
      inputPath: '/in.mp4',
      outputPath: '/out.mp4',
      plan: { startMs: 0, endMs: 5_000 },
      hasAudio: false,
    });
    expect(silent).toContain('-an');
    expect(silent).not.toContain('-c:a');
    // Sans sous-titres demandés, le filtre n’en incruste aucun.
    expect(silent[silent.indexOf('-filter_complex') + 1]).not.toContain('subtitles=');
  });

  it('n’utilise jamais de shell : les chemins restent des arguments entiers', () => {
    const hostile = buildVerticalShortArgs({
      inputPath: '/data/media/a b ; rm -rf ~/x/$(whoami).mp4',
      outputPath: '/data/media/renders/out.mp4',
      plan: { startMs: 0, endMs: 1_000 },
      hasAudio: true,
    });
    expect(hostile).toContain('/data/media/a b ; rm -rf ~/x/$(whoami).mp4');
    // Le chemin hostile n’est jamais fragmenté ni transformé en commande.
    expect(hostile.indexOf('/data/media/a b ; rm -rf ~/x/$(whoami).mp4')).toBe(
      hostile.indexOf('-i') + 1,
    );
  });
});
