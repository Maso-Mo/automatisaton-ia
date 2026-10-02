import { afterEach, describe, expect, it } from 'vitest';
import { createMediaStore } from '@aia/database';
import {
  LocalStorageAdapter,
  SCRIPTED_TRANSCRIPT_TEXT,
  ScriptedTranscriber,
  sweepOrphanAudio,
} from '@aia/media';
import { CapabilityError, TransientError } from '@aia/shared';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createTranscribeMediaHandler } from '../../apps/worker/src/handlers/transcribe-media';
import { createWorkerLoop, type WorkerLoop } from '../../apps/worker/src/loop';
import {
  defaultBriefOutput,
  defaultInterviewerOutput,
  scriptedInterviewer,
  scriptedStrategist,
} from '../support/conversation';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * La chaîne vocale complète, **avec la vraie API, la vraie file et le vrai
 * handler du worker** (docs/05 §3.2, docs/10 §4.2).
 *
 * Ce que ces tests protègent, et qu'aucun test unitaire ne protège :
 *
 * - le contrat HTTP réel (statuts, codes d'erreur, déduplication par empreinte) ;
 * - le fait que **rien n'est envoyé avant la confirmation** : après un
 *   téléversement et une transcription réussie, la conversation ne contient
 *   encore aucun message ;
 * - la politique de reprise, qui appartient à la file : une erreur transitoire
 *   est reprise, une erreur de capacité ou une durée dépassée ne l'est pas.
 *
 * Le décodeur est `ScriptedTranscriber` (`@aia/media`) : aucun test ne dépend de
 * whisper.cpp, de FFmpeg, d'un modèle téléchargé ou du réseau (docs/09 §1.1).
 */

/** Un en-tête WebM (EBML) : le serveur reconnaît le **contenu**, jamais le nom. */
function webmFixture(bytes = 8_192): Buffer {
  const audio = Buffer.alloc(bytes, 0x11);
  Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(audio, 0);
  return audio;
}

/** Un en-tête WAV valide : RIFF…WAVE. */
function wavFixture(bytes = 2_048): Buffer {
  const audio = Buffer.alloc(bytes, 0x22);
  audio.write('RIFF', 0, 'ascii');
  audio.writeUInt32LE(bytes - 8, 4);
  audio.write('WAVE', 8, 'ascii');
  audio.write('fmt ', 12, 'ascii');
  return audio;
}

interface VoiceStack {
  app: ReturnType<typeof buildServer>;
  context: TestContext;
  transcriber: ScriptedTranscriber;
  loop: WorkerLoop;
  store: ReturnType<typeof createMediaStore>;
  storage: LocalStorageAdapter;
}

let created: VoiceStack[] = [];

afterEach(() => {
  for (const stack of created) stack.context.cleanup();
  created = [];
});

/**
 * La pile de test : API + handler `transcribe_media` + boucle de worker, sur une
 * base neuve. La file est **la même** des deux côtés — comme en production, où
 * l'API écrit et le worker lit le même fichier.
 */
function makeStack(
  options: {
    transcriber?: ScriptedTranscriber;
    env?: Record<string, string | undefined>;
    maxDurationMs?: number;
  } = {},
): VoiceStack {
  const context = createTestContext({ env: options.env });
  const store = createMediaStore(context.handle, () => context.clock.nowMs());
  const storage = new LocalStorageAdapter(context.config.paths.mediaRoot);
  const transcriber = options.transcriber ?? new ScriptedTranscriber();

  context.registry.register(
    createTranscribeMediaHandler({
      media: store,
      storage,
      transcriber,
      clock: context.clock,
      maxDurationMs: options.maxDurationMs,
    }),
  );

  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    transcriber,
    mediaQueue: context.queue,
    agents: {
      interviewer: () => ({
        agent: scriptedInterviewer([defaultInterviewerOutput()]),
        prompt: { promptVersionId: 'test', filePath: 'interviewer/converse.md' },
        lastCallId: () => null,
      }),
      strategist: () => ({
        agent: scriptedStrategist(defaultBriefOutput()),
        prompt: { promptVersionId: 'test-brief', filePath: 'strategist/master_brief.md' },
        lastCallId: () => null,
      }),
    },
  });

  const loop = createWorkerLoop({
    handle: context.handle,
    queue: context.queue,
    registry: context.registry,
    logger: context.logger,
    clock: context.clock,
    workerId: 'worker-voice-test',
    pollMs: 10,
    heartbeatMs: 1_000,
    batchSize: 2,
    offline: false,
  });

  const stack: VoiceStack = { app: buildServer(api), context, transcriber, loop, store, storage };
  created.push(stack);
  return stack;
}

type App = VoiceStack['app'];

async function createConversation(
  app: App,
): Promise<{ projectId: string; conversationId: string }> {
  const project = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: { name: 'Automatisation IA' },
  });
  expect(project.statusCode).toBe(201);
  const projectId = (project.json() as { project: { id: string } }).project.id;

  const conversation = await app.inject({
    method: 'POST',
    url: '/conversations',
    payload: { projectId },
  });
  expect(conversation.statusCode).toBe(201);
  return {
    projectId,
    conversationId: (conversation.json() as { conversation: { id: string } }).conversation.id,
  };
}

interface AssetBody {
  id: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string | null;
  usageCount: number;
  durationMs: number | null;
}

interface UploadResponse {
  statusCode: number;
  body: {
    asset?: AssetBody;
    jobId?: string;
    error?: { code?: string; category?: string; details?: Record<string, unknown> };
  };
}

async function upload(
  app: App,
  conversationId: string,
  audio: Buffer,
  options: { mime?: string; headers?: Record<string, string> } = {},
): Promise<UploadResponse> {
  const response = await app.inject({
    method: 'POST',
    url: `/conversations/${conversationId}/voice`,
    payload: audio,
    headers: {
      'content-type': options.mime ?? 'audio/webm',
      'content-length': String(audio.byteLength),
      ...options.headers,
    },
  });
  return { statusCode: response.statusCode, body: response.json() as UploadResponse['body'] };
}

/** Téléverse et exige un `202` : la fixture est valide, sinon le test est faux. */
async function uploadAccepted(
  app: App,
  conversationId: string,
  audio: Buffer,
  options: { mime?: string; headers?: Record<string, string> } = {},
): Promise<{ asset: AssetBody; jobId: string }> {
  const response = await upload(app, conversationId, audio, options);
  expect(response.statusCode, JSON.stringify(response.body)).toBe(202);
  return { asset: response.body.asset as AssetBody, jobId: response.body.jobId as string };
}

async function messagesOf(
  app: App,
  conversationId: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await app.inject({ method: 'GET', url: `/conversations/${conversationId}` });
  expect(response.statusCode).toBe(200);
  return (response.json() as { messages: Array<Record<string, unknown>> }).messages;
}

describe('téléversement vocal : contenu reconnu, jamais le nom (docs/05 §3.2)', () => {
  it('annonce ce que l’API accepte vraiment : capacité, taille et durée', async () => {
    const { app } = makeStack();
    const response = await app.inject({ method: 'GET', url: '/media/capabilities' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      transcription: { available: boolean; engine: string; model: string };
      maxUploadBytes: number;
      maxDurationMs: number;
      acceptedMimeTypes: string[];
    };

    expect(body.transcription).toMatchObject({ available: true, engine: 'whisper_cpp' });
    expect(body.maxUploadBytes).toBe(512 * 1024 * 1024);
    // La durée annoncée est celle que le worker fait respecter après décodage.
    expect(body.maxDurationMs).toBe(900_000);
    expect(body.acceptedMimeTypes).toContain('audio/webm');
  });

  it('accepte un WebM, fabrique la clé de stockage et déduplique par empreinte', async () => {
    const stack = makeStack();
    const { conversationId } = await createConversation(stack.app);
    const audio = webmFixture();

    const first = await uploadAccepted(stack.app, conversationId, audio, {
      // Un nom de fichier hostile ne doit changer **aucune** décision serveur.
      headers: { 'content-disposition': 'attachment; filename="../../etc/passwd.webm"' },
    });
    expect(first.asset.mimeType).toBe('audio/webm');
    expect(first.asset.originalFilename).toBeNull();
    expect(first.asset.storageKey).toMatch(/^\d{6}\/[0-9a-f]{2}\/[0-9a-f-]+\.webm$/);
    expect(first.asset.storageKey).not.toContain('..');
    expect(await stack.storage.exists(first.asset.storageKey)).toBe(true);

    // Même contenu, second envoi : même média, et **un seul job** (clé de
    // déduplication `transcribe:<assetId>:fr`), donc aucun travail en double.
    const second = await uploadAccepted(stack.app, conversationId, audio);
    expect(second.asset.id).toBe(first.asset.id);
    expect(second.jobId).toBe(first.jobId);
    expect(stack.store.orphanAudioAssets(Date.now() + 10_000_000)).toHaveLength(1);
  });

  it('refuse un contenu non audio, un type déclaré menteur et un corps vide', async () => {
    const { app } = makeStack();
    const { conversationId } = await createConversation(app);

    const unknown = await upload(app, conversationId, Buffer.from('ceci n’est pas un audio'));
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body.error?.code).toBe('AUDIO_FORMAT_UNSUPPORTED');

    // Le contenu est du WebM, le type annoncé du WAV : c'est le contenu qui gagne.
    const mismatch = await upload(app, conversationId, webmFixture(), { mime: 'audio/wav' });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.body.error?.code).toBe('AUDIO_MIME_MISMATCH');

    const empty = await upload(app, conversationId, Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
    expect(empty.body.error?.code).toBe('VOICE_BODY_REQUIRED');
  });

  it('traduit un dépassement de taille en « fichier trop volumineux »', async () => {
    const stack = makeStack({ env: { MEDIA_MAX_UPLOAD_MB: '1' } });
    const { conversationId } = await createConversation(stack.app);

    const response = await upload(stack.app, conversationId, webmFixture(1_500_000));
    expect(response.statusCode).toBe(413);
    expect(response.body.error?.code).toBe('UPLOAD_TOO_LARGE');
    // Rien n'a été écrit : le refus a lieu avant le gestionnaire.
    expect(stack.store.orphanAudioAssets(Date.now() + 10_000_000)).toHaveLength(0);
  });
});

describe('transcription locale : la file décide des reprises (docs/02 §12)', () => {
  it('transcrit l’audio, journalise les étapes et **n’envoie rien**', async () => {
    const stack = makeStack();
    const { conversationId } = await createConversation(stack.app);
    const { asset, jobId } = await uploadAccepted(stack.app, conversationId, webmFixture());

    expect(await stack.loop.runOnce()).toBe(1);

    const job = stack.context.queue.get(jobId);
    expect(job?.status).toBe('completed');
    expect(job?.attempt).toBe(1);
    // La dernière étape **écrite** est celle du décodage ; c'est l'événement
    // `done` (émis juste après) qui marque la fin, comme le lit l'écran.
    expect(job?.current_step).toBe('persist_transcript');
    expect(job?.progress).toBe(100);
    expect(stack.transcriber.callCount).toBe(1);

    // Les étapes sont lisibles par l'écran, sans trou de séquence.
    const events = stack.context.queue.events(jobId);
    const steps = events.map((event) => event.step);
    for (const step of ['load_audio', 'normalize_audio', 'persist_transcript', 'done']) {
      expect(steps, `étape attendue : ${step}`).toContain(step);
    }
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));

    // La transcription est relisible **immédiatement**.
    const read = await stack.app.inject({
      method: 'GET',
      url: `/conversations/${conversationId}/voice/${asset.id}/transcript`,
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as {
      transcript: { text: string; durationMs: number; editedBody: string | null; language: string };
    };
    expect(body.transcript.text).toBe(SCRIPTED_TRANSCRIPT_TEXT);
    expect(body.transcript.durationMs).toBe(4_200);
    expect(body.transcript.language).toBe('fr');
    // Aucune correction n'a encore été décidée : c'est l'utilisateur qui tranche.
    expect(body.transcript.editedBody).toBeNull();

    // **Le point qui compte :** la conversation est vide. Rien n'est envoyé
    // avant la confirmation explicite de l'utilisateur (docs/03 §7.2).
    expect(await messagesOf(stack.app, conversationId)).toHaveLength(0);

    // L'audio reste un brouillon : rattaché à rien, donc purgéable un jour.
    const stored = stack.store.asset(asset.id);
    expect(stored?.usageCount).toBe(0);
    expect(stored?.durationMs).toBe(4_200);
  });

  it('rejoue une erreur transitoire après le délai de la file, et réussit', async () => {
    const transcriber = new ScriptedTranscriber({
      failures: 1,
      failure: () => new TransientError('ffmpeg a échoué une fois', { code: 'FFMPEG_TRANSIENT' }),
    });
    const stack = makeStack({ transcriber });
    const { conversationId } = await createConversation(stack.app);
    const { asset, jobId } = await uploadAccepted(stack.app, conversationId, webmFixture());

    expect(await stack.loop.runOnce()).toBe(1);
    const retried = stack.context.queue.get(jobId);
    expect(retried?.status).toBe('queued');
    expect(retried?.attempt).toBe(1);
    expect(stack.context.queue.events(jobId).some((event) => event.step === 'retry')).toBe(true);
    expect(stack.context.queue.events(jobId).some((event) => event.step === 'failed')).toBe(false);

    // Le backoff de `transcribeMediaSpec` est de 30 s : avant, rien n'est dû.
    expect(await stack.loop.runOnce()).toBe(0);
    stack.context.clock.advance(31_000);

    expect(await stack.loop.runOnce()).toBe(1);
    const done = stack.context.queue.get(jobId);
    expect(done?.status).toBe('completed');
    expect(done?.attempt).toBe(2);
    expect(transcriber.callCount).toBe(2);
    expect(stack.store.transcriptForAsset(asset.id)?.text).toBe(SCRIPTED_TRANSCRIPT_TEXT);
    expect(await messagesOf(stack.app, conversationId)).toHaveLength(0);
  });

  it('ne rejoue ni un moteur absent (capacité) ni un audio trop long (validation)', async () => {
    const capability = new ScriptedTranscriber({
      failures: 99,
      failure: () =>
        new CapabilityError('whisper-cli introuvable', { code: 'WHISPER_UNAVAILABLE' }),
    });
    const stack = makeStack({ transcriber: capability });
    const { conversationId } = await createConversation(stack.app);
    const { asset, jobId } = await uploadAccepted(stack.app, conversationId, webmFixture());

    expect(await stack.loop.runOnce()).toBe(1);
    const failed = stack.context.queue.get(jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.attempt).toBe(1);
    expect(failed?.error_json).toContain('WHISPER_UNAVAILABLE');
    // Une panne de capacité ne se répare pas en réessayant : rien à reprendre.
    expect(await stack.loop.runOnce()).toBe(0);
    expect(capability.callCount).toBe(1);
    expect(stack.store.transcriptForAsset(asset.id)).toBeNull();

    // Même verdict pour un enregistrement plus long que la limite annoncée :
    // la durée n'est connue qu'après décodage, donc c'est le worker qui tranche.
    const long = makeStack({
      transcriber: new ScriptedTranscriber({ durationMs: 90_000 }),
      maxDurationMs: 60_000,
    });
    const second = await createConversation(long.app);
    const uploaded = await uploadAccepted(long.app, second.conversationId, wavFixture(), {
      mime: 'audio/wav',
    });

    expect(await long.loop.runOnce()).toBe(1);
    const refused = long.context.queue.get(uploaded.jobId);
    expect(refused?.status).toBe('failed');
    expect(refused?.attempt).toBe(1);
    expect(refused?.error_json).toContain('AUDIO_TOO_LONG');
    expect(await long.loop.runOnce()).toBe(0);
    expect(long.store.transcriptForAsset(uploaded.asset.id)).toBeNull();
  });

  it('réutilise la transcription déjà écrite au lieu de relancer le décodage', async () => {
    const stack = makeStack();
    const { projectId, conversationId } = await createConversation(stack.app);
    const { asset, jobId } = await uploadAccepted(stack.app, conversationId, webmFixture());

    expect(await stack.loop.runOnce()).toBe(1);
    expect(stack.transcriber.callCount).toBe(1);
    expect(stack.context.queue.get(jobId)?.status).toBe('completed');

    // Un second job pour **le même audio** (relance, reprise manuelle) ne doit
    // pas repayer un décodage : le handler constate la transcription et sort.
    const again = await stack.context.queue.enqueue(
      'transcribe_media',
      { assetId: asset.id, language: 'fr' },
      { projectId },
    );
    expect(await stack.loop.runOnce()).toBe(1);

    const events = stack.context.queue.events(again);
    const reused = events.find((event) => event.step === 'done');
    expect(reused?.data_json ?? '').toContain('reused');
    expect(stack.transcriber.callCount).toBe(1);
    // Une seule transcription en base : pas de doublon par réexécution.
    expect(stack.store.transcriptForAsset(asset.id)?.text).toBe(SCRIPTED_TRANSCRIPT_TEXT);
  });
});

describe('confirmation : le texte part quand l’utilisateur le décide', () => {
  it('refuse d’envoyer avant transcription, puis envoie le texte corrigé', async () => {
    const stack = makeStack();
    const { conversationId } = await createConversation(stack.app);
    const { asset } = await uploadAccepted(stack.app, conversationId, webmFixture());

    // 1. Pas encore de transcription : l'envoi est refusé, et rien n'est écrit.
    const tooEarly = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/voice/${asset.id}/send`,
      payload: { content: 'texte improvisé' },
    });
    expect(tooEarly.statusCode).toBe(404);
    expect((tooEarly.json() as { error: { code: string } }).error.code).toBe(
      'TRANSCRIPT_NOT_FOUND',
    );
    expect(await messagesOf(stack.app, conversationId)).toHaveLength(0);

    // 2. Transcription prête, mais texte vide : refus, toujours rien d'envoyé.
    expect(await stack.loop.runOnce()).toBe(1);
    const empty = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/voice/${asset.id}/send`,
      payload: { content: '   ' },
    });
    expect(empty.statusCode).toBe(400);
    expect((empty.json() as { error: { code: string } }).error.code).toBe('TRANSCRIPT_EMPTY');
    expect(await messagesOf(stack.app, conversationId)).toHaveLength(0);

    // 3. La correction de l'utilisateur est celle qui part — jamais la sortie
    //    brute du moteur : c'est la règle « relire avant d'envoyer ».
    const corrected = 'J’ai automatisé la facturation avec n8n, en trois soirées.';
    const sent = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/voice/${asset.id}/send`,
      payload: { content: corrected },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const body = sent.json() as {
      userMessage: { id: string; inputMode: string; content: string };
      transcript: { editedBody: string | null };
    };
    expect(body.userMessage.inputMode).toBe('voice');
    expect(body.userMessage.content).toBe(corrected);
    expect(body.transcript.editedBody).toBe(corrected);

    const messages = await messagesOf(stack.app, conversationId);
    const user = messages.find((message) => message.role === 'user');
    expect(user?.content).toBe(corrected);
    expect(user?.content).not.toBe(SCRIPTED_TRANSCRIPT_TEXT);

    // L'audio est maintenant rattaché : il devient la preuve de ce qui a été dit.
    expect(stack.store.asset(asset.id)?.usageCount).toBe(1);
  });
});

describe('annulation et rétention : ce qui peut disparaître, et ce qui reste', () => {
  it('supprime un brouillon (204) et refuse de supprimer un audio déjà envoyé (409)', async () => {
    const stack = makeStack();
    const { conversationId } = await createConversation(stack.app);

    // 1. Un brouillon jamais envoyé : le fichier part **avant** la ligne.
    const draft = await uploadAccepted(stack.app, conversationId, webmFixture());
    const deleted = await stack.app.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}/voice/${draft.asset.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(await stack.storage.exists(draft.asset.storageKey)).toBe(false);
    expect(stack.store.asset(draft.asset.id)).toBeNull();

    // Supprimer deux fois n'est pas une erreur silencieuse : c'est un 404 nommé.
    const again = await stack.app.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}/voice/${draft.asset.id}`,
    });
    expect(again.statusCode).toBe(404);
    expect((again.json() as { error: { code: string } }).error.code).toBe('VOICE_ASSET_NOT_FOUND');

    // 2. Un audio envoyé n'est plus un brouillon : le supprimer effacerait la
    //    preuve de ce qui a été publié (docs/03 §12.1).
    const attached = await uploadAccepted(stack.app, conversationId, wavFixture(), {
      mime: 'audio/wav',
    });
    // Deux jobs sont en file : celui du brouillon supprimé (que personne ne peut
    // plus transcrire) et celui de l'audio qui vient d'arriver.
    expect(await stack.loop.runOnce()).toBe(2);
    // Le job d'un audio annulé échoue proprement — sans reprise : il n'y a plus
    // rien à décoder, et réessayer ne changerait rien.
    const orphan = stack.context.queue.get(draft.jobId);
    expect(orphan?.status).toBe('failed');
    expect(orphan?.attempt).toBe(1);
    expect(orphan?.error_json).toContain('MEDIA_ASSET_NOT_FOUND');
    expect(await stack.loop.runOnce()).toBe(0);

    const sent = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/voice/${attached.asset.id}/send`,
      payload: { content: 'Texte relu par l’utilisateur.' },
    });
    expect(sent.statusCode).toBe(201);

    const refused = await stack.app.inject({
      method: 'DELETE',
      url: `/conversations/${conversationId}/voice/${attached.asset.id}`,
    });
    expect(refused.statusCode).toBe(409);
    expect((refused.json() as { error: { code: string } }).error.code).toBe('VOICE_ASSET_IN_USE');
    // Rien n'a bougé : ni la ligne, ni le fichier.
    expect(stack.store.asset(attached.asset.id)?.usageCount).toBe(1);
    expect(await stack.storage.exists(attached.asset.storageKey)).toBe(true);
  });

  it('diffuse l’état et les étapes du job de transcription en SSE', async () => {
    const stack = makeStack();
    const { conversationId } = await createConversation(stack.app);
    const { jobId } = await uploadAccepted(stack.app, conversationId, webmFixture());
    await stack.loop.runOnce();

    await stack.app.listen({ host: '127.0.0.1', port: 0 });
    const address = stack.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/events/jobs/${jobId}?intervalMs=250`, {
      headers: { accept: 'text/event-stream' },
      signal: AbortSignal.timeout(5_000),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    // L'état complet d'abord : une reprise ne perd aucune étape intermédiaire.
    expect(text).toContain('event: snapshot');
    expect(text).toContain('"type":"transcribe_media"');
    expect(text).toContain('event: job_event');
    expect(text).toContain('persist_transcript');
    expect(text).toContain('event: done');

    await stack.app.close();
  });

  it('purge les brouillons orphelins des vieux jours, jamais un audio envoyé', async () => {
    const stack = makeStack();
    const { conversationId } = await createConversation(stack.app);
    // L'audio envoyé d'abord, le brouillon ensuite : un seul job à la fois, donc
    // un `runOnce` sans ambiguïté.
    const attached = await uploadAccepted(stack.app, conversationId, wavFixture(), {
      mime: 'audio/wav',
    });
    expect(await stack.loop.runOnce()).toBe(1);
    const sent = await stack.app.inject({
      method: 'POST',
      url: `/conversations/${conversationId}/voice/${attached.asset.id}/send`,
      payload: { content: 'Texte relu, puis envoyé.' },
    });
    expect(sent.statusCode).toBe(201);
    const draft = await uploadAccepted(stack.app, conversationId, webmFixture());

    const sweep = (nowMs: number, dryRun?: boolean) =>
      sweepOrphanAudio({
        store: stack.store,
        storage: stack.storage,
        nowMs,
        ...(dryRun === undefined ? {} : { dryRun }),
      });

    // 1. Maintenant : rien à faire. Le brouillon est récent, l'audio envoyé
    //    n'est même pas un candidat (`usage_count = 1`).
    const today = await sweep(stack.context.clock.nowMs());
    expect(today.examined).toBe(0);
    expect(today.purged).toHaveLength(0);

    // 2. Trente et un jours plus tard, la simulation décide **sans supprimer** :
    //    un effacement irréversible se relit avant d'être appliqué.
    const later = stack.context.clock.nowMs() + 31 * 86_400_000;
    const dry = await sweep(later, true);
    expect(dry.dryRun).toBe(true);
    expect(dry.purged.map((entry) => entry.assetId)).toEqual([draft.asset.id]);
    expect(await stack.storage.exists(draft.asset.storageKey)).toBe(true);
    expect(stack.store.asset(draft.asset.id)).not.toBeNull();

    // 3. Application : le fichier d'abord, la ligne ensuite.
    const applied = await sweep(later, false);
    expect(applied.purged).toHaveLength(1);
    expect(await stack.storage.exists(draft.asset.storageKey)).toBe(false);
    expect(stack.store.asset(draft.asset.id)).toBeNull();

    // 4. L'audio envoyé, lui, survit à tout : il prouve ce qui a été dit.
    expect(stack.store.asset(attached.asset.id)).not.toBeNull();
    expect(await stack.storage.exists(attached.asset.storageKey)).toBe(true);
  });
});
