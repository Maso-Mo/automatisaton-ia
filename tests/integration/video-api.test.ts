import { afterEach, describe, expect, it } from 'vitest';
import { createEditorialStore, createMediaStore } from '@aia/database';
import {
  LocalStorageAdapter,
  ScriptedFfmpegRunner,
  ScriptedTranscriber,
  VERTICAL_FORMAT,
} from '@aia/media';
import { createMediaPlannerAgent, ScriptedLLMProvider } from '@aia/ai';
import { createManualClock, CapabilityError, TransientError } from '@aia/shared';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createSemaphore } from '../../apps/worker/src/features/semaphore';
import { createRenderVideoHandler } from '../../apps/worker/src/handlers/render-video';
import { createTranscribeMediaHandler } from '../../apps/worker/src/handlers/transcribe-media';
import { createWorkerLoop, type WorkerLoop } from '../../apps/worker/src/loop';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * La chaîne vidéo complète (étape 7), avec la **vraie** API, la **vraie** file et
 * les **vrais** handlers du worker : import → transcription → plan proposé →
 * plan validé → job → rendu → progression → validation → aperçu.
 *
 * Ce qu'aucun test unitaire ne protège, et que ce fichier vérifie :
 *
 * - le contrat HTTP réel : statuts, codes d'erreur, refus explicites ;
 * - **rien n'est rendu avant un plan validé** : proposer un plan ne crée ni ligne
 *   `video_renders` ni job ;
 * - **le rendu est rattaché à la bonne version de contenu** : c'est le lien
 *   « quel texte a produit ce montage ? » (docs/03 §10.3) ;
 * - **une reprise ne recrée aucune donnée métier** : même rendu, même plan, même
 *   source, même version ; seul l'encodage est relancé ;
 * - **un échec est explicable**, et un rendu terminé refuse d'être relancé.
 *
 * Le décodeur et FFmpeg sont scriptés (`ScriptedTranscriber`,
 * `ScriptedFfmpegRunner`) : aucun test n'appelle whisper.cpp, ni n'encode une
 * seconde de vidéo (docs/09 §1.1). Le rendu **réel** est vérifié par
 * `video-render-ffmpeg.test.ts`, qui s'ignore si FFmpeg n'est pas installé.
 */

/** Un MP4 minimal : le serveur reconnaît le contenu, jamais le nom du fichier. */
function mp4Fixture(bytes = 4_096): Buffer {
  const video = Buffer.alloc(bytes, 0x33);
  Buffer.from('\x00\x00\x00\x20ftypisom\x00\x00\x00\x00', 'binary').copy(video, 0);
  return video;
}

interface VideoBench {
  context: TestContext;
  app: ReturnType<typeof buildServer>;
  api: ReturnType<typeof buildApi>;
  loop: WorkerLoop;
  media: ReturnType<typeof createMediaStore>;
  storage: LocalStorageAdapter;
  ffmpeg: ScriptedFfmpegRunner;
  projectId: string;
  contentItemId: string;
  contentVersionId: string;
}

let created: VideoBench[] = [];

afterEach(() => {
  for (const bench of created) bench.context.cleanup();
  created = [];
});

/**
 * Un plan scripté : c'est ce que `media_planner` rend dans ce banc. Un vrai appel
 * de modèle n'a rien à faire dans un test d'intégration (coût, réseau, panne).
 */
function scriptedPlanner(plan: {
  startMs: number;
  endMs: number;
  reason?: string;
  malformed?: boolean;
}): {
  planner: NonNullable<NonNullable<Parameters<typeof buildApi>[0]>['videoPlanner']>;
  provider: ScriptedLLMProvider;
} {
  const provider = new ScriptedLLMProvider({
    model: 'video_plan',
    price: {
      provider: 'scripted',
      model: 'video_plan',
      inputPerMillionUsd: 1,
      cachedInputPerMillionUsd: 1,
      outputPerMillionUsd: 1,
      effectiveFrom: '2026-01-01',
      verified: true,
    },
    clock: createManualClock(0),
    text: plan.malformed
      ? // Un plan **inversé** : la fin précède le début. Le schéma le refuse, donc
        // l'agent est réputé avoir échoué — c'est le repli qui doit prendre le relais.
        JSON.stringify({
          startMs: plan.endMs,
          endMs: Math.max(0, plan.endMs - 5_000),
          subtitleMode: 'burned',
          crop: 'vertical_center',
          reason: 'Plan inversé, volontairement invalide pour le test.',
        })
      : JSON.stringify({
          startMs: plan.startMs,
          endMs: plan.endMs,
          subtitleMode: 'burned',
          crop: 'vertical_center',
          reason:
            plan.reason ?? 'Extrait qui contient la démonstration complète du montage automatisé.',
        }),
  });

  return {
    provider,
    planner: {
      agent: createMediaPlannerAgent({
        provider,
        prompt: { promptVersionId: 'test-video-plan', body: 'Consigne.', filePath: 'test.md' },
      }),
      prompt: { promptVersionId: 'test-video-plan', filePath: 'media_planner/video_plan.md' },
      lastCallId: () => null,
    },
  };
}

/**
 * Le contenu **approuvé** du montage. Il est semé directement dans les tables de
 * l'éditorial : la chaîne « plan → rédaction → relecture → approbation » est déjà
 * couverte par `editorial.test.ts`, et la rejouer ici ne testerait rien de plus
 * sur la vidéo — alors qu'elle coûterait un worker, des agents et 20 appels
 * scriptés par test.
 */
function seedApprovedContent(
  context: TestContext,
  projectId: string,
): { contentItemId: string; contentVersionId: string } {
  const store = createEditorialStore(context.handle, { nowMs: () => context.clock.nowMs() });
  const item = store.createContentItem({
    projectId,
    subjectId: null,
    angleId: null,
    platform: 'tiktok',
    target: 'tiktok_short',
    format: 'video_courte',
    contentHash: null,
  });
  const version = store.addVersion({
    contentItemId: item.id,
    versionNumber: store.nextVersionNumber(item.id),
    body: 'Voici comment j’automatise ma facturation, étape par étape, sans y passer la soirée.',
    title: 'Automatiser sa facturation',
    hook: 'Trois étapes, dix minutes.',
    hashtags: ['#automation'],
    mentions: [],
    charCount: 88,
    wordCount: 15,
    readingTimeSec: 20,
    generation: 'initial',
    promptVersionHash: null,
    llmCallId: null,
    modelUsed: null,
    temperatureX100: null,
  });
  store.approveVersion(version.id, null);
  store.updateContentItem(item.id, {
    state: 'approved',
    currentVersionId: version.id,
    approvedVersionId: version.id,
    approvedAt: context.clock.nowMs(),
  });
  return { contentItemId: item.id, contentVersionId: version.id };
}

/**
 * Le banc : API + file + boucle de worker sur une base neuve, avec un contenu
 * approuvé et un projet réels.
 *
 * La file est **la même** des deux côtés — comme en production, où l'API écrit et
 * le worker lit le même fichier. `ffmpeg` est scripté, mais il écrit vraiment son
 * fichier de sortie : le handler mesure, hache, renomme et crée l'asset de sortie
 * pour de bon.
 */
async function makeBench(
  options: {
    planner?: { startMs: number; endMs: number; reason?: string; malformed?: boolean };
    ffmpeg?: ScriptedFfmpegRunner;
    transcriberSegments?: ReadonlyArray<{ startMs: number; endMs: number; text: string }>;
    /** Valeurs d'environnement du banc : bornes du produit, notamment. */
    env?: Record<string, string | undefined>;
  } = {},
): Promise<VideoBench> {
  const context = createTestContext({ env: options.env });
  const media = createMediaStore(context.handle, () => context.clock.nowMs());
  const storage = new LocalStorageAdapter(context.config.paths.mediaRoot);
  const transcriber = new ScriptedTranscriber({
    segments: [
      ...(options.transcriberSegments ?? [
        { startMs: 0, endMs: 6_000, text: 'Voici comment j’automatise ma facturation.' },
        { startMs: 6_000, endMs: 18_000, text: 'Première étape : connecter le formulaire.' },
        { startMs: 18_000, endMs: 40_000, text: 'Deuxième étape : générer la facture.' },
      ]),
    ],
    durationMs: 120_000,
  });
  const ffmpeg =
    options.ffmpeg ??
    new ScriptedFfmpegRunner({
      // Le fichier **produit** est vertical (il vit sous `renders/`) ; la source
      // importée, elle, est horizontale — c'est ce que la route d’import mesure.
      probe: (path) =>
        path.includes('/renders/')
          ? { width: VERTICAL_FORMAT.width, height: VERTICAL_FORMAT.height, durationMs: 20_000 }
          : { width: 1920, height: 1080, durationMs: 120_000 },
      outputBytes: new Uint8Array(8_192),
      progressStepsMs: [5_000, 10_000, 15_000, 20_000],
    });

  // --- L'API d'abord : elle expose le store des rendus, que le handler relit ---
  const planner = options.planner ? scriptedPlanner(options.planner) : null;
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    mediaQueue: context.queue,
    videoQueue: context.queue,
    transcriber,
    ffmpeg,
    ...(planner ? { videoPlanner: planner.planner } : {}),
  });

  // --- Puis les handlers : le **même** registre porte les spécifications, donc
  //     l'API peut enfiler exactement ce que le worker sait exécuter -----------
  context.registry.register(
    createTranscribeMediaHandler({
      media,
      storage,
      transcriber,
      clock: context.clock,
      maxDurationMs: context.config.env.MEDIA_MAX_DURATION_S * 1_000,
    }),
  );
  context.registry.register(
    createRenderVideoHandler({
      renders: api.renders,
      media,
      storage,
      ffmpeg,
      clock: context.clock,
      semaphore: createSemaphore(1),
      maxClipMs: context.config.env.VIDEO_MAX_CLIP_S * 1_000,
    }),
  );

  const loop = createWorkerLoop({
    handle: context.handle,
    queue: context.queue,
    registry: context.registry,
    logger: context.logger,
    clock: context.clock,
    workerId: 'worker-video-test',
    pollMs: 10,
    heartbeatMs: 1_000,
    batchSize: 2,
    offline: false,
  });

  const app = buildServer(api);
  const project = await app.inject({
    method: 'POST',
    url: '/projects',
    payload: { name: 'Vidéo courte' },
  });
  expect(project.statusCode).toBe(201);
  const projectId = (project.json() as { project: { id: string } }).project.id;
  const { contentItemId, contentVersionId } = seedApprovedContent(context, projectId);

  const bench: VideoBench = {
    context,
    app,
    api,
    loop,
    media,
    storage,
    ffmpeg,
    projectId,
    contentItemId,
    contentVersionId,
  };
  created.push(bench);
  return bench;
}

interface UploadedVideoBody {
  video: { id: string; role: string; kind: string; storageKey: string; durationMs: number | null };
  deduplicated: boolean;
  warnings: string[];
}

/** Le code d'erreur d'un corps d'échec : la catégorie décide du statut. */
function errorCodeOf(response: { json(): unknown }): string {
  const body = response.json() as { error?: { code?: string } };
  return body.error?.code ?? '';
}

/** Importe une vidéo par la route réelle, avec le corps = le fichier. */
async function uploadVideo(
  bench: VideoBench,
  bytes: Buffer = mp4Fixture(),
  mime = 'video/mp4',
): Promise<{ statusCode: number; body: UploadedVideoBody }> {
  const response = await bench.app.inject({
    method: 'POST',
    url: `/projects/${bench.projectId}/videos`,
    payload: bytes,
    headers: { 'content-type': mime },
  });
  return { statusCode: response.statusCode, body: response.json() as UploadedVideoBody };
}

/**
 * Le chemin nominal complet : vidéo importée, transcrite (le vrai handler), puis
 * proposée. Ce que chaque test ajoute ensuite porte sur le plan, le rendu ou la
 * reprise — jamais sur la plomberie.
 */
async function uploadAndTranscribe(bench: VideoBench): Promise<string> {
  const uploaded = await uploadVideo(bench);
  expect(uploaded.statusCode).toBe(201);
  const assetId = uploaded.body.video.id;

  const transcribed = await bench.app.inject({
    method: 'POST',
    url: `/media/assets/${assetId}/transcribe`,
    payload: { language: 'fr' },
  });
  expect(transcribed.statusCode).toBe(202);
  expect(await bench.loop.runOnce()).toBe(1);
  expect(bench.media.transcriptForAsset(assetId)).not.toBeNull();
  return assetId;
}

describe('import d’une vidéo : le contenu décide (docs/05 §5.1)', () => {
  it('accepte un MP4 dont l’en-tête est reconnu, et le mesure', async () => {
    const bench = await makeBench();
    const uploaded = await uploadVideo(bench);

    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.body.video.kind).toBe('video');
    expect(uploaded.body.video.role).toBe('original');
    // La clé est fabriquée par le serveur : ni le nom du client, ni un chemin.
    expect(uploaded.body.video.storageKey).toMatch(/^\d{6}\/[0-9a-f]{2}\/.+\.mp4$/);
    expect(uploaded.body.deduplicated).toBe(false);
    // La source est horizontale : l’avertissement de recadrage est annoncé.
    expect(uploaded.body.warnings.some((warning) => warning.includes('horizontale'))).toBe(true);
  });

  it('déduplique par empreinte : deux fois le même fichier, un seul asset', async () => {
    const bench = await makeBench();
    const first = await uploadVideo(bench);
    const second = await uploadVideo(bench);

    expect(second.statusCode).toBe(200);
    expect(second.body.video.id).toBe(first.body.video.id);
    expect(second.body.deduplicated).toBe(true);
    expect(bench.media.listAssets(bench.projectId, { kind: 'video' })).toHaveLength(1);
  });

  it('refuse un contenu qui n’est pas une vidéo, même déclaré comme tel', async () => {
    const bench = await makeBench();
    // Un PNG renommé en .mp4 : le serveur lit l’en-tête, pas le nom.
    const png = Buffer.concat([
      Buffer.from('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR', 'binary'),
      Buffer.alloc(64, 0x11),
    ]);
    const refused = await uploadVideo(bench, png);
    expect(refused.statusCode).toBe(400);
    expect(errorCodeOf({ json: () => refused.body })).toBe('VIDEO_FORMAT_UNSUPPORTED');
    expect(bench.media.listAssets(bench.projectId, { kind: 'video' })).toHaveLength(0);
  });

  it('refuse un type déclaré qui contredit le contenu, et un corps vide', async () => {
    const bench = await makeBench();
    const mismatch = await uploadVideo(bench, mp4Fixture(), 'video/webm');
    expect(errorCodeOf({ json: () => mismatch.body })).toBe('VIDEO_MIME_MISMATCH');

    const empty = await bench.app.inject({
      method: 'POST',
      url: `/projects/${bench.projectId}/videos`,
      payload: Buffer.alloc(0),
      headers: { 'content-type': 'video/mp4' },
    });
    expect(empty.statusCode).toBe(400);
  });

  it('refuse un projet inconnu : aucun asset orphelin', async () => {
    const bench = await makeBench();
    const response = await bench.app.inject({
      method: 'POST',
      url: '/projects/0197c0de-0000-7000-8000-000000000000/videos',
      payload: mp4Fixture(),
      headers: { 'content-type': 'video/mp4' },
    });
    expect(response.statusCode).toBe(404);
    expect(errorCodeOf(response)).toBe('PROJECT_NOT_FOUND');
  });
});

interface PlanBody {
  plan: { startMs: number; endMs: number; source: string; reason: string };
  usedFallback: boolean;
  fallbackReason: string | null;
  warnings: string[];
  content: { contentItemId: string; contentVersionId: string; target: string };
  transcript: { available: boolean; segments: number };
  policy: { preset: string; width: number; height: number; maxClipMs: number };
  usage: { costMicroUsd: number } | null;
}

async function proposePlan(bench: VideoBench, sourceAssetId: string) {
  const response = await bench.app.inject({
    method: 'POST',
    url: `/content/${bench.contentItemId}/video/plan`,
    payload: { sourceAssetId },
  });
  return { statusCode: response.statusCode, body: response.json() as PlanBody };
}

describe('plan de montage : proposé, jamais exécuté (docs/05 §6.3)', () => {
  it('rend le plan de l’agent, sans créer ni ligne de rendu ni job', async () => {
    const bench = await makeBench({ planner: { startMs: 6_000, endMs: 26_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const jobsBefore = bench.api.jobs().length;

    const proposed = await proposePlan(bench, assetId);
    expect(proposed.statusCode).toBe(200);
    expect(proposed.body.plan).toMatchObject({ startMs: 6_000, endMs: 26_000, source: 'agent' });
    expect(proposed.body.usedFallback).toBe(false);
    expect(proposed.body.fallbackReason).toBeNull();
    // Le rattachement annoncé est celui de la version **approuvée**.
    expect(proposed.body.content.contentVersionId).toBe(bench.contentVersionId);
    expect(proposed.body.content.target).toBe('tiktok_short');
    expect(proposed.body.transcript).toMatchObject({ available: true, segments: 3 });
    expect(proposed.body.policy).toMatchObject({
      preset: 'vertical_9_16',
      width: 1080,
      height: 1920,
    });

    // Rien n'a été créé : c'est tout l'enjeu de la séparation proposer/exécuter.
    expect(bench.api.renders.count()).toBe(0);
    expect(bench.api.jobs()).toHaveLength(jobsBefore);
  });

  it('avertit du recadrage sans bloquer : la vidéo est horizontale', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const proposed = await proposePlan(bench, assetId);
    expect(proposed.body.warnings.some((warning) => warning.includes('Recadrage important'))).toBe(
      true,
    );
  });

  it('remplace un plan d’agent invalide par le calcul en code, et dit pourquoi', async () => {
    const bench = await makeBench({
      planner: { startMs: 30_000, endMs: 10_000, malformed: true },
    });
    const assetId = await uploadAndTranscribe(bench);
    const proposed = await proposePlan(bench, assetId);

    expect(proposed.statusCode).toBe(200);
    expect(proposed.body.usedFallback).toBe(true);
    expect(proposed.body.plan.source).toBe('fallback');
    expect(proposed.body.fallbackReason).toMatch(/fin|invers|postérieur/i);
    // Le repli est honnête : premier passage transcrit, soixante secondes au plus.
    expect(proposed.body.plan.startMs).toBe(0);
    expect(proposed.body.plan.endMs).toBe(60_000);
    expect(bench.api.renders.count()).toBe(0);
  });

  it('sans agent utilisable, propose quand même un plan : le repli est un chemin normal', async () => {
    // Aucun `videoPlanner` injecté et aucune clé de fournisseur dans le banc : la
    // construction de l’agent échoue. Ce n’est pas une panne — c’est un cas que la
    // route doit absorber, parce que l’utilisateur, lui, doit pouvoir travailler.
    const bench = await makeBench();
    const assetId = await uploadAndTranscribe(bench);
    const proposed = await proposePlan(bench, assetId);
    expect(proposed.statusCode).toBe(200);
    expect(proposed.body.usedFallback).toBe(true);
    expect(proposed.body.fallbackReason).toContain('agent de montage indisponible');
    expect(proposed.body.plan.source).toBe('fallback');
  });

  it('refuse un contenu non approuvé et une vidéo d’un autre projet', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);

    // 1. Un contenu qui n’est pas approuvé : le montage doit correspondre au
    //    texte validé, donc la route refuse **avant** d’appeler un modèle.
    const store = createEditorialStore(bench.context.handle, {
      nowMs: () => bench.context.clock.nowMs(),
    });
    const draft = store.createContentItem({
      projectId: bench.projectId,
      subjectId: null,
      angleId: null,
      platform: 'tiktok',
      target: 'tiktok_short',
      format: 'video_courte',
      contentHash: null,
    });
    const draftPlan = await bench.app.inject({
      method: 'POST',
      url: `/content/${draft.id}/video/plan`,
      payload: { sourceAssetId: assetId },
    });
    expect(draftPlan.statusCode).toBe(400);
    expect(errorCodeOf(draftPlan)).toBe('CONTENT_NOT_APPROVED');

    // 2. Une vidéo d’un autre projet : introuvable **dans ce projet**.
    const other = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const otherAsset = await uploadAndTranscribe(other);
    const foreign = await proposePlan(bench, otherAsset);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body as unknown as { error: { code: string } }).toMatchObject({
      error: { code: 'VIDEO_SOURCE_NOT_FOUND' },
    });
  });
});

interface RenderBody {
  render: {
    id: string;
    status: string;
    contentItemId: string | null;
    contentVersionId: string;
    sourceAssetIds: string[];
    outputAssetId: string | null;
    preset: string;
    plan: { startMs: number; endMs: number; source: string } | null;
    ffmpegArgs: string[];
    ffmpegVersion: string | null;
    progress: number;
    durationMs: number | null;
    outputSizeBytes: number | null;
    jobId: string | null;
    validatedAt: number | null;
    error: unknown;
  };
  jobId: string;
}

/** Réponse brute : un test doit pouvoir lire aussi bien un succès qu'un refus. */
interface RawResponse {
  statusCode: number;
  json(): unknown;
}

async function createRender(
  bench: VideoBench,
  sourceAssetId: string,
  plan: { startMs: number; endMs: number },
  planSource?: 'agent' | 'fallback' | 'manual',
): Promise<RawResponse> {
  const response = await bench.app.inject({
    method: 'POST',
    url: `/content/${bench.contentItemId}/video/renders`,
    payload: {
      sourceAssetId,
      ...(planSource ? { planSource } : {}),
      plan: {
        ...plan,
        subtitleMode: 'burned',
        crop: 'vertical_center',
        reason: 'Extrait choisi pour la démonstration, sans invention de contenu.',
      },
    },
  });
  return { statusCode: response.statusCode, json: () => response.json() };
}

/** Le chemin complet : import → transcription → plan → rendu → worker. */
async function renderFully(
  bench: VideoBench,
  plan: { startMs: number; endMs: number } = { startMs: 0, endMs: 20_000 },
): Promise<{ renderId: string; body: RenderBody }> {
  const assetId = await uploadAndTranscribe(bench);
  const created = await createRender(bench, assetId, plan);
  expect(created.statusCode).toBe(202);
  const body = created.json() as RenderBody;
  expect(await bench.loop.runOnce()).toBe(1);
  return { renderId: body.render.id, body };
}

describe('création du rendu : un plan validé devient un job (docs/05 §6.4)', () => {
  it('rattache la version de contenu **exacte** et met le rendu en file', async () => {
    const bench = await makeBench({ planner: { startMs: 6_000, endMs: 26_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const proposed = await proposePlan(bench, assetId);

    const created = await createRender(
      bench,
      assetId,
      { startMs: proposed.body.plan.startMs, endMs: proposed.body.plan.endMs },
      'agent',
    );
    const body = created.json() as RenderBody;

    expect(created.statusCode).toBe(202);
    expect(body.render.status).toBe('queued');
    // Le lien « quel texte a produit ce montage ? » : la version approuvée.
    expect(body.render.contentVersionId).toBe(bench.contentVersionId);
    expect(body.render.contentItemId).toBe(bench.contentItemId);
    expect(body.render.sourceAssetIds).toEqual([assetId]);
    expect(body.render.preset).toBe('vertical_9_16');
    expect(body.render.plan).toMatchObject({ startMs: 6_000, endMs: 26_000, source: 'agent' });
    expect(body.render.jobId).toBe(body.jobId);

    const job = bench.api.job(body.jobId);
    expect(job?.type).toBe('render_video');
    // Aucun argument n'est compilé à la création : la compilation appartient au
    // rendu, pas à la planification. C'est ce qui rend un échec explicable.
    expect(body.render.ffmpegArgs).toEqual([]);
  });

  it('refuse un plan invalide au schéma, sans rien créer', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const jobsBefore = bench.api.jobs().length;

    const response = await bench.app.inject({
      method: 'POST',
      url: `/content/${bench.contentItemId}/video/renders`,
      payload: {
        sourceAssetId: assetId,
        plan: {
          startMs: 20_000,
          endMs: 5_000,
          subtitleMode: 'burned',
          crop: 'vertical_center',
          reason: 'Extrait inversé, refusé par le schéma.',
        },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(errorCodeOf(response)).toBe('VIDEO_RENDER_INPUT_INVALID');
    expect(bench.api.renders.count()).toBe(0);
    expect(bench.api.jobs()).toHaveLength(jobsBefore);
  });

  it('refuse un sous-titre externe et un recadrage non implémenté', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    for (const plan of [
      { startMs: 0, endMs: 20_000, subtitleMode: 'srt', crop: 'vertical_center' },
      { startMs: 0, endMs: 20_000, subtitleMode: 'burned', crop: 'face_tracking' },
    ]) {
      const response = await bench.app.inject({
        method: 'POST',
        url: `/content/${bench.contentItemId}/video/renders`,
        payload: {
          sourceAssetId: assetId,
          plan: { ...plan, reason: 'Extrait valide en tout point sauf le format demandé.' },
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(bench.api.renders.count()).toBe(0);
  });
});

describe('refus qui protègent la qualité du rendu', () => {
  it('refuse un extrait au-delà de la source, trop long, ou sans parole', async () => {
    const bench = await makeBench({
      planner: { startMs: 0, endMs: 20_000 },
      env: { VIDEO_MAX_CLIP_S: '10' },
    });
    const assetId = await uploadAndTranscribe(bench);

    // Au-delà de la durée de la vidéo (120 s dans le banc, mesurée par ffprobe).
    const beyond = await createRender(bench, assetId, { startMs: 0, endMs: 130_000 });
    expect(errorCodeOf(beyond)).toBe('VIDEO_PLAN_BEYOND_SOURCE');

    // Plus long que la borne du produit (`VIDEO_MAX_CLIP_S = 10` dans ce banc).
    const tooLong = await createRender(bench, assetId, { startMs: 0, endMs: 20_000 });
    expect(errorCodeOf(tooLong)).toBe('VIDEO_PLAN_TOO_LONG');

    // Aucun segment transcrit après 40 s : les sous-titres n'auraient rien à
    // afficher, donc le rendu est refusé **avant** FFmpeg.
    const silent = await createRender(bench, assetId, { startMs: 44_000, endMs: 54_000 });
    expect(errorCodeOf(silent)).toBe('VIDEO_NO_SUBTITLES_IN_WINDOW');
    expect(bench.api.renders.count()).toBe(0);
  });

  it('refuse une vidéo jamais transcrite : sans sous-titres, pas de short', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const uploaded = await uploadVideo(bench);
    const response = await createRender(bench, uploaded.body.video.id, {
      startMs: 0,
      endMs: 20_000,
    });
    expect(response.statusCode).toBe(400);
    expect(errorCodeOf(response)).toBe('VIDEO_TRANSCRIPT_REQUIRED');
    expect(bench.api.renders.count()).toBe(0);
  });

  it('refuse une vidéo sans piste audio : pas de transcription, donc pas de sous-titres', async () => {
    const bench = await makeBench({
      planner: { startMs: 0, endMs: 20_000 },
      // Une source muette : la mesure est celle de ffprobe, jamais une croyance.
      ffmpeg: new ScriptedFfmpegRunner({
        probe: (path) =>
          path.includes('/renders/')
            ? { width: 1080, height: 1920, durationMs: 20_000 }
            : { width: 1080, height: 1920, durationMs: 120_000, hasAudio: false },
      }),
    });
    const uploaded = await uploadVideo(bench);
    expect(uploaded.body.warnings.some((warning) => warning.includes('piste audio'))).toBe(true);

    const transcribe = await bench.app.inject({
      method: 'POST',
      url: `/media/assets/${uploaded.body.video.id}/transcribe`,
      payload: {},
    });
    expect(transcribe.statusCode).toBe(400);
    expect(errorCodeOf(transcribe)).toBe('MEDIA_HAS_NO_AUDIO');
    expect(bench.api.jobs()).toHaveLength(0);
  });
});

describe('rendu exécuté par le worker : hors requête, tracé, reproductible', () => {
  it('encode dans un job, puis produit un asset vertical dérivé de la source', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const created = await createRender(bench, assetId, { startMs: 4_000, endMs: 24_000 }, 'manual');
    const renderId = (created.json() as RenderBody).render.id;

    // Avant le worker : le rendu est en file, et **rien** n'a été encodé.
    expect(bench.api.renders.getOrThrow(renderId).status).toBe('queued');
    expect(bench.ffmpeg.calls).toHaveLength(0);

    expect(await bench.loop.runOnce()).toBe(1);
    const done = bench.api.renders.getOrThrow(renderId);

    expect(done.status).toBe('completed');
    expect(done.progress).toBe(100);
    expect(done.durationMs).toBe(20_000);
    expect(done.outputSizeBytes).toBe(8_192);
    expect(done.ffmpegVersion).toContain('scripté');

    // Les arguments **exacts** sont conservés : c'est ce qui rend un rendu
    // rejouable à l'identique, et un échec explicable.
    const graph = done.ffmpegArgs[done.ffmpegArgs.indexOf('-filter_complex') + 1];
    expect(graph).toContain('crop=1080:1920');
    expect(graph).toContain('subtitles=subtitles.ass');
    expect(done.ffmpegArgs[done.ffmpegArgs.indexOf('-ss') + 1]).toBe('4.000');
    expect(done.ffmpegArgs[done.ffmpegArgs.indexOf('-t') + 1]).toBe('20.000');
    // Les sous-titres sont écrits **dans** le répertoire de travail : le filtre ne
    // reçoit qu'un nom relatif, donc rien à échapper.
    expect(bench.ffmpeg.calls[0]?.cwd).toContain('aia-render-');

    const output = bench.media.asset(done.outputAssetId!);
    expect(output).toMatchObject({ role: 'subtitled', parentAssetId: assetId, source: 'render' });
    expect(output?.width).toBe(1080);
    expect(output?.height).toBe(1920);
    expect(await bench.storage.exists(output!.storageKey)).toBe(true);
    // La source est intacte : un rendu est un **nouvel** asset, jamais un
    // remplacement (docs/05 §6.4).
    expect(bench.media.asset(assetId)?.role).toBe('original');
    expect(await bench.storage.exists(bench.media.asset(assetId)!.storageKey)).toBe(true);
  });

  it('diffuse une progression monotone, du chargement à la fin', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const created = await createRender(bench, assetId, { startMs: 0, endMs: 20_000 }, 'manual');
    const jobId = (created.json() as RenderBody).jobId;
    await bench.loop.runOnce();

    const events = bench.api.jobEvents(jobId);
    const steps = events.map((event) => event.step).filter((step): step is string => step !== null);
    for (const expected of ['load_source', 'build_subtitles', 'encode', 'finalize', 'done']) {
      expect(steps).toContain(expected);
    }

    const progresses = events
      .map((event) => event.progress)
      .filter((progress): progress is number => typeof progress === 'number');
    expect(progresses.length).toBeGreaterThan(3);
    // La barre ne recule jamais : FFmpeg écrit des horodatages qui repartent en
    // arrière avec les images B, le store refuse de les enregistrer.
    for (let index = 1; index < progresses.length; index += 1) {
      expect(progresses[index]!).toBeGreaterThanOrEqual(progresses[index - 1]!);
    }
    expect(progresses.at(-1)).toBe(100);
  });
});

describe('aperçu et validation : ce que l’utilisateur voit, et ce qu’il décide', () => {
  it('sert le fichier rendu avec `Range`, et refuse celui d’un rendu non terminé', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const created = await createRender(bench, assetId, { startMs: 0, endMs: 20_000 }, 'manual');
    const renderId = (created.json() as RenderBody).render.id;

    // Avant la fin du rendu : 409, jamais un fichier vide qui ferait croire à un
    // lecteur cassé.
    const tooEarly = await bench.app.inject({ method: 'GET', url: `/renders/${renderId}/file` });
    expect(tooEarly.statusCode).toBe(409);
    expect(errorCodeOf(tooEarly)).toBe('VIDEO_RENDER_NOT_COMPLETED');

    await bench.loop.runOnce();

    const full = await bench.app.inject({ method: 'GET', url: `/renders/${renderId}/file` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toContain('video/mp4');
    expect(full.headers['content-length']).toBe('8192');
    expect(full.headers['accept-ranges']).toBe('bytes');

    // Un lecteur qui se déplace dans la timeline demande une plage : sans elle,
    // l'aperçu d'un extrait de trois minutes serait inutilisable.
    const ranged = await bench.app.inject({
      method: 'GET',
      url: `/renders/${renderId}/file`,
      headers: { range: 'bytes=0-1023' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers['content-range']).toBe('bytes 0-1023/8192');
    expect(ranged.headers['content-length']).toBe('1024');

    // La source reste consultable : on monte ce qu'on a vu.
    const source = await bench.app.inject({
      method: 'GET',
      url: `/media/assets/${assetId}/file`,
    });
    expect(source.statusCode).toBe(200);
  });

  it('valide un rendu terminé, et seulement un rendu terminé', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const created = await createRender(bench, assetId, { startMs: 0, endMs: 20_000 }, 'manual');
    const renderId = (created.json() as RenderBody).render.id;

    const tooEarly = await bench.app.inject({
      method: 'POST',
      url: `/renders/${renderId}/validate`,
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(errorCodeOf(tooEarly)).toBe('VIDEO_RENDER_NOT_COMPLETED');

    await bench.loop.runOnce();
    const validated = await bench.app.inject({
      method: 'POST',
      url: `/renders/${renderId}/validate`,
    });
    expect(validated.statusCode).toBe(200);
    expect((validated.json() as RenderBody).render.validatedAt).not.toBeNull();
    // La validation est une trace, pas une action : aucun job de publication n'est
    // créé, et la publication vidéo reste manuelle (interdit de docs/10 §4.7).
    expect(bench.api.jobs().every((job) => job.type !== 'publish_content')).toBe(true);
  });

  it('liste les rendus par contenu et par projet, et refuse de relancer un rendu terminé', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const { renderId } = await renderFully(bench);

    const byContent = await bench.app.inject({
      method: 'GET',
      url: `/content/${bench.contentItemId}/renders`,
    });
    expect((byContent.json() as { renders: unknown[] }).renders).toHaveLength(1);

    const byProject = await bench.app.inject({
      method: 'GET',
      url: `/projects/${bench.projectId}/renders`,
    });
    expect((byProject.json() as { renders: unknown[] }).renders).toHaveLength(1);

    const detail = await bench.app.inject({ method: 'GET', url: `/renders/${renderId}` });
    expect((detail.json() as RenderBody).render.status).toBe('completed');

    // « Relancer » un rendu terminé laisserait croire que le montage a changé :
    // c'est le **plan** qu'il faut modifier, donc un nouveau rendu.
    const resume = await bench.app.inject({
      method: 'POST',
      url: `/renders/${renderId}/resume`,
    });
    expect(resume.statusCode).toBe(400);
    expect(errorCodeOf(resume)).toBe('VIDEO_RENDER_ALREADY_COMPLETED');
    expect(bench.api.renders.count()).toBe(1);
  });
});

/** Un lanceur scripté qui échoue aux bornes du rendu : c'est ce qui rend le test utile. */
function failingFfmpeg(failure: () => unknown, failures = 1): ScriptedFfmpegRunner {
  return new ScriptedFfmpegRunner({
    failures,
    failure,
    outputBytes: new Uint8Array(8_192),
    progressStepsMs: [5_000, 10_000, 15_000, 20_000],
    probe: (path) =>
      path.includes('/renders/')
        ? { width: VERTICAL_FORMAT.width, height: VERTICAL_FORMAT.height, durationMs: 20_000 }
        : { width: 1920, height: 1080, durationMs: 120_000 },
  });
}

describe('échec explicable et reprise sans perte (critère de sortie §4.7)', () => {
  it('un échec transitoire est repris par la file, avec le même rendu et le même plan', async () => {
    const bench = await makeBench({
      planner: { startMs: 0, endMs: 20_000 },
      ffmpeg: failingFfmpeg(
        () =>
          new TransientError('FFmpeg interrompu par l’arrêt du worker : il sera repris.', {
            code: 'FFMPEG_ABORTED',
          }),
        1,
      ),
    });
    const assetId = await uploadAndTranscribe(bench);
    const created = await createRender(bench, assetId, { startMs: 0, endMs: 20_000 }, 'manual');
    const { render: first, jobId } = created.json() as RenderBody;

    expect(await bench.loop.runOnce()).toBe(1);
    const failed = bench.api.renders.getOrThrow(first.id);
    // L'échec est **écrit** : l'écran peut dire pourquoi, au lieu de rester bloqué
    // sur « encodage ».
    expect(failed.status).toBe('failed');
    expect((failed.error as { code?: string }).code).toBe('FFMPEG_ABORTED');

    // La reprise appartient à la file : le job n'est pas mort, il est reprogrammé.
    const job = bench.api.job(jobId);
    expect(job?.status).toBe('queued');
    expect(job?.attempt).toBe(1);

    // Après le délai de reprise, **le même job** repart : même rendu, même plan.
    bench.context.clock.advance(600_000);
    expect(await bench.loop.runOnce()).toBe(1);
    const done = bench.api.renders.getOrThrow(first.id);
    expect(done.status).toBe('completed');
    expect(done.plan).toEqual(failed.plan);
    expect(done.contentVersionId).toBe(failed.contentVersionId);
    expect(bench.api.renders.count()).toBe(1);
    // Deux tentatives d'encodage, un seul fichier de sortie : un échec ne laisse
    // pas d'asset derrière lui.
    expect(bench.ffmpeg.calls).toHaveLength(2);
    expect(bench.media.listAssets(bench.projectId, { kind: 'video' })).toHaveLength(2);
  });

  it('« relancer » reprend le même rendu sans recréer de donnée métier', async () => {
    const bench = await makeBench({
      planner: { startMs: 0, endMs: 20_000 },
      // Une erreur de capacité : aucune reprise automatique, c'est un humain qui
      // décide. Exactement le cas où l'utilisateur appuie sur « relancer ».
      ffmpeg: failingFfmpeg(
        () =>
          new CapabilityError('Le rendu n’est pas au format attendu (720×1280).', {
            code: 'VIDEO_RENDER_FORMAT_MISMATCH',
          }),
        1,
      ),
    });
    const assetId = await uploadAndTranscribe(bench);
    const created = await createRender(bench, assetId, { startMs: 2_000, endMs: 22_000 }, 'manual');
    const { render: first, jobId } = created.json() as RenderBody;
    await bench.loop.runOnce();

    const failed = bench.api.renders.getOrThrow(first.id);
    expect(failed.status).toBe('failed');
    expect(bench.api.job(jobId)?.status).toBe('failed');

    const resumed = await bench.app.inject({
      method: 'POST',
      url: `/renders/${first.id}/resume`,
    });
    expect(resumed.statusCode).toBe(202);
    const requeued = bench.api.renders.getOrThrow(first.id);

    // Rien de métier n'est recréé : le plan, la source, la version et la date de
    // demande sont ceux de la première fois (§13).
    expect(requeued.id).toBe(first.id);
    expect(requeued.plan).toEqual(failed.plan);
    expect(requeued.sourceAssetIds).toEqual(failed.sourceAssetIds);
    expect(requeued.contentVersionId).toBe(bench.contentVersionId);
    expect(requeued.requestedAt).toBe(failed.requestedAt);
    expect(requeued.status).toBe('queued');
    expect(requeued.progress).toBe(0);
    expect((resumed.json() as RenderBody).jobId).not.toBe(jobId);
    expect(bench.api.renders.count()).toBe(1);

    // Et la version de contenu n'a pas été dupliquée : le montage reste rattaché
    // au texte validé, pas à une copie.
    const store = createEditorialStore(bench.context.handle, {
      nowMs: () => bench.context.clock.nowMs(),
    });
    expect(store.listVersions(bench.contentItemId)).toHaveLength(1);

    expect(await bench.loop.runOnce()).toBe(1);
    const done = bench.api.renders.getOrThrow(first.id);
    expect(done.status).toBe('completed');
    expect(bench.media.listAssets(bench.projectId, { kind: 'video' })).toHaveLength(2);
  });

  it('un rendu interrompu (worker mort) est repris, et reste le même rendu', async () => {
    const bench = await makeBench({ planner: { startMs: 0, endMs: 20_000 } });
    const assetId = await uploadAndTranscribe(bench);
    const created = await createRender(bench, assetId, { startMs: 0, endMs: 20_000 }, 'manual');
    const renderId = (created.json() as RenderBody).render.id;

    // Ce qu'un arrêt brutal laisse derrière lui : une ligne en cours, aucun
    // fichier publié (le temporaire est supprimé par le `finally` du handler).
    bench.api.renders.markPreparing(renderId);
    bench.api.renders.markRendering(renderId);
    expect(bench.api.renders.interrupted().map((render) => render.id)).toContain(renderId);

    const resumed = await bench.app.inject({
      method: 'POST',
      url: `/renders/${renderId}/resume`,
    });
    expect(resumed.statusCode).toBe(202);
    expect(bench.api.renders.getOrThrow(renderId).status).toBe('queued');

    expect(await bench.loop.runOnce()).toBe(1);
    const done = bench.api.renders.getOrThrow(renderId);
    expect(done.status).toBe('completed');
    expect(done.progress).toBe(100);
    expect(bench.api.renders.count()).toBe(1);
    expect(bench.media.listAssets(bench.projectId, { kind: 'video' })).toHaveLength(2);
  });
});
