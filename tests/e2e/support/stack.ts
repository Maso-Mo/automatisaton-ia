import {
  PLATFORM_WRITER_AGENT,
  PLATFORM_WRITER_TASK,
  PLATFORM_WRITER_TEMPERATURE,
  ScriptedLLMProvider,
  createLlmCallRecorder,
  findPrice,
  syncPrompts,
  withRecording,
} from '@aia/ai';
import { PerformanceAdvisor, createBudgetPort } from '@aia/analytics';
import {
  createConversationStore,
  createContentFeatureStore,
  createEditorialStore,
  createExternalContentStore,
  createLearningsStore,
  createMediaStore,
  createMetricsStore,
  createNewsStore,
  createPerformancePatternStore,
  createProjectMemoryStore,
  createPublishingStore,
  createSchedulingStore,
  missingTables,
  openDatabase,
  REQUIRED_TABLE_NAMES,
  type DatabaseHandle,
} from '@aia/database';
import { createFeedProvider } from '@aia/news';
import { LocalStorageAdapter, ScriptedFfmpegRunner, ScriptedTranscriber } from '@aia/media';
import {
  CALENDAR_LATE_TOLERANCE_MS,
  type EditorialPorts,
  type ProjectMemoryPorts,
} from '@aia/core';
import { createLogger, type AppLogger } from '@aia/observability';
import {
  PUBLISH_CONTENT_JOB,
  createJobRegistry,
  generateContentSpec,
  SqliteQueue,
} from '@aia/queue';
import { createSimulatedConnector } from '@aia/publishing';
import {
  createSystemClock,
  createSystemRandom,
  uuidv7,
  type Clock,
  type ContentDraftsOutput,
} from '@aia/shared';
import { buildServer } from '../../../apps/api/src/server';
import { buildApi } from '../../../apps/api/src/bootstrap';
import { createGenerateContentHandler } from '../../../apps/worker/src/handlers/generate-content';
import { createCollectNewsHandler } from '../../../apps/worker/src/handlers/collect-news';
import { createPublishContentHandler } from '../../../apps/worker/src/handlers/publish-content';
import { createRenderVideoHandler } from '../../../apps/worker/src/handlers/render-video';
import { createTranscribeMediaHandler } from '../../../apps/worker/src/handlers/transcribe-media';
import {
  createAnalyzePerformanceHandler,
  createCollectMetricsHandler,
  createExtractContentFeaturesHandler,
  createRebuildPatternsHandler,
} from '../../../apps/worker/src/handlers/analytics';
import { createSemaphore } from '../../../apps/worker/src/features/semaphore';
import { createWorkerLoop } from '../../../apps/worker/src/loop';
import type { WriterProviderFactory } from '../../../apps/worker/src/features/platform-writer';
import {
  defaultBriefOutput,
  defaultInterviewerOutput,
  scriptedInterviewer,
  scriptedStrategist,
} from '../../support/conversation';
import { defaultDrafts, defaultPlanOutput, scriptedAnglePlanner } from '../../support/editorial';
import { e2eConfig } from './environment';
import { REGENERATION_MARKER, VIDEO_TRANSCRIPT_SEGMENT, VOICE_TRANSCRIPT } from './script';

/**
 * La pile du parcours : **l'API et le worker**, sur une base neuve, avec le
 * **modèle scripté** (docs/09 §1.1).
 *
 * Tout le reste est le code de production : les routes, le domaine, la file, le
 * handler `generate_content`, la boucle du worker. Ce que le parcours prouve ne
 * dépend donc jamais de la qualité d'un modèle — seulement du câblage.
 *
 * Deux choix méritent d'être écrits ici :
 *
 * 1. **deux bases ouvertes, comme en production** : l'API crée sa propre file en
 *    **écriture seule** (`buildApi`), la boucle du worker en réserve une autre
 *    sur le **même fichier**. C'est exactement `pnpm dev:api` + `pnpm dev:worker` ;
 *    les réunir dans un seul processus n'est qu'une commodité de lancement (le
 *    worker n'expose pas de port HTTP que Playwright pourrait attendre) ;
 * 2. **deux brouillons scriptés, dans l'ordre** : le premier sert la génération
 *    initiale, le second la **régénération ciblée**. Un parcours qui ne
 *    vérifierait pas qu'une régénération produit une version *différente* ne
 *    prouverait pas grand-chose.
 */

const config = e2eConfig();
const logger: AppLogger = createLogger({
  level: config.env.LOG_LEVEL,
  pretty: false,
  name: 'e2e-stack',
});
const clock: Clock = createSystemClock();

/**
 * Le **moteur de transcription scripté** (étape 6).
 *
 * Un seul exemplaire, partagé par l'API — qui annonce la capacité sur
 * `/media/capabilities` — et par le worker, qui transcrit : c'est la topologie
 * de production (une installation whisper.cpp, deux processus qui la lisent),
 * sans binaire, sans modèle et sans réseau (docs/09 §1.1). Le texte servi vient
 * de `./script`, la même source que celle lue par la spécification navigateur.
 */
const transcriber = new ScriptedTranscriber({
  text: VOICE_TRANSCRIPT,
  durationMs: 4_200,
  /**
   * Trois segments, dont un **dans** la fenêtre que le parcours vidéo édite
   * (5 s → 25 s) : sans parole transcrite dans l'extrait, l'API refuse le rendu
   * (`VIDEO_NO_SUBTITLES_IN_WINDOW`) — et c'est exactement ce qu'une vidéo muette
   * ou mal découpée produirait. Le parcours doit donc éditer une fenêtre qui
   * contient de la parole, comme le ferait un utilisateur.
   */
  segments: [
    { startMs: 0, endMs: 4_200, text: VOICE_TRANSCRIPT },
    { startMs: 5_000, endMs: 18_000, text: VIDEO_TRANSCRIPT_SEGMENT },
    { startMs: 18_000, endMs: 40_000, text: 'Deuxième étape : générer puis envoyer la facture.' },
  ],
});

/**
 * Le **lanceur FFmpeg scripté** (étape 7), partagé par l'API — qui mesure une
 * source à l'import — et par le worker, qui encode : c'est une seule doublure,
 * comme une seule installation FFmpeg en production.
 *
 * Il écrit vraiment son fichier de sortie (donc le handler mesure, hache,
 * renomme et crée l'asset pour de bon) et émet une progression réelle. Ce que le
 * parcours prouve ainsi : tout le **câblage** du rendu (plan → job → progression
 * → fichier → aperçu), sans dépendre d'un encodage qui prendrait des minutes sur
 * une machine lente. Le rendu réel, lui, est vérifié par
 * `tests/integration/video-render-ffmpeg.test.ts`.
 */
const scriptedFfmpeg = new ScriptedFfmpegRunner({
  probe: (path) =>
    path.includes('/renders/')
      ? { width: 1080, height: 1920, durationMs: 20_000 }
      : { width: 1920, height: 1080, durationMs: 120_000 },
  outputBytes: new Uint8Array(96_000),
  progressStepsMs: [2_000, 4_000, 8_000, 12_000, 16_000, 20_000],
});

// --- L'API : l'entretien, la fiche maître et le plan sont scriptés ----------

const api = buildApi({
  config,
  logger,
  clock,
  agents: {
    interviewer: () => ({
      agent: scriptedInterviewer([defaultInterviewerOutput()]),
      prompt: { promptVersionId: 'e2e-interviewer', filePath: 'interviewer/converse.md' },
      lastCallId: () => null,
    }),
    strategist: () => ({
      agent: scriptedStrategist(defaultBriefOutput()),
      prompt: { promptVersionId: 'e2e-strategist', filePath: 'strategist/master-brief.md' },
      lastCallId: () => null,
    }),
  },
  editorialAgents: {
    anglePlanner: () => ({
      agent: scriptedAnglePlanner(defaultPlanOutput()),
      prompt: { promptVersionId: 'e2e-angles', filePath: 'strategist/angles.md' },
      lastCallId: () => null,
    }),
  },
  transcriber,
  ffmpeg: scriptedFfmpeg,
});

const server = buildServer(api);

// --- Le worker : sa file, ses ports, son handler -----------------------------

const handle: DatabaseHandle = openDatabase({
  file: config.paths.databaseFile,
  wal: config.env.DB_WAL,
  busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
});

const missing = missingTables(handle, REQUIRED_TABLE_NAMES);
if (missing.length > 0) {
  throw new Error(
    `Base E2E incomplète : ${missing.length} table(s) manquante(s) — l'API applique les migrations au démarrage`,
  );
}

syncPrompts({
  handle,
  promptsDir: config.paths.promptsDir,
  clock,
  logger,
  gitCommit: null,
});

const recorder = createLlmCallRecorder(handle, clock);
const budget = createBudgetPort({
  handle,
  clock,
  timeZone: 'UTC',
  limits: { dailyUsd: 1, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
});
const memoryStore = createProjectMemoryStore(handle, { nowMs: () => clock.nowMs() });
const memory: ProjectMemoryPorts = {
  store: memoryStore,
  clock,
  newId: () => uuidv7(clock.nowMs()),
};

const ports: EditorialPorts = {
  store: createEditorialStore(handle, { nowMs: () => clock.nowMs() }),
  memory: memoryStore,
  briefs: createConversationStore(handle, { nowMs: () => clock.nowMs() }).briefs,
  clock,
  newId: () => uuidv7(clock.nowMs()),
};

const model = 'deepseek-chat';
const initial = defaultDrafts();
/**
 * La **seconde** sortie du modèle : le même lot, réécrit — le marqueur partagé
 * en tête de chaque corps (`./script`).
 *
 * Toutes les cibles restent servies, volontairement : le fournisseur ne reçoit
 * que `{ projectId, promptVersionId }` (voir `WriterProviderRequest`), il ne
 * peut donc pas savoir quelle cible est demandée. Un second lot réduit au seul
 * Reddit faisait échouer toute génération suivante d'une autre cible
 * (`DRAFT_MISSING`) — un parcours ne doit pas dépendre de son ordre d'exécution.
 */
const regenerated: ContentDraftsOutput = {
  drafts: Object.fromEntries(
    Object.entries(initial.drafts).map(([target, draft]) => [
      target,
      { ...draft, body: `${REGENERATION_MARKER}\n\n${draft.body}` },
    ]),
  ),
};
const drafts = [initial, regenerated];
let writerCalls = 0;

const createProvider: WriterProviderFactory = (ctx, request) => {
  let lastCallId: string | null = null;
  // La séquence se répète à partir de la dernière entrée : une régénération de
  // plus reste décrite, sans script supplémentaire.
  const scripted = new ScriptedLLMProvider({
    model,
    price: findPrice('deepseek', model),
    clock,
    responses: [JSON.stringify(drafts[Math.min(writerCalls, drafts.length - 1)])],
  });
  writerCalls += 1;

  const provider = withRecording(scripted, {
    recorder,
    clock,
    baseContext: {
      agent: PLATFORM_WRITER_AGENT,
      task: PLATFORM_WRITER_TASK,
      projectId: request.projectId,
      jobId: ctx.jobId,
      promptVersionId: request.promptVersionId,
    },
    onLlmCallId: (id) => {
      lastCallId = id;
    },
    onCost: async (microUsd) => {
      await ctx.recordCost(microUsd);
    },
    budget: () => {
      const snapshot = budget.snapshot();
      return {
        remainingMicroUsd: snapshot.remainingMicroUsd,
        hardStop: snapshot.hardStop,
        periodLabel: snapshot.periodLabel,
      };
    },
  });

  return { provider, lastCallId: () => lastCallId };
};

const registry = createJobRegistry();
const analyticsPatterns = createPerformancePatternStore(handle, () => clock.nowMs());
const advisor = new PerformanceAdvisor();

/** Flux RSS local et déterministe : le parcours de veille ne touche jamais Internet. */
const news = createNewsStore(handle, () => clock.nowMs());
const rss = createFeedProvider({
  type: 'rss',
  nowMs: () => clock.nowMs(),
  fetch: async () =>
    new Response(
      `<?xml version="1.0" encoding="UTF-8" ?>
       <rss version="2.0"><channel><title>Veille E2E</title><item>
       <guid>react-e2e-20</guid>
       <title>React 20 améliore TypeScript pour les développeurs</title>
       <link>https://example.test/react-20?utm_source=e2e</link>
       <description>Une nouvelle API aide les équipes frontend et les outils IA.</description>
       <pubDate>${new Date(clock.nowMs()).toUTCString()}</pubDate>
       <category>react</category><category>typescript</category><category>dev</category>
       </item></channel></rss>`,
      { status: 200, headers: { 'content-type': 'application/rss+xml' } },
    ),
});
registry.register(
  createCollectNewsHandler({
    news,
    provider: (type) => (type === 'rss' ? rss : undefined),
    projectContext: (projectId) => {
      const project = memoryStore.projects.byId(projectId);
      if (!project) return null;
      return {
        name: project.name,
        terms: ['react', 'typescript', 'frontend', 'ia', 'outils'],
        audienceTerms: ['développeurs', 'équipes'],
      };
    },
    clock,
  }),
);
registry.register({
  ...generateContentSpec,
  handler: createGenerateContentHandler({
    handle,
    memory,
    ports,
    logger,
    writer: {
      promptsDir: config.paths.promptsDir,
      model,
      temperature: PLATFORM_WRITER_TEMPERATURE,
      createProvider,
    },
    performanceGuidance: (projectId, targets) =>
      advisor.guidance(
        advisor.advise({
          platform: targets[0]?.split('_')[0] ?? 'linkedin',
          contentType: targets[0],
          patterns: analyticsPatterns.listByProject(projectId).map((row) => ({
            id: row.id,
            platform: row.platform,
            niche: row.niche,
            contentType: row.content_type,
            feature: row.value,
            dimension: row.dimension,
            observedEffectPercent: row.delta_percent,
            confidenceX100: row.confidence_x100,
            sampleSize: row.sample_size,
            status: row.status as 'EXPERIMENTAL' | 'LIKELY' | 'SUPPORTED' | 'REJECTED',
          })),
        }),
      ),
  }),
});

/**
 * Le handler de transcription, branché sur le **même** moteur scripté que celui
 * annoncé par l'API : la transcription du parcours est donc produite par le
 * chemin réel (worker → stockage local → moteur), seul le moteur est remplacé.
 *
 * `maxDurationMs` est câblé comme en production, depuis la configuration : un
 * plafond de test désactivé ne prouverait rien.
 */
registry.register(
  createTranscribeMediaHandler({
    media: createMediaStore(handle, () => clock.nowMs()),
    storage: new LocalStorageAdapter(config.paths.mediaRoot),
    transcriber,
    clock,
    maxDurationMs: config.env.MEDIA_MAX_DURATION_S * 1_000,
  }),
);

/**
 * Le handler de **rendu vidéo** (étape 7), avec le même lanceur scripté que
 * l'API : le parcours traverse donc le vrai handler (plan relu, sous-titres
 * écrits, progression écrite, asset créé), seul l'encodeur est remplacé.
 *
 * Le registre des rendus est celui de l'API (`api.renders`) : en production, une
 * seule ligne `video_renders` existe, et c'est le même objet qui la lit ici.
 */
registry.register(
  createRenderVideoHandler({
    renders: api.renders,
    media: createMediaStore(handle, () => clock.nowMs()),
    storage: new LocalStorageAdapter(config.paths.mediaRoot),
    ffmpeg: scriptedFfmpeg,
    clock,
    semaphore: createSemaphore(1),
    maxClipMs: config.env.VIDEO_MAX_CLIP_S * 1_000,
  }),
);

const queue = new SqliteQueue({
  db: handle,
  registry,
  clock,
  random: createSystemRandom(),
  logger,
  leaseMs: config.env.JOB_LEASE_MS,
  offline: false,
});

/** Publication calendrier : vrai handler, connecteur scripté, aucun réseau. */
const publications = createPublishingStore(handle, () => clock.nowMs());
const scheduling = createSchedulingStore(handle, () => clock.nowMs());
const simulatedPublishing = createSimulatedConnector({ platform: 'linkedin', level: 'A' });
const analyticsMetrics = createMetricsStore(handle, () => clock.nowMs());
const analyticsFeatures = createContentFeatureStore(handle, () => clock.nowMs());
const analyticsExternal = createExternalContentStore(handle, () => clock.nowMs());
const analyticsMedia = createMediaStore(handle, () => clock.nowMs());
registry.register(
  createCollectMetricsHandler({
    metrics: analyticsMetrics,
    publications,
    connector: () => simulatedPublishing,
    clock,
  }),
);
registry.register(createAnalyzePerformanceHandler({ metrics: analyticsMetrics, publications }));
registry.register(
  createExtractContentFeaturesHandler({
    features: analyticsFeatures,
    external: analyticsExternal,
    source: {
      publication: (id) => {
        const publication = publications.getPublication(id);
        if (!publication) return null;
        const item = ports.store.getContentItem(publication.contentItemId);
        const version = ports.store.getVersion(publication.contentVersionId);
        if (!item || !version) return null;
        const asset = version.mediaAssetIds
          .map((assetId) => analyticsMedia.asset(assetId))
          .find(Boolean);
        const transcript = asset ? analyticsMedia.transcriptForAsset(asset.id) : null;
        return {
          projectId: publication.projectId,
          publicationId: publication.id,
          contentVersionId: version.id,
          platform: publication.platform,
          niche: memoryStore.projects.byId(publication.projectId)?.positioning ?? null,
          contentType: item.target,
          title: version.title,
          hook: version.hook,
          body: version.body,
          durationMs: asset?.durationMs ?? null,
          fps: asset?.fps ?? null,
          width: asset?.width ?? null,
          height: asset?.height ?? null,
          transcriptSegments: transcript?.segments ?? [],
        };
      },
    },
    clock,
  }),
);
registry.register(
  createRebuildPatternsHandler({
    metrics: analyticsMetrics,
    features: analyticsFeatures,
    external: analyticsExternal,
    patterns: analyticsPatterns,
    learnings: createLearningsStore(handle, () => clock.nowMs()),
    clock,
  }),
);
registry.register(
  createPublishContentHandler({
    publications,
    content: {
      item: (id) => {
        const item = ports.store.getContentItem(id);
        return item
          ? {
              id: item.id,
              projectId: item.projectId,
              platform: item.platform,
              target: item.target,
              state: item.state,
              approvedVersionId: item.approvedVersionId,
            }
          : null;
      },
      version: (id) => {
        const version = ports.store.getVersion(id);
        return version
          ? {
              id: version.id,
              body: version.body,
              title: version.title,
              hook: version.hook,
              hashtags: version.hashtags,
              mentions: version.mentions,
              mediaAssetIds: version.mediaAssetIds,
              approvedAt: version.approvedAt,
            }
          : null;
      },
    },
    resolveConnector: () => ({
      level: 'A',
      connector: simulatedPublishing,
      reason: 'Connecteur scripté E2E.',
    }),
    budgetBrake: () => ({ held: false, allowed: true, evaluated: 0 }),
    reschedule: async ({ publicationId, delayMs }) => {
      const scheduledFor = clock.nowMs() + delayMs;
      const jobId = await queue.enqueue(
        PUBLISH_CONTENT_JOB,
        { publicationId },
        { delayMs, dedupeKey: `publish:${publicationId}:retry:${scheduledFor}` },
      );
      scheduling.rescheduleByPublication(
        publicationId,
        scheduledFor,
        'Reprogrammée en E2E.',
        jobId,
      );
    },
    onPublishing: (publicationId) => {
      scheduling.setStatusByPublication(publicationId, 'publishing');
    },
    onSettled: (publicationId, outcome) => {
      scheduling.setStatusByPublication(
        publicationId,
        outcome === 'published' ? 'published' : 'failed',
      );
    },
    onAccountState: ({ accountId, state, error, rateLimitResetAt }) => {
      publications.setAccountState({
        accountId,
        state,
        error: error ?? null,
        rateLimitResetAt: rateLimitResetAt ?? null,
      });
    },
    estimatedCostMicroUsd: 0,
    clock,
    logger,
  }),
);

const loop = createWorkerLoop({
  handle,
  queue,
  registry,
  logger,
  clock,
  workerId: 'worker-e2e',
  pollMs: config.env.WORKER_POLL_MS,
  heartbeatMs: config.env.JOB_HEARTBEAT_MS,
  batchSize: 2,
  offline: false,
  promoteCalendar: (nowMs) => scheduling.promoteDue(nowMs, CALENDAR_LATE_TOLERANCE_MS),
});

loop.start();

await server.listen({ host: config.env.APP_HOST, port: config.env.APP_PORT });
logger.info(
  { database: config.paths.databaseFile, port: config.env.APP_PORT },
  'pile E2E prête : API + boucle de worker, modèle scripté',
);

/**
 * Arrêt propre (docs/08 §2.4) : on cesse de réserver, le job courant se termine,
 * la base se ferme. Playwright envoie le signal à la fin du parcours.
 */
let stopping = false;
const shutdown = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'arrêt de la pile E2E');
  await loop.stop();
  await server.close();
  handle.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
