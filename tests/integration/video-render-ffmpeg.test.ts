import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildVerticalShortArgs,
  buildSubtitleCues,
  renderAssSubtitles,
  ScriptedFfmpegRunner,
  SpawnFfmpegRunner,
  SUBTITLE_FILE_NAME,
  VERTICAL_FORMAT,
} from '@aia/media';

/**
 * Le rendu **réel**, avec le vrai FFmpeg de la machine (docs/09 §1.1 : c'est le
 * seul test qui en dépend, et il s'ignore proprement si le binaire est absent).
 *
 * Ce qu'il prouve, et qu'aucun test scripté ne peut prouver :
 *
 * - le graphe de filtres **compilé** est accepté par FFmpeg
 *   (`scale`/`crop`/`setsar` + `subtitles=`) ;
 * - la sortie est bien **1080 × 1920**, H.264, lisible, de la durée de l'extrait ;
 * - les sous-titres sont **incrustés** : la même fenêtre encodée sans eux donne un
 *   fichier différent, ce qui est la seule preuve observable d'un incrustation
 *   (le filtre a modifié les pixels).
 *
 * La source est fabriquée par FFmpeg lui-même (`lavfi`) : aucune fixture binaire
 * n'est versionnée dans le dépôt.
 */

function ffmpegAvailable(): boolean {
  try {
    return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

const available = ffmpegAvailable();
const temporary: string[] = [];

afterAll(async () => {
  for (const directory of temporary) await rm(directory, { recursive: true, force: true });
});

/** Une source horizontale avec du son, fabriquée par FFmpeg (aucune fixture). */
async function makeSource(ffmpeg: SpawnFfmpegRunner, directory: string): Promise<string> {
  const source = join(directory, 'source.mp4');
  const result = await ffmpeg.runOrThrow([
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=15:duration=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-y',
    source,
  ]);
  expect(result.exitCode).toBe(0);
  return source;
}

describe.skipIf(!available)('rendu réel : FFmpeg de la machine (docs/10 §4.7)', () => {
  it('encode un short 1080 × 1920 sous-titré, lisible, de la durée de l’extrait', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aia-render-real-'));
    temporary.push(directory);
    const ffmpeg = new SpawnFfmpegRunner({ ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe' });
    const source = await makeSource(ffmpeg, directory);

    // Les répliques viennent des segments : ici, une seule phrase tenue 1,5 s.
    const cues = buildSubtitleCues({
      segments: [{ startMs: 0, endMs: 3_000, text: 'Voici comment j’automatise ma facturation.' }],
      clipStartMs: 500,
      clipEndMs: 2_000,
    });
    expect(cues).toHaveLength(1);
    await writeFile(
      join(directory, SUBTITLE_FILE_NAME),
      renderAssSubtitles(cues, { width: VERTICAL_FORMAT.width, height: VERTICAL_FORMAT.height }),
      'utf8',
    );

    const withSubtitles = join(directory, 'short.mp4');
    const plan = { startMs: 500, endMs: 2_000 };
    const run = await ffmpeg.runOrThrow(
      buildVerticalShortArgs({
        inputPath: source,
        outputPath: withSubtitles,
        plan,
        hasAudio: true,
        subtitleFileName: SUBTITLE_FILE_NAME,
      }),
      // Le répertoire de travail, c'est ce qui permet le nom **relatif** du ASS.
      { cwd: directory, expectedDurationMs: 1_500 },
    );
    expect(run.exitCode).toBe(0);

    const produced = await ffmpeg.probe(withSubtitles);
    expect(produced.width).toBe(VERTICAL_FORMAT.width);
    expect(produced.height).toBe(VERTICAL_FORMAT.height);
    expect(produced.videoCodec).toBe('h264');
    expect(produced.audioCodec).toBe('aac');
    expect(produced.hasAudio).toBe(true);
    // FFmpeg et le plan ne sont pas d'accord au centième près : on borne.
    expect(produced.durationMs).toBeGreaterThan(1_300);
    expect(produced.durationMs).toBeLessThan(1_700);
    expect((await stat(withSubtitles)).size).toBeGreaterThan(1_000);

    // La même fenêtre, **sans** sous-titres : le fichier doit différer. C'est la
    // preuve observable que le filtre `subtitles=` a bien modifié les pixels.
    const withoutSubtitles = join(directory, 'short-no-subs.mp4');
    await ffmpeg.runOrThrow(
      buildVerticalShortArgs({
        inputPath: source,
        outputPath: withoutSubtitles,
        plan,
        hasAudio: true,
        subtitleFileName: null,
      }),
      { cwd: directory, expectedDurationMs: 1_500 },
    );
    expect((await stat(withoutSubtitles)).size).not.toBe((await stat(withSubtitles)).size);
  }, 60_000);

  it('dit « indisponible » quand le binaire n’est pas là, au lieu de simuler', async () => {
    const broken = new SpawnFfmpegRunner({ ffmpegBin: 'ffmpeg-inexistant', ffprobeBin: 'ffprobe' });
    expect(await broken.version()).toBeNull();

    // Le lanceur scripté, lui, peut simuler l’absence : c’est ce qui teste les
    // branches d’erreur sans casser la machine du développeur.
    const simulated = new ScriptedFfmpegRunner({ version: null });
    expect(await simulated.version()).toBeNull();
  });
});
