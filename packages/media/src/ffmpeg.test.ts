import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TransientError } from '@aia/shared';
import {
  DEFAULT_FFMPEG_TIMEOUT_MS,
  ffmpegAvailable,
  ffmpegUnavailable,
  parseFfmpegProgress,
  parseFfmpegProgressBlock,
  parseFfprobeJson,
  parseFrameRate,
  ScriptedFfmpegRunner,
  SpawnFfmpegRunner,
} from './ffmpeg';
import type { CommandRunner } from './exec';

/**
 * Le lanceur FFmpeg et la lecture de ses sorties (docs/02 §9.6, docs/09 §4).
 *
 * Aucun binaire n’est lancé : l’exécutant est injecté. C’est ce qui permet de
 * tester les cas qu’un vrai FFmpeg ne produit pas à la demande — un délai
 * dépassé, une interruption, un `stderr` bavard, un JSON incomplet.
 */

/** Un exécutant scripté : enregistre les appels et rend la réponse prévue. */
function scriptedRunner(responses: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  aborted?: boolean;
}): { runner: CommandRunner; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args });
    return {
      exitCode: responses.exitCode ?? 0,
      stdout: responses.stdout ?? '',
      stderr: responses.stderr ?? '',
      timedOut: responses.timedOut ?? false,
      aborted: responses.aborted ?? false,
    };
  };
  return { runner, calls };
}

const FFPROBE_JSON = JSON.stringify({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30000/1001',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration: '12.345', format_name: 'mov,mp4,m4a,3gp,3g2,mj2', size: '2048' },
});

describe('lecture de ffprobe : ce que le fichier est vraiment', () => {
  it('lit durée, dimensions, codecs, audio et images par seconde', () => {
    const probe = parseFfprobeJson(FFPROBE_JSON);
    expect(probe).toMatchObject({
      durationMs: 12_345,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasAudio: true,
      sizeBytes: 2048,
    });
    // fps est stocké × 100 : 29,97 i/s deviennent 2997 (docs/03 §10.1).
    expect(probe.fps).toBe(2_997);
    expect(probe.container).toContain('mp4');
  });

  it('n’invente rien : un fichier sans audio ou sans durée reste null', () => {
    const probe = parseFfprobeJson(
      JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }),
    );
    expect(probe.durationMs).toBeNull();
    expect(probe.width).toBeNull();
    expect(probe.fps).toBeNull();
    expect(probe.hasAudio).toBe(false);
  });

  it('refuse une sortie illisible au lieu de rendre un fichier vide', () => {
    expect(() => parseFfprobeJson('pas du json')).toThrow();
  });

  it('lit les fractions annoncées par FFmpeg, et rien d’autre', () => {
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
    expect(parseFrameRate('25')).toBe(25);
    expect(parseFrameRate('0/0')).toBeNull();
    expect(parseFrameRate(undefined)).toBeNull();
  });
});

describe('progression FFmpeg : lue, jamais devinée (docs/02 §13)', () => {
  it('préfère out_time_us et ignore le doublon out_time_ms', () => {
    const progress = parseFfmpegProgressBlock(
      ['frame=120', 'out_time_us=5000000', 'out_time_ms=5000000', 'speed=2.1x'],
      10_000,
    );
    expect(progress).toMatchObject({ outTimeMs: 5_000, frame: 120, speed: '2.1x', percent: 50 });
  });

  it('retombe sur out_time_ms seulement quand out_time_us manque', () => {
    expect(parseFfmpegProgress('out_time_ms=2500000', 10_000)?.percent).toBe(25);
    // Les deux ensemble : une seule mesure, sans double comptage.
    expect(
      parseFfmpegProgressBlock(['out_time_us=1000000', 'out_time_ms=1000000'])?.outTimeMs,
    ).toBe(1_000);
  });

  it('ne calcule aucun pourcentage sans durée attendue', () => {
    expect(parseFfmpegProgress('out_time_us=1000000')).toMatchObject({
      outTimeMs: 1_000,
      percent: null,
    });
  });

  it('borne le pourcentage à 100 et ignore une ligne sans mesure', () => {
    expect(parseFfmpegProgress('out_time_us=99000000', 1_000)?.percent).toBe(100);
    expect(parseFfmpegProgress('progress=continue')).toBeNull();
    expect(parseFfmpegProgress('')).toBeNull();
  });

  it('rend null plutôt qu’une mesure inventée sur une valeur illisible', () => {
    expect(parseFfmpegProgress('out_time_us=pas-un-nombre')).toBeNull();
  });
});

describe('runOrThrow : chaque échec est nommé, et sa catégorie décide de la reprise', () => {
  const runner = (options: Parameters<typeof scriptedRunner>[0]) =>
    new SpawnFfmpegRunner({
      ffmpegBin: 'ffmpeg',
      ffprobeBin: 'ffprobe',
      runner: scriptedRunner(options).runner,
    });

  it('rend la sortie quand FFmpeg réussit', async () => {
    const result = await runner({ stdout: 'ok' }).runOrThrow(['-version']);
    expect(result.exitCode).toBe(0);
  });

  it('un délai dépassé est **transitoire** : une reprise est légitime', async () => {
    await expect(
      runner({ timedOut: true, exitCode: 1 }).runOrThrow(['-i', 'x']),
    ).rejects.toMatchObject({ code: 'FFMPEG_TIMEOUT', category: 'transient' });
  });

  it('un arrêt du worker est **transitoire** et le dit', async () => {
    await expect(runner({ aborted: true }).runOrThrow(['-i', 'x'])).rejects.toMatchObject({
      code: 'FFMPEG_ABORTED',
    });
  });

  it('un refus d’encodage est **interne** et garde la fin de stderr', async () => {
    const failure = await runner({ exitCode: 1, stderr: 'Error: ' + 'x'.repeat(3_000) })
      .runOrThrow(['-i', 'x'])
      .then(() => null)
      .catch((caught: unknown) => caught as { code?: string; details?: { stderr?: string } });
    expect(failure?.code).toBe('FFMPEG_FAILED');
    expect(failure?.details?.stderr?.length).toBeLessThanOrEqual(2_000);
  });
});

describe('probe, version et injection : aucun shell, aucun octet inventé', () => {
  it('appelle ffprobe en JSON, et rend le média illisible comme une entrée invalide', async () => {
    const scripted = scriptedRunner({ stdout: FFPROBE_JSON });
    const ffmpeg = new SpawnFfmpegRunner({
      ffmpegBin: 'ffmpeg',
      ffprobeBin: '/usr/bin/ffprobe',
      runner: scripted.runner,
    });
    const probe = await ffmpeg.probe('/data/media/source.mp4');
    expect(probe.durationMs).toBe(12_345);
    expect(scripted.calls[0]?.command).toBe('/usr/bin/ffprobe');
    // Le chemin est un **argument**, jamais une commande : il est intact.
    expect(scripted.calls[0]?.args).toEqual([
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-i',
      '/data/media/source.mp4',
    ]);

    const failing = new SpawnFfmpegRunner({
      ffmpegBin: 'ffmpeg',
      ffprobeBin: 'ffprobe',
      runner: scriptedRunner({ exitCode: 1, stderr: 'Invalid data found' }).runner,
    });
    await expect(failing.probe('/data/media/illisible.mp4')).rejects.toMatchObject({
      code: 'MEDIA_UNREADABLE',
    });
  });

  it('met la version en cache : un seul appel, et `null` si le binaire est absent', async () => {
    const scripted = scriptedRunner({ stdout: 'ffmpeg version 7.1\nmore' });
    const ffmpeg = new SpawnFfmpegRunner({
      ffmpegBin: 'ffmpeg',
      ffprobeBin: 'ffprobe',
      runner: scripted.runner,
    });
    expect(await ffmpeg.version()).toBe('ffmpeg version 7.1');
    expect(await ffmpeg.version()).toBe('ffmpeg version 7.1');
    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]?.args).toEqual(['-version']);

    const missing = new SpawnFfmpegRunner({
      ffmpegBin: 'ffmpeg',
      ffprobeBin: 'ffprobe',
      runner: scriptedRunner({ exitCode: 127, stderr: 'not found' }).runner,
    });
    expect(await missing.version()).toBeNull();
    expect(await ffmpegAvailable(missing)).toBe(false);
    expect(ffmpegUnavailable('binaire introuvable').code).toBe('FFMPEG_UNAVAILABLE');
  });

  it('transmet la progression émise par le binaire, sans la réinventer', async () => {
    const seen: number[] = [];
    const runner: CommandRunner = async (_command, _args, options) => {
      // FFmpeg écrit ses mesures en flux : la dernière ligne peut être partielle.
      options?.onStdout?.('frame=30\nout_time_us=1000000\nout_time');
      options?.onStdout?.('_us=2000000\nprogress=continue\n');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const ffmpeg = new SpawnFfmpegRunner({ ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe', runner });
    await ffmpeg.run(['-progress', 'pipe:1'], {
      expectedDurationMs: 4_000,
      onProgress: (progress) => {
        if (progress.percent !== null) seen.push(progress.percent);
      },
    });
    // La ligne coupée en deux est reconstituée : 1 s puis 2 s sur 4 s attendues.
    expect(seen).toEqual([25, 50]);
  });

  it('applique un délai par défaut et transmet le répertoire de travail', async () => {
    let captured: { cwd?: string; timeoutMs?: number } | undefined;
    const runner: CommandRunner = async (_command, _args, options) => {
      captured = { cwd: options?.cwd, timeoutMs: options?.timeoutMs };
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const ffmpeg = new SpawnFfmpegRunner({ ffmpegBin: 'ffmpeg', ffprobeBin: 'ffprobe', runner });
    await ffmpeg.run(['-i', 'in.mp4'], { cwd: '/tmp/render-1' });
    expect(captured).toEqual({ cwd: '/tmp/render-1', timeoutMs: DEFAULT_FFMPEG_TIMEOUT_MS });
  });
});

describe('lanceur scripté : une doublure honnête, qui écrit vraiment', () => {
  it('conserve les arguments reçus et écrit le fichier de sortie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aia-ffmpeg-script-'));
    try {
      const output = join(directory, 'out.mp4.part');
      const ffmpeg = new ScriptedFfmpegRunner({ outputBytes: new Uint8Array(1_024) });
      await ffmpeg.runOrThrow(['-i', 'in.mp4', output], {
        cwd: directory,
        expectedDurationMs: 2_000,
      });
      expect(ffmpeg.calls).toHaveLength(1);
      expect(ffmpeg.calls[0]?.args.at(-1)).toBe(output);
      expect(ffmpeg.calls[0]?.cwd).toBe(directory);
      expect((await stat(output)).size).toBe(1_024);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('émet la progression annoncée, sans dépasser 100 %', async () => {
    const seen: Array<{ outTimeMs: number | null; percent: number | null }> = [];
    const ffmpeg = new ScriptedFfmpegRunner({ progressStepsMs: [500, 1_000, 2_000, 3_000] });
    await ffmpeg.run(['-i', 'in.mp4', '/tmp/out.mp4'], {
      expectedDurationMs: 2_000,
      onProgress: (progress) =>
        seen.push({ outTimeMs: progress.outTimeMs, percent: progress.percent }),
    });
    expect(seen).toEqual([
      { outTimeMs: 500, percent: 25 },
      { outTimeMs: 1_000, percent: 50 },
      { outTimeMs: 2_000, percent: 100 },
      { outTimeMs: 3_000, percent: 100 },
    ]);
  });

  it('échoue autant de fois que demandé, puis réussit : c’est ce qui teste une reprise', async () => {
    const ffmpeg = new ScriptedFfmpegRunner({
      failures: 1,
      failure: () => new TransientError('FFmpeg interrompu (scripté).', { code: 'FFMPEG_ABORTED' }),
    });
    await expect(ffmpeg.runOrThrow(['-i', 'in.mp4', '/tmp/out.mp4'])).rejects.toMatchObject({
      code: 'FFMPEG_ABORTED',
    });
    await expect(ffmpeg.runOrThrow(['-i', 'in.mp4', '/tmp/out.mp4'])).resolves.toBeTruthy();
  });

  it('sans binaire, dit l’indisponibilité au lieu de simuler un rendu', async () => {
    const ffmpeg = new ScriptedFfmpegRunner({ version: null });
    expect(await ffmpeg.version()).toBeNull();
    expect(await ffmpegAvailable(ffmpeg)).toBe(false);
  });
});
