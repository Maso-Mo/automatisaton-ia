import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { CapabilityError, InternalError, ValidationError, type AsrEngine } from '@aia/shared';
import { spawnCommand, type CommandResult, type CommandRunner } from './exec';

export * from './exec';
export * from './ffmpeg';
export * from './hash';
export * from './manifest';
export * from './retention';
export * from './subtitles';
export * from './video';

export interface StorageAdapter {
  put(key: string, data: Uint8Array): Promise<void>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getLocalPath(key: string): string;
}

function assertSafeStorageKey(key: string): void {
  if (key.length === 0 || isAbsolute(key) || key.includes('\0')) {
    throw new ValidationError('Clé de stockage invalide.', { code: 'STORAGE_KEY_INVALID' });
  }

  const normalized = key.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..')) {
    throw new ValidationError('Clé de stockage invalide.', { code: 'STORAGE_KEY_INVALID' });
  }
}

export class LocalStorageAdapter implements StorageAdapter {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  getLocalPath(key: string): string {
    assertSafeStorageKey(key);
    const target = resolve(this.root, key);
    const fromRoot = relative(this.root, target);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new ValidationError('Clé de stockage hors du répertoire média.', {
        code: 'STORAGE_KEY_INVALID',
      });
    }
    return target;
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    const target = this.getLocalPath(key);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.part`;
    try {
      await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.getLocalPath(key));
      return true;
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.getLocalPath(key), { force: true });
  }
}

export type SupportedAudioFormat = 'wav' | 'webm' | 'ogg' | 'mp3' | 'm4a';

export interface DetectedAudio {
  extension: SupportedAudioFormat;
  mime: string;
}

const MIMES: Record<SupportedAudioFormat, readonly string[]> = {
  wav: ['audio/wav', 'audio/wave', 'audio/x-wav'],
  webm: ['audio/webm', 'video/webm'],
  ogg: ['audio/ogg', 'application/ogg'],
  mp3: ['audio/mpeg', 'audio/mp3'],
  m4a: ['audio/mp4', 'audio/x-m4a', 'video/mp4'],
};

function normalizedMime(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function detectAudioFormat(data: Uint8Array, declaredMime: string): DetectedAudio {
  if (data.byteLength < 4) {
    throw new ValidationError('Le fichier audio est vide ou incomplet.', {
      code: 'AUDIO_FORMAT_UNSUPPORTED',
    });
  }

  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let extension: SupportedAudioFormat | undefined;
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WAVE'
  ) {
    extension = 'wav';
  } else if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    extension = 'webm';
  } else if (bytes.toString('ascii', 0, 4) === 'OggS') {
    extension = 'ogg';
  } else if (
    bytes.toString('ascii', 0, 3) === 'ID3' ||
    (bytes[0] === 0xff && bytes[1] !== undefined && (bytes[1] & 0xe0) === 0xe0)
  ) {
    extension = 'mp3';
  } else if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    extension = 'm4a';
  }

  if (extension === undefined) {
    throw new ValidationError('Format audio non pris en charge.', {
      code: 'AUDIO_FORMAT_UNSUPPORTED',
    });
  }

  const mime = normalizedMime(declaredMime);
  if (mime !== 'application/octet-stream' && !MIMES[extension].includes(mime)) {
    throw new ValidationError('Le type déclaré ne correspond pas au contenu audio.', {
      code: 'AUDIO_MIME_MISMATCH',
      details: { declaredMime: mime, detectedFormat: extension },
    });
  }

  return { extension, mime: MIMES[extension][0]! };
}

export function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function voiceStorageKey(
  hash: string,
  assetId: string,
  extension: SupportedAudioFormat,
  now: Date,
): string {
  const year = String(now.getUTCFullYear()).padStart(4, '0');
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return join(year + month, hash.slice(0, 2), `${assetId}.${extension}`);
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  durationMs: number | null;
}

export interface TranscriberHealth {
  available: boolean;
  engine: string;
  model: string;
  detail?: string;
}

export interface Transcriber {
  readonly engine: AsrEngine;
  readonly model: string;
  healthCheck(): Promise<TranscriberHealth>;
  transcribe(inputPath: string, language?: string): Promise<TranscriptionResult>;
}

export * from './exec';

export function buildNormalizeAudioArgs(inputPath: string, outputPath: string): string[] {
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outputPath,
  ];
}

export function buildWhisperArgs(
  modelPath: string,
  inputPath: string,
  outputPrefix: string,
  language = 'fr',
): string[] {
  return ['-m', modelPath, '-f', inputPath, '-l', language, '-ojf', '-of', outputPrefix, '-np'];
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{
    text?: string;
    offsets?: { from?: number; to?: number };
    timestamps?: { from?: string; to?: string };
  }>;
}

export function parseWhisperJson(value: unknown): TranscriptionResult {
  if (value === null || typeof value !== 'object') {
    throw new InternalError('Réponse JSON invalide de whisper.cpp.', {
      code: 'WHISPER_OUTPUT_INVALID',
    });
  }
  const parsed = value as WhisperJson;
  if (!Array.isArray(parsed.transcription)) {
    throw new InternalError('Segments absents de la réponse whisper.cpp.', {
      code: 'WHISPER_OUTPUT_INVALID',
    });
  }

  const segments = parsed.transcription.map((segment) => ({
    startMs: Math.max(0, Math.round(segment.offsets?.from ?? 0)),
    endMs: Math.max(0, Math.round(segment.offsets?.to ?? 0)),
    text: segment.text?.trim() ?? '',
  }));
  const text = segments
    .map((segment) => segment.text)
    .filter(Boolean)
    .join(' ')
    .trim();
  const durationMs =
    segments.length === 0 ? null : Math.max(...segments.map((segment) => segment.endMs));
  return {
    text,
    segments,
    language: parsed.result?.language ?? null,
    durationMs,
  };
}

export interface WhisperCppOptions {
  whisperBin: string;
  modelPath: string;
  ffmpegBin: string;
  runner?: CommandRunner;
  temporaryRoot?: string;
}

export class WhisperCppTranscriber implements Transcriber {
  readonly engine = 'whisper_cpp';
  readonly model: string;
  private readonly runner: CommandRunner;

  constructor(private readonly options: WhisperCppOptions) {
    this.model = basename(options.modelPath, extname(options.modelPath));
    this.runner = options.runner ?? spawnCommand;
  }

  /**
   * Le moteur répond « disponible » ou explique **pourquoi non**, dans une phrase
   * que l'écran peut afficher telle quelle (elle est recopiée par
   * `GET /media/capabilities`, puis par l'entrée vocale).
   *
   * Les trois causes possibles sont distinguées, parce qu'elles n'appellent pas
   * le même geste : le modèle manque (le télécharger), le binaire ne se lance pas
   * (l'installer), le binaire répond en erreur (lire ce qu'il dit).
   */
  async healthCheck(): Promise<TranscriberHealth> {
    const unavailable = (detail: string): TranscriberHealth => ({
      available: false,
      engine: this.engine,
      model: this.model,
      detail,
    });

    try {
      await access(this.options.modelPath);
    } catch {
      return unavailable(
        `Modèle whisper absent : ${this.options.modelPath}. Téléchargez un modèle ` +
          '(par exemple ggml-small.bin) et pointez WHISPER_MODEL_PATH dessus.',
      );
    }

    let result: CommandResult;
    try {
      result = await this.runner(this.options.whisperBin, ['-h']);
    } catch {
      return unavailable(
        `Binaire « ${this.options.whisperBin} » introuvable ou inexécutable. ` +
          'Installez whisper.cpp ou indiquez son chemin dans WHISPER_BIN.',
      );
    }
    if (result.exitCode !== 0) {
      // Le message du binaire est repris tel quel : c'est lui qui sait ce qui
      // ne va pas (bibliothèque manquante, modèle corrompu).
      return unavailable(
        result.stderr.trim() || `« ${this.options.whisperBin} » a répondu ${result.exitCode}.`,
      );
    }
    return { available: true, engine: this.engine, model: this.model };
  }

  async transcribe(inputPath: string, language = 'fr'): Promise<TranscriptionResult> {
    const root = this.options.temporaryRoot ?? tmpdir();
    const runDirectory = join(root, `aia-transcription-${randomUUID()}`);
    const normalizedPath = join(runDirectory, 'audio.wav');
    const outputPrefix = join(runDirectory, 'transcript');
    await mkdir(runDirectory, { recursive: true });

    try {
      const normalized = await this.runner(
        this.options.ffmpegBin,
        buildNormalizeAudioArgs(inputPath, normalizedPath),
      );
      if (normalized.exitCode !== 0) {
        throw new ValidationError('FFmpeg ne peut pas décoder cet enregistrement.', {
          code: 'AUDIO_DECODE_FAILED',
          details: { stderr: normalized.stderr.slice(-2_000) },
        });
      }

      const transcribed = await this.runner(
        this.options.whisperBin,
        buildWhisperArgs(this.options.modelPath, normalizedPath, outputPrefix, language),
      );
      if (transcribed.exitCode !== 0) {
        throw new CapabilityError('La transcription locale a échoué.', {
          code: 'WHISPER_FAILED',
          details: { stderr: transcribed.stderr.slice(-2_000) },
        });
      }

      return parseWhisperJson(JSON.parse(await readFile(`${outputPrefix}.json`, 'utf8')));
    } catch (error) {
      if (
        error instanceof ValidationError ||
        error instanceof CapabilityError ||
        error instanceof InternalError
      ) {
        throw error;
      }
      throw new CapabilityError('Le moteur de transcription locale est indisponible.', {
        code: 'WHISPER_UNAVAILABLE',
        cause: error,
      });
    } finally {
      await rm(runDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Le **fournisseur scripté** : la chaîne vocale se teste sans whisper.cpp, sans
 * FFmpeg et sans modèle téléchargé (docs/09 §1.1 : aucun test ne dépend d'un
 * binaire externe, ni du réseau).
 *
 * Il ne remplace jamais `WhisperCppTranscriber` en production : il rend la
 * chaîne *déterministe* en test. Trois leviers, tous explicites :
 *
 * - `text` / `segments` : la sortie servie, toujours la même ;
 * - `available` : ce que répond `healthCheck()` — c'est ce qui pilote l'état de
 *   l'écran « transcription indisponible » quand le binaire manque ;
 * - `failures` + `failure` : le nombre d'appels qui échouent **avant** de
 *   réussir, et l'erreur levée. Une erreur transitoire produit une **reprise
 *   réelle** de la file ; une erreur de capacité n'en produit aucune — la
 *   politique de retry reste celle de la queue (docs/02 §12), pas celle du
 *   script.
 */
export interface ScriptedTranscriberOptions {
  engine?: AsrEngine;
  model?: string;
  text?: string;
  segments?: TranscriptSegment[];
  language?: string | null;
  durationMs?: number | null;
  available?: boolean;
  unavailableDetail?: string;
  failures?: number;
  failure?: () => unknown;
}

export const SCRIPTED_TRANSCRIPT_TEXT =
  'J’ai automatisé la facturation avec n8n et je veux raconter le montage exact.';

export class ScriptedTranscriber implements Transcriber {
  readonly engine: AsrEngine;
  readonly model: string;
  private readonly text: string;
  private readonly segments: TranscriptSegment[];
  private readonly language: string | null;
  private readonly durationMs: number | null;
  private readonly detail: string | undefined;
  private readonly failures: number;
  private readonly failure: () => unknown;
  private calls = 0;

  constructor(private readonly options: ScriptedTranscriberOptions = {}) {
    this.engine = options.engine ?? 'whisper_cpp';
    this.model = options.model ?? 'small';
    this.text = options.text ?? SCRIPTED_TRANSCRIPT_TEXT;
    this.segments = options.segments ?? [
      { startMs: 0, endMs: options.durationMs ?? 4_200, text: this.text },
    ];
    this.language = options.language ?? 'fr';
    this.durationMs = options.durationMs ?? 4_200;
    this.detail = options.unavailableDetail;
    this.failures = options.failures ?? 0;
    this.failure = options.failure ?? (() => new Error('échec scripté de la transcription'));
  }

  /** Le nombre d'appels réellement reçus : ce que le test peut vérifier. */
  get callCount(): number {
    return this.calls;
  }

  async healthCheck(): Promise<TranscriberHealth> {
    const available = this.options.available ?? true;
    return available
      ? { available: true, engine: this.engine, model: this.model }
      : {
          available: false,
          engine: this.engine,
          model: this.model,
          detail: this.detail ?? 'moteur scripté indisponible (choix du test)',
        };
  }

  async transcribe(_inputPath: string, language = 'fr'): Promise<TranscriptionResult> {
    this.calls += 1;
    if (this.calls <= this.failures) {
      throw this.failure();
    }
    return {
      text: this.text,
      segments: this.segments,
      language: language === 'fr' ? this.language : language,
      durationMs: this.durationMs,
    };
  }
}
