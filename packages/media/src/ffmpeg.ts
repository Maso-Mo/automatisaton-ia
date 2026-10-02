import { CapabilityError, InternalError, TransientError, ValidationError } from '@aia/shared';
import { rm, writeFile } from 'node:fs/promises';
import { spawnCommand, type CommandRunner } from './exec';

/**
 * Le **lanceur FFmpeg** (docs/02 §9.6) : `spawn`, jamais de shell, arguments en
 * tableau, délai maximal, erreurs typées.
 *
 * Ce module existe pour une raison précise : le rendu vidéo est l'opération la
 * plus longue et la plus fragile du produit, et c'est aussi celle où une
 * injection de commande serait la plus facile. Trois règles sont donc portées
 * par le code, et non laissées à la discipline des appelants :
 *
 * 1. **jamais de `shell`** : `spawn(binaire, argv)` — un chemin de fichier
 *    provenant de l'utilisateur reste un argument, jamais une commande ;
 * 2. **jamais de chemin utilisateur dans un filtre** : les filtres FFmpeg
 *    (`subtitles=…`) ne reçoivent qu'un **nom de fichier relatif** produit par le
 *    serveur, dans un répertoire de travail temporaire créé par nous. C'est ce
 *    qui supprime toute question d'échappement, et c'est `buildVerticalShortArgs`
 *    qui l'impose ;
 * 3. **tout processus est borné dans le temps** : un encodage qui n'avance plus
 *    (source corrompue, disque plein) est tué puis le fichier partiel supprimé ;
 *    l'erreur est **transitoire**, donc une reprise est légitime.
 *
 * La progression n'est pas devinée : `-progress pipe:1` écrit des lignes
 * `clé=valeur` sur la sortie standard, dont `out_time_us` (microsecondes). Un
 * rendu n'est donc pas une boîte noire (docs/02 §13).
 */

/** Ce que `ffprobe` apprend d'un fichier, jamais ce que l'utilisateur affirme. */
export interface MediaProbe {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  hasAudio: boolean;
  /** Images par seconde × 100 (docs/03 §10.1 : un entier, jamais un flottant). */
  fps: number | null;
  sizeBytes: number | null;
}

/** Une mesure de progression, telle que FFmpeg l'a écrite. */
export interface FfmpegProgress {
  outTimeMs: number | null;
  frame: number | null;
  speed: string | null;
  /** `null` quand la durée attendue n'est pas connue : on n'affiche alors aucun pourcentage. */
  percent: number | null;
}

export interface FfmpegResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

export interface FfmpegRunOptions {
  /** Annulation : le processus est terminé (SIGTERM, puis SIGKILL). */
  signal?: AbortSignal;
  /** Durée attendue de la sortie (ms) : ce qui transforme `out_time_us` en pourcentage. */
  expectedDurationMs?: number;
  /**
   * Progression **rapportée**, jamais inventée : uniquement celle que FFmpeg a
   * écrite. C'est l'appelant qui décide du palier (`ctx.setStep`).
   */
  onProgress?: (progress: FfmpegProgress) => void;
  timeoutMs?: number;
  /** Répertoire de travail : c'est lui qui permet de n'utiliser que des noms relatifs. */
  cwd?: string;
}

export interface FFmpegRunner {
  run(args: readonly string[], options?: FfmpegRunOptions): Promise<FfmpegResult>;
  /** Comme `run`, mais lève une erreur **typée** si le processus échoue. */
  runOrThrow(args: readonly string[], options?: FfmpegRunOptions): Promise<FfmpegResult>;
  probe(path: string): Promise<MediaProbe>;
  /** Version de FFmpeg, mise en cache : elle est stockée sur le rendu. */
  version(): Promise<string | null>;
}

export interface FfmpegRunnerOptions {
  ffmpegBin: string;
  ffprobeBin: string;
  /** Exécutant bas niveau, injectable : tracer les arguments sans lancer FFmpeg. */
  runner?: CommandRunner;
  timeoutMs?: number;
}

export const DEFAULT_FFMPEG_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Un binaire **absent** n'est pas une panne d'encodage : c'est une capacité qui
 * manque sur cette machine. La traduire en `CapabilityError` nommée permet à
 * l'écran de dire « installer FFmpeg » au lieu d'afficher « erreur interne »
 * (docs/02 §12 : la catégorie décide de la suite, pas le message).
 */
function spawnFailure(error: unknown, binary: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
    return ffmpegUnavailable(`${binary} : ${code}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class SpawnFfmpegRunner implements FFmpegRunner {
  private readonly runner: CommandRunner;
  private versionCache: string | null | undefined;

  constructor(private readonly options: FfmpegRunnerOptions) {
    this.runner = options.runner ?? spawnCommand;
  }

  async run(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
    let progressBuffer = '';
    const onStdout =
      options.onProgress === undefined
        ? undefined
        : (chunk: string): void => {
            progressBuffer += chunk;
            const lines = progressBuffer.split('\n');
            // La dernière ligne peut être incomplète : elle est conservée pour le
            // prochain morceau, sinon une mesure sur deux serait perdue.
            progressBuffer = lines.pop() ?? '';
            const progress = parseFfmpegProgressBlock(lines, options.expectedDurationMs);
            if (progress !== null) options.onProgress?.(progress);
          };

    const result = await this.runner(this.options.ffmpegBin, args, {
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(onStdout ? { onStdout } : {}),
    }).catch((error: unknown) => {
      throw spawnFailure(error, this.options.ffmpegBin);
    });

    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut === true,
      aborted: result.aborted === true,
    };
  }

  /**
   * Lance FFmpeg et **échoue proprement**. Un dépassement de délai ou une
   * interruption sont `transient` (la reprise est légitime) ; un refus d'encodage
   * est `internal` avec la fin de `stderr` en détail — c'est ce que l'écran
   * affiche, et c'est ce qui évite un « échec sans raison ».
   */
  async runOrThrow(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
    const result = await this.run(args, options);
    if (result.timedOut) {
      throw new TransientError(
        `FFmpeg a dépassé le délai imparti (${Math.round(
          (options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS) / 1_000,
        )} s) : rendu interrompu.`,
        { code: 'FFMPEG_TIMEOUT' },
      );
    }
    if (result.aborted) {
      throw new TransientError('Rendu interrompu par l’arrêt du worker : il sera repris.', {
        code: 'FFMPEG_ABORTED',
      });
    }
    if (result.exitCode !== 0) {
      throw new InternalError('FFmpeg a refusé d’encoder cet extrait.', {
        code: 'FFMPEG_FAILED',
        details: { exitCode: result.exitCode, stderr: result.stderr.slice(-2_000) },
      });
    }
    return result;
  }

  /**
   * `ffprobe` : ce que le fichier **est**. Un fichier illisible est un
   * `validation` — l'entrée est refusée maintenant, aucune reprise ne la rendra
   * lisible (docs/05 §5.1).
   */
  async probe(path: string): Promise<MediaProbe> {
    const result = await this.runner(
      this.options.ffprobeBin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path],
      { timeoutMs: Math.min(this.options.timeoutMs ?? 60_000, 60_000) },
    ).catch((error: unknown) => {
      throw spawnFailure(error, this.options.ffprobeBin);
    });

    if (result.exitCode !== 0) {
      throw new ValidationError('Fichier média illisible : il n’a pas pu être décodé.', {
        code: 'MEDIA_UNREADABLE',
        details: { stderr: result.stderr.slice(-1_000) },
      });
    }
    return parseFfprobeJson(result.stdout);
  }

  /**
   * `-version`. Une **capacité** manquante rend `null`, elle ne lève pas : la
   * question posée est « FFmpeg est-il utilisable sur cette machine ? », et la
   * réponse « non » est une réponse, pas une erreur (docs/02 §12 : un écran qui
   * annonce ce qu'il ne peut pas faire vaut mieux qu'un écran qui casse).
   */
  async version(): Promise<string | null> {
    if (this.versionCache !== undefined) return this.versionCache;
    try {
      const result = await this.runner(this.options.ffmpegBin, ['-version'], { timeoutMs: 10_000 });
      const first = result.stdout.split('\n', 1)[0]?.trim() ?? '';
      this.versionCache = result.exitCode === 0 && first.length > 0 ? first : null;
    } catch {
      this.versionCache = null;
    }
    return this.versionCache;
  }
}

/** Suppression best-effort d'un fichier partiel : un rendu interrompu ne laisse rien. */
export async function removeQuietly(path: string): Promise<void> {
  await rm(path, { force: true });
}

/**
 * Le **lanceur scripté** : la chaîne de rendu se teste sans FFmpeg installé, et
 * sans encoder une seconde de vidéo (docs/09 §1.1).
 *
 * Il ne remplace jamais `SpawnFfmpegRunner` en production. Ce qu'il rend
 * possible, en revanche, est exactement ce qu'un vrai binaire ne produit pas à la
 * demande :
 *
 * - **les arguments réellement lancés** sont conservés (`calls`) : un test peut
 *   vérifier le graphe de filtres et le fait qu'aucun `shell` n'intervient ;
 * - **un fichier de sortie est écrit** à l'emplacement de sortie, donc les étapes
 *   du handler qui mesurent, hachent et renomment ce fichier s'exécutent pour de
 *   vrai (renommage atomique compris) ;
 * - **un échec est programmable** (`failures` + `failure`) : une coupure
 *   transitoire produit une **reprise réelle** de la file, une erreur interne n'en
 *   produit aucune — la politique reste celle de la queue, pas celle du script ;
 * - **la progression est émise** comme FFmpeg l'émet, avec la durée attendue.
 */
export interface ScriptedFfmpegRunnerOptions {
  /** Ce que rend `-version`. `null` simule un binaire absent. */
  version?: string | null;
  /** Ce que rend `probe(path)`. Par défaut : un rendu vertical de 5 s. */
  probe?: (path: string) => Partial<MediaProbe>;
  /** Octets écrits dans le fichier de sortie (le handler les mesure ensuite). */
  outputBytes?: Uint8Array;
  /** Nombre d'appels qui échouent **avant** de réussir. */
  failures?: number;
  failure?: () => unknown;
  /** Mesures de progression émises, en millisecondes produites. */
  progressStepsMs?: readonly number[];
}

export class ScriptedFfmpegRunner implements FFmpegRunner {
  /** Les appels reçus : c'est ce que les tests vérifient. */
  readonly calls: Array<{ args: readonly string[]; cwd: string | null }> = [];

  private reads = 0;
  private readonly versionResult: string | null;

  constructor(private readonly options: ScriptedFfmpegRunnerOptions = {}) {
    this.versionResult =
      options.version === undefined ? 'ffmpeg version 7.1 (scripté)' : options.version;
  }

  async version(): Promise<string | null> {
    return this.versionResult;
  }

  /**
   * Une mesure scriptée. Par défaut : une source H.264 de 5 s. Un test qui
   * interroge **le fichier produit** rend les dimensions attendues via `probe`.
   */
  async probe(path: string): Promise<MediaProbe> {
    const overrides = this.options.probe?.(path) ?? {};
    return {
      durationMs: 5_000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      container: 'mov,mp4,m4a,3gp,3g2,mj2',
      hasAudio: true,
      fps: 3_000,
      sizeBytes: this.options.outputBytes?.byteLength ?? 4_096,
      ...overrides,
    };
  }

  /**
   * Le cœur : un échec scripté **lève** (comme un vrai `runOrThrow`), parce que
   * tous les modes d'échec qui nous intéressent — délai dépassé, interruption,
   * refus d'encodage — sont des erreurs du point de vue du handler. Une exécution
   * réussie écrit un vrai fichier de sortie, émet la progression annoncée, puis se
   * termine proprement.
   */
  private async execute(args: readonly string[], options: FfmpegRunOptions): Promise<FfmpegResult> {
    this.calls.push({ args: [...args], cwd: options.cwd ?? null });
    this.reads += 1;
    if (this.reads <= (this.options.failures ?? 0)) {
      throw this.options.failure?.() ?? new Error('échec scripté de FFmpeg');
    }

    const outputPath = args[args.length - 1];
    if (outputPath !== undefined) {
      await writeFile(outputPath, this.options.outputBytes ?? new Uint8Array(4_096));
    }

    for (const outTimeMs of this.options.progressStepsMs ?? []) {
      const expected = options.expectedDurationMs;
      options.onProgress?.({
        outTimeMs,
        frame: null,
        speed: '1x',
        percent:
          expected !== undefined && expected > 0
            ? Math.min(100, Math.max(0, Math.round((outTimeMs / expected) * 100)))
            : null,
      });
    }

    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, aborted: false };
  }

  async run(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
    return this.execute(args, options);
  }

  async runOrThrow(args: readonly string[], options: FfmpegRunOptions = {}): Promise<FfmpegResult> {
    return this.execute(args, options);
  }
}

/** Le binaire est-il utilisable ? Sert à distinguer « absent » de « erreur ». */
export async function ffmpegAvailable(runner: FFmpegRunner): Promise<boolean> {
  try {
    return (await runner.version()) !== null;
  } catch {
    return false;
  }
}

/** Erreur de capacité explicite : le binaire manque, le rendu est impossible. */
export function ffmpegUnavailable(detail: string): CapabilityError {
  return new CapabilityError(
    `FFmpeg est indisponible (${detail}) : le rendu vidéo est impossible sur cette machine. Installer FFmpeg ou renseigner FFMPEG_BIN.`,
    { code: 'FFMPEG_UNAVAILABLE' },
  );
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
}

interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string; format_name?: string; size?: string };
}

/** Fractions `30000/1001` : FFmpeg annonce toujours `r_frame_rate` ainsi. */
export function parseFrameRate(value: string | undefined): number | null {
  if (value === undefined) return null;
  const [num, den] = value.split('/', 2);
  const numerator = Number(num);
  const denominator = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    return null;
  return numerator / denominator;
}

/**
 * Lecture de la sortie `ffprobe`. Les valeurs absentes restent `null` : on
 * n'invente ni durée ni résolution (docs/09 §12 — pas de donnée fabriquée).
 */
export function parseFfprobeJson(raw: string): MediaProbe {
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(raw) as FfprobeJson;
  } catch (error) {
    throw new InternalError('Réponse ffprobe illisible.', {
      code: 'FFPROBE_OUTPUT_INVALID',
      cause: error,
    });
  }

  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');

  const durationSeconds = Number(parsed.format?.duration ?? video?.duration);
  const fps = parseFrameRate(video?.avg_frame_rate ?? video?.r_frame_rate);
  const sizeBytes = Number(parsed.format?.size);

  return {
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1_000) : null,
    width: typeof video?.width === 'number' ? video.width : null,
    height: typeof video?.height === 'number' ? video.height : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    container: parsed.format?.format_name ?? null,
    hasAudio: audio !== undefined,
    fps: fps === null ? null : Math.round(fps * 100),
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
  };
}

/**
 * Progression lue dans `-progress pipe:1`.
 *
 * FFmpeg écrit `out_time_us` **et** `out_time_ms`, tous deux en
 * **microsecondes** (le nom du second est un vestige). Prendre les deux ferait
 * apparaître chaque mesure deux fois ; prendre le second seul donnerait un
 * pourcentage mille fois trop grand. La règle est donc explicite : `out_time_us`
 * gagne, `out_time_ms` ne sert que de repli sur un FFmpeg qui ne l'écrit pas.
 *
 * Quand la durée attendue est inconnue, le pourcentage vaut `null` : l'écran
 * affiche alors une étape, jamais un chiffre inventé (docs/10 §4.7).
 */
export function parseFfmpegProgressBlock(
  lines: readonly string[],
  expectedDurationMs?: number,
): FfmpegProgress | null {
  let outTimeMs: number | null = null;
  let frame: number | null = null;
  let speed: string | null = null;
  let sawOutTimeUs = false;

  for (const line of lines) {
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key === 'frame') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) frame = parsed;
      continue;
    }
    if (key === 'speed') {
      speed = value;
      continue;
    }
    if (key === 'out_time_us' || key === 'out_time_ms') {
      if (key === 'out_time_ms' && sawOutTimeUs) continue;
      const microseconds = Number(value);
      if (!Number.isFinite(microseconds)) continue;
      outTimeMs = Math.round(microseconds / 1_000);
      if (key === 'out_time_us') sawOutTimeUs = true;
    }
  }

  if (outTimeMs === null && frame === null && speed === null) return null;
  const percent =
    outTimeMs !== null && expectedDurationMs !== undefined && expectedDurationMs > 0
      ? Math.min(100, Math.max(0, Math.round((outTimeMs / expectedDurationMs) * 100)))
      : null;
  return { outTimeMs, frame, speed, percent };
}

/** Lecture d'une **seule** ligne de progression (l'unité que testent les tests). */
export function parseFfmpegProgress(
  line: string,
  expectedDurationMs?: number,
): FfmpegProgress | null {
  return parseFfmpegProgressBlock([line], expectedDurationMs);
}
