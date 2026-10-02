import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapabilityError, ValidationError } from '@aia/shared';

import {
  buildNormalizeAudioArgs,
  buildWhisperArgs,
  detectAudioFormat,
  LocalStorageAdapter,
  parseWhisperJson,
  ScriptedTranscriber,
  SCRIPTED_TRANSCRIPT_TEXT,
  sha256,
  voiceStorageKey,
  WhisperCppTranscriber,
  type CommandRunner,
} from './index';
import { DEFAULT_AUDIO_RETENTION_MS, decideAudioPurge, sweepOrphanAudio } from './retention';

/**
 * Ces tests couvrent la partie du paquet média qu'aucun test d'intégration ne
 * peut prouver sans binaire : la **validation du contenu**, la **clé de
 * stockage**, les **arguments lancés** et le **décodage de la réponse
 * whisper.cpp**. Le processus externe est simulé (`runner` injecté), donc aucun
 * test ne dépend de `whisper-cli`, de FFmpeg ni d'un modèle téléchargé
 * (docs/09 §1.1) — ce qui permet de tester aussi les cas d'échec, impossibles à
 * reproduire avec un vrai binaire.
 */

const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x86, 0x81, 0x01, 0x00, 0x00, 0x00, 0x00]);
const WAV = Buffer.from('RIFF\x24\x08\x00\x00WAVEfmt ', 'binary');
const OGG = Buffer.from('OggS\x00\x02\x00\x00', 'binary');
const MP3_ID3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'binary');
const M4A = Buffer.from('\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00', 'binary');
const ZIP = Buffer.from('PK\x03\x04\x14\x00\x00\x00', 'binary');

/** Le code porté par l'erreur — c'est lui qui décide du comportement (docs/02 §12). */
async function rejectionCodeOf(run: () => Promise<unknown> | unknown): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('l’appel aurait dû échouer');
}

describe('format audio : le contenu décide, pas le nom de fichier (docs/05 §3.2)', () => {
  it('reconnaît les cinq conteneurs acceptés par signature, et ignore les paramètres du type déclaré', () => {
    expect(detectAudioFormat(WEBM, 'audio/webm;codecs=opus').extension).toBe('webm');
    expect(detectAudioFormat(WAV, 'audio/wav').extension).toBe('wav');
    expect(detectAudioFormat(WAV, 'audio/x-wav').extension).toBe('wav');
    expect(detectAudioFormat(OGG, 'audio/ogg').extension).toBe('ogg');
    expect(detectAudioFormat(MP3_ID3, 'audio/mpeg').extension).toBe('mp3');
    // Un MP3 à trame de synchronisation (sans tag ID3) reste un MP3.
    expect(detectAudioFormat(Buffer.from([0xff, 0xfb, 0x90, 0x00]), 'audio/mpeg').extension).toBe(
      'mp3',
    );
    expect(detectAudioFormat(M4A, 'audio/mp4').extension).toBe('m4a');
  });

  it('rend le type canonique à annoncer, pas celui envoyé par le navigateur', () => {
    expect(detectAudioFormat(WEBM, 'audio/webm;codecs=opus')).toEqual({
      extension: 'webm',
      mime: 'audio/webm',
    });
    expect(detectAudioFormat(WAV, 'audio/x-wav').mime).toBe('audio/wav');
  });

  it('accepte un corps déclaré en flux binaire : il n’y a alors aucun mensonge possible', () => {
    expect(detectAudioFormat(WEBM, 'application/octet-stream').mime).toBe('audio/webm');
  });

  it('refuse un contenu qui n’est pas de l’audio, même avec un type audio déclaré', async () => {
    expect(await rejectionCodeOf(() => detectAudioFormat(ZIP, 'audio/webm'))).toBe(
      'AUDIO_FORMAT_UNSUPPORTED',
    );
    expect(() => detectAudioFormat(ZIP, 'audio/webm')).toThrow(ValidationError);
  });

  it('refuse un corps vide ou trop court pour être identifié', async () => {
    expect(await rejectionCodeOf(() => detectAudioFormat(Buffer.alloc(0), 'audio/webm'))).toBe(
      'AUDIO_FORMAT_UNSUPPORTED',
    );
    expect(await rejectionCodeOf(() => detectAudioFormat(Buffer.from('ID3'), 'audio/webm'))).toBe(
      'AUDIO_FORMAT_UNSUPPORTED',
    );
  });

  it('refuse un type déclaré qui ment sur le contenu', async () => {
    expect(await rejectionCodeOf(() => detectAudioFormat(WEBM, 'audio/wav'))).toBe(
      'AUDIO_MIME_MISMATCH',
    );
    expect(await rejectionCodeOf(() => detectAudioFormat(WAV, 'audio/webm'))).toBe(
      'AUDIO_MIME_MISMATCH',
    );
  });
});

describe('clé de stockage : dérivée de l’empreinte, jamais du nom envoyé', () => {
  it('range par mois et par préfixe d’empreinte, avec un chemin relatif', () => {
    const key = voiceStorageKey('ab12cd', 'asset-1', 'webm', new Date('2026-10-02T10:00:00Z'));
    expect(key).toBe('202610/ab/asset-1.webm');
    expect(key.startsWith('/')).toBe(false);
    expect(key.includes('..')).toBe(false);
  });

  it('calcule une empreinte stable et hexadécimale, qui déduplique le même contenu', () => {
    const first = sha256(WEBM);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(WEBM)).toBe(first);
    // Un octet de différence change l'empreinte : deux enregistrements distincts
    // ne se dédupliquent jamais par accident.
    expect(sha256(Buffer.concat([WEBM, Buffer.from([0x00])]))).not.toBe(first);
  });
});

describe('stockage local : sandbox de clés et écriture non lisible par les autres', () => {
  let root: string;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aia-media-storage-'));
    storage = new LocalStorageAdapter(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('écrit, relit et supprime un fichier, en mode 0600', async () => {
    const key = '202610/ab/asset-1.webm';
    await storage.put(key, WEBM);

    expect(await storage.exists(key)).toBe(true);
    expect(await readFile(join(root, key))).toEqual(WEBM);
    expect((await stat(join(root, key))).mode & 0o777).toBe(0o600);
    // Aucun fichier temporaire ne survit à l'écriture : rien à nettoyer plus tard.
    expect(await readdir(join(root, '202610/ab'))).toEqual(['asset-1.webm']);

    await storage.delete(key);
    expect(await storage.exists(key)).toBe(false);
    // Supprimer deux fois n'est pas une erreur : le balayage peut repasser.
    await expect(storage.delete(key)).resolves.toBeUndefined();
  });

  it('refuse une clé qui sortirait du répertoire média', async () => {
    for (const key of ['', '/etc/passwd', '../evade.webm', 'a/../../evade.webm', 'a\0b.webm']) {
      expect(await rejectionCodeOf(() => storage.getLocalPath(key))).toBe('STORAGE_KEY_INVALID');
    }
    await expect(storage.put('../evade.webm', WEBM)).rejects.toThrow(ValidationError);
    await expect(storage.exists('../evade.webm')).rejects.toThrow(ValidationError);
    await expect(storage.delete('../evade.webm')).rejects.toThrow(ValidationError);
  });

  it('refuse aussi une traversée écrite avec les séparateurs de Windows', async () => {
    // La clé est normalisée en `/` avant contrôle : la règle est la même quel que
    // soit le système qui a produit la clé (ou qui a écrit le fichier).
    expect(await rejectionCodeOf(() => storage.getLocalPath('..\\evade.webm'))).toBe(
      'STORAGE_KEY_INVALID',
    );
    expect(
      await rejectionCodeOf(() => storage.getLocalPath('202610\\ab\\..\\..\\evade.webm')),
    ).toBe('STORAGE_KEY_INVALID');
  });

  it('ne confond pas un point dans un identifiant avec une remontée de dossier', async () => {
    // La règle interdit le **composant** `..`, pas le caractère `.` : un
    // identifiant qui contient des points reste légitime et reste dans la racine.
    const key = '202610/ab/asset..1.webm';
    await storage.put(key, WEBM);
    expect(storage.getLocalPath(key)).toBe(join(root, key));
  });
});
describe('processus externes : des arguments construits, jamais une ligne de shell (docs/02 §9.6)', () => {
  it('normalise en WAV mono 16 kHz, sans interaction et sans piste vidéo', () => {
    expect(buildNormalizeAudioArgs('/data/media/a.webm', '/tmp/run/audio.wav')).toEqual([
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      '/data/media/a.webm',
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      '/tmp/run/audio.wav',
    ]);
  });

  it('demande à whisper.cpp un JSON de segments horodatés, en français par défaut', () => {
    expect(
      buildWhisperArgs('data/models/ggml-small.bin', '/tmp/run/audio.wav', '/tmp/run/tr'),
    ).toEqual([
      '-m',
      'data/models/ggml-small.bin',
      '-f',
      '/tmp/run/audio.wav',
      '-l',
      'fr',
      '-ojf',
      '-of',
      '/tmp/run/tr',
      '-np',
    ]);
  });

  it('garde un chemin hostile en **un seul** argument : il n’y a rien à interpréter', () => {
    // Un nom de fichier contenant `; rm -rf ~` ne peut pas devenir une commande,
    // parce que le processus est lancé sans shell et que l'argument reste entier.
    const hostile = '/data/media/202610/ab/x; rm -rf ~.webm';
    const normalize = buildNormalizeAudioArgs(hostile, '/tmp/run/audio.wav');
    expect(normalize).toHaveLength(15);
    expect(normalize.filter((argument) => argument === hostile)).toEqual([hostile]);

    const whisper = buildWhisperArgs('data/models/m.bin', hostile, '/tmp/run/tr', 'fr');
    expect(whisper).toHaveLength(10);
    expect(whisper[3]).toBe(hostile);
  });
});

describe('réponse de whisper.cpp : lue, pas devinée', () => {
  it('recolle les segments, garde la langue et déduit la durée du dernier segment', () => {
    expect(
      parseWhisperJson({
        result: { language: 'fr' },
        transcription: [
          { text: ' Bonjour ', offsets: { from: 0, to: 1_200 } },
          { text: ' le monde. ', offsets: { from: 1_200, to: 2_400 } },
          { text: '   ', offsets: { from: 2_400, to: 2_600 } },
        ],
      }),
    ).toEqual({
      text: 'Bonjour le monde.',
      segments: [
        { startMs: 0, endMs: 1_200, text: 'Bonjour' },
        { startMs: 1_200, endMs: 2_400, text: 'le monde.' },
        { startMs: 2_400, endMs: 2_600, text: '' },
      ],
      language: 'fr',
      durationMs: 2_600,
    });
  });

  it('accepte une transcription vide : un silence n’est pas une panne', () => {
    expect(parseWhisperJson({ transcription: [] })).toEqual({
      text: '',
      segments: [],
      language: null,
      durationMs: null,
    });
  });

  it('traduit une sortie illisible en erreur interne, avec un code exploitable', async () => {
    expect(await rejectionCodeOf(() => parseWhisperJson('texte brut'))).toBe(
      'WHISPER_OUTPUT_INVALID',
    );
    expect(await rejectionCodeOf(() => parseWhisperJson({ result: {} }))).toBe(
      'WHISPER_OUTPUT_INVALID',
    );
  });
});

const WHISPER_JSON = {
  result: { language: 'fr' },
  transcription: [
    { text: ' Bonjour ', offsets: { from: 0, to: 1_200 } },
    { text: ' le monde. ', offsets: { from: 1_200, to: 2_400 } },
  ],
};

interface FakePipeline {
  calls: { command: string; args: readonly string[] }[];
  runner: CommandRunner;
}

/**
 * Simule les deux processus externes en **écrivant réellement leurs sorties** :
 * FFmpeg le WAV normalisé, whisper.cpp le JSON à côté du préfixe `-of`. Le code
 * testé lit donc un vrai fichier, avec les vrais arguments qu'il a construits —
 * la plomberie est vérifiée, seul le binaire est remplacé (docs/09 §1.1).
 */
function fakePipeline(
  options: { ffmpegExit?: number; whisperExit?: number; transcript?: unknown } = {},
): FakePipeline {
  const calls: FakePipeline['calls'] = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    if (command === 'ffmpeg') {
      if ((options.ffmpegExit ?? 0) === 0) await writeFile(args[args.length - 1]!, 'RIFF', 'utf8');
      return { exitCode: options.ffmpegExit ?? 0, stdout: '', stderr: 'ffmpeg : flux illisible' };
    }
    const prefixIndex = args.indexOf('-of');
    // `healthCheck()` interroge le binaire avec `-h` seul : il n'y a alors aucun
    // `-of`, donc **rien à écrire**. Écrire quand même placerait le JSON à côté
    // du dossier de travail (`-h.json`, relatif au répertoire courant), c'est-à-dire
    // un fichier dans le dépôt — le test doit être incapable de salir son
    // environnement (docs/09 §1.1).
    if (prefixIndex === -1) {
      return { exitCode: options.whisperExit ?? 0, stdout: '', stderr: 'whisper : échec' };
    }
    await writeFile(
      `${args[prefixIndex + 1]}.json`,
      JSON.stringify(options.transcript ?? WHISPER_JSON),
      'utf8',
    );
    return { exitCode: options.whisperExit ?? 0, stdout: '', stderr: 'whisper : échec' };
  };
  return { calls, runner };
}

describe('transcription whisper.cpp : le processus est simulé, la plomberie est réelle', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'aia-media-asr-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  function transcriberWith(run: FakePipeline): WhisperCppTranscriber {
    return new WhisperCppTranscriber({
      whisperBin: 'whisper-cli',
      modelPath: join(tempRoot, 'ggml-small.bin'),
      ffmpegBin: 'ffmpeg',
      runner: run.runner,
      temporaryRoot: tempRoot,
    });
  }

  it('expose le moteur et le nom du modèle : c’est ce que la base stocke', () => {
    const transcriber = transcriberWith(fakePipeline());
    expect(transcriber.engine).toBe('whisper_cpp');
    expect(transcriber.model).toBe('ggml-small');
  });

  it('décode puis transcrit, dans cet ordre, et efface son dossier de travail', async () => {
    const run = fakePipeline();
    const result = await transcriberWith(run).transcribe('/data/media/a.webm');

    expect(run.calls.map((call) => call.command)).toEqual(['ffmpeg', 'whisper-cli']);
    expect(result.text).toBe('Bonjour le monde.');
    expect(result.language).toBe('fr');
    expect(result.durationMs).toBe(2_400);
    // Rien ne reste sur le disque : l'audio normalisé ne survit pas à la
    // transcription (seul l'original, géré par le stockage, est conservé).
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('ne lance jamais whisper.cpp si le décodage échoue, et classe l’échec en validation', async () => {
    const run = fakePipeline({ ffmpegExit: 1 });
    const transcriber = transcriberWith(run);

    await expect(transcriber.transcribe('/data/media/a.webm')).rejects.toThrow(ValidationError);
    expect(await rejectionCodeOf(() => transcriber.transcribe('/data/media/a.webm'))).toBe(
      'AUDIO_DECODE_FAILED',
    );
    // Deux appels en tout : les deux sont des décodages, aucun whisper lancé.
    expect(run.calls.every((call) => call.command === 'ffmpeg')).toBe(true);
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('classe un échec de whisper.cpp en capacité, et efface quand même son dossier', async () => {
    const run = fakePipeline({ whisperExit: 1 });
    const transcriber = transcriberWith(run);

    await expect(transcriber.transcribe('/data/media/a.webm')).rejects.toThrow(CapabilityError);
    expect(await rejectionCodeOf(() => transcriber.transcribe('/data/media/a.webm'))).toBe(
      'WHISPER_FAILED',
    );
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('classe une sortie illisible en erreur interne, sans la confondre avec une panne du moteur', async () => {
    const run = fakePipeline({ transcript: { result: { language: 'fr' } } });
    expect(await rejectionCodeOf(() => transcriberWith(run).transcribe('/data/media/a.webm'))).toBe(
      'WHISPER_OUTPUT_INVALID',
    );
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it('annonce une capacité indisponible quand le modèle manque, sans lever', async () => {
    const health = await transcriberWith(fakePipeline()).healthCheck();
    expect(health).toMatchObject({ available: false, engine: 'whisper_cpp', model: 'ggml-small' });
    // Le détail est affiché tel quel par l'écran : il doit nommer le fichier
    // attendu, pas un code d'erreur du système.
    expect(health.detail).toContain('Modèle whisper absent');
    expect(health.detail).toContain('ggml-small.bin');
    expect(health.detail).not.toContain('ENOENT');
  });

  it('annonce la capacité disponible quand le modèle est là et que le binaire répond', async () => {
    await writeFile(join(tempRoot, 'ggml-small.bin'), '', 'utf8');
    const health = await transcriberWith(fakePipeline()).healthCheck();
    expect(health).toEqual({ available: true, engine: 'whisper_cpp', model: 'ggml-small' });
  });

  it('annonce la capacité indisponible quand le binaire répond en erreur', async () => {
    await writeFile(join(tempRoot, 'ggml-small.bin'), '', 'utf8');
    const failing = new WhisperCppTranscriber({
      whisperBin: 'whisper-cli',
      modelPath: join(tempRoot, 'ggml-small.bin'),
      ffmpegBin: 'ffmpeg',
      runner: async () => ({ exitCode: 1, stdout: '', stderr: 'binaire inconnu' }),
      temporaryRoot: tempRoot,
    });
    expect(await failing.healthCheck()).toMatchObject({
      available: false,
      detail: 'binaire inconnu',
    });
  });

  it('nomme le binaire quand il ne peut pas être lancé du tout, au lieu de « spawn ENOENT »', async () => {
    await writeFile(join(tempRoot, 'ggml-small.bin'), '', 'utf8');
    const missing = new WhisperCppTranscriber({
      whisperBin: 'whisper-cli-absent-du-poste',
      modelPath: join(tempRoot, 'ggml-small.bin'),
      ffmpegBin: 'ffmpeg',
      runner: async () => {
        throw new Error('spawn whisper-cli ENOENT');
      },
      temporaryRoot: tempRoot,
    });

    const health = await missing.healthCheck();
    expect(health.available).toBe(false);
    expect(health.detail).toContain('whisper-cli-absent-du-poste');
    expect(health.detail).toContain('WHISPER_BIN');
  });
});

describe('moteur scripté : ce qui remplace le binaire en test, sans le simuler à moitié', () => {
  it('échoue les N premiers appels puis réussit : une reprise réelle de la file est observable', async () => {
    const transcriber = new ScriptedTranscriber({
      failures: 2,
      failure: () =>
        new CapabilityError('moteur momentanément absent', { code: 'WHISPER_UNAVAILABLE' }),
    });

    await expect(transcriber.transcribe('/data/media/a.webm')).rejects.toThrow(CapabilityError);
    await expect(transcriber.transcribe('/data/media/a.webm')).rejects.toThrow(CapabilityError);
    await expect(transcriber.transcribe('/data/media/a.webm')).resolves.toMatchObject({
      text: SCRIPTED_TRANSCRIPT_TEXT,
      language: 'fr',
    });
    expect(transcriber.callCount).toBe(3);
  });

  it('rend la langue demandée par l’appel, pour que le test puisse la forcer', async () => {
    const transcriber = new ScriptedTranscriber();
    await expect(transcriber.transcribe('/data/media/a.webm', 'en')).resolves.toMatchObject({
      language: 'en',
    });
  });

  it('annonce l’indisponibilité avec le détail choisi par le test, et l’explique sans le binaire', async () => {
    const unavailable = new ScriptedTranscriber({
      available: false,
      unavailableDetail: 'whisper-cli introuvable',
    });
    expect(await unavailable.healthCheck()).toEqual({
      available: false,
      engine: 'whisper_cpp',
      model: 'small',
      detail: 'whisper-cli introuvable',
    });
    expect(await new ScriptedTranscriber().healthCheck()).toMatchObject({ available: true });
  });
});

describe('rétention des audios : la preuve de ce qui a été envoyé ne s’efface pas (docs/03 §12.1)', () => {
  const nowMs = Date.UTC(2026, 9, 2, 12, 0, 0);
  const retentionMs = DEFAULT_AUDIO_RETENTION_MS;

  it('ne purge jamais un audio rattaché à un message, même sans compteur à jour', () => {
    expect(
      decideAudioPurge({
        usageCount: 1,
        attachedToMessage: false,
        createdAtMs: nowMs - 10 * retentionMs,
        nowMs,
        retentionMs,
      }).purge,
    ).toBe(false);
    expect(
      decideAudioPurge({
        usageCount: 0,
        attachedToMessage: true,
        createdAtMs: nowMs - 10 * retentionMs,
        nowMs,
        retentionMs,
      }).purge,
    ).toBe(false);
  });

  it('conserve un orphelin récent : la fenêtre de reprise et de correction est ouverte', () => {
    const decision = decideAudioPurge({
      usageCount: 0,
      attachedToMessage: false,
      createdAtMs: nowMs - 60_000,
      nowMs,
      retentionMs,
    });
    expect(decision.purge).toBe(false);
    expect(decision.reason).toContain('fenêtre de reprise');
  });

  it('purge un orphelin plus vieux que la fenêtre, en disant depuis quand', () => {
    const decision = decideAudioPurge({
      usageCount: 0,
      attachedToMessage: false,
      createdAtMs: nowMs - 40 * 86_400_000,
      nowMs,
      retentionMs,
    });
    expect(decision.purge).toBe(true);
    expect(decision.reason).toContain('40 jour');
  });

  it('examine les orphelins avant la fenêtre et supprime le fichier **avant** la ligne', async () => {
    const order: string[] = [];
    const cutoffs: number[] = [];
    const report = await sweepOrphanAudio({
      nowMs,
      retentionMs,
      store: {
        orphanAudioAssets: (cutoffMs) => {
          cutoffs.push(cutoffMs);
          return [
            { id: 'a1', storageKey: '202601/ab/a1.webm', usageCount: 0, createdAt: cutoffMs - 1 },
            // Trop récent : le candidat est examiné, mais gardé.
            { id: 'a2', storageKey: '202610/ab/a2.webm', usageCount: 0, createdAt: nowMs - 1_000 },
          ];
        },
        deleteAsset: (id) => order.push(`ligne:${id}`),
      },
      storage: {
        delete: async (key) => {
          order.push(`fichier:${key}`);
        },
      },
    });

    expect(cutoffs).toEqual([nowMs - retentionMs]);
    expect(report.purged.map((entry) => entry.assetId)).toEqual(['a1']);
    expect(report.kept.map((entry) => entry.assetId)).toEqual(['a2']);
    // L'ordre fichier → ligne est le seul qui laisse un état réparable si le
    // processus est tué en cours : une ligne vers un fichier absent.
    expect(order).toEqual(['fichier:202601/ab/a1.webm', 'ligne:a1']);
  });

  it('en simulation, décide sans rien supprimer', async () => {
    const order: string[] = [];
    const report = await sweepOrphanAudio({
      nowMs,
      retentionMs,
      dryRun: true,
      store: {
        orphanAudioAssets: () => [
          { id: 'a1', storageKey: '202601/ab/a1.webm', usageCount: 0, createdAt: 0 },
        ],
        deleteAsset: (id) => order.push(`ligne:${id}`),
      },
      storage: {
        delete: async (key) => {
          order.push(`fichier:${key}`);
        },
      },
    });

    expect(report.dryRun).toBe(true);
    expect(report.purged).toHaveLength(1);
    expect(order).toEqual([]);
  });
});
