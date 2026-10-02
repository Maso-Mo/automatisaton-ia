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
import { createBudgetPort } from '@aia/analytics';
import {
  createConversationStore,
  createEditorialStore,
  createMediaStore,
  createProjectMemoryStore,
  missingTables,
  openDatabase,
  REQUIRED_TABLE_NAMES,
  type DatabaseHandle,
} from '@aia/database';
import { LocalStorageAdapter, ScriptedFfmpegRunner, ScriptedTranscriber } from '@aia/media';
import type { EditorialPorts, ProjectMemoryPorts } from '@aia/core';
import { createLogger, type AppLogger } from '@aia/observability';
import { createJobRegistry, generateContentSpec, SqliteQueue } from '@aia/queue';
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
import { createRenderVideoHandler } from '../../../apps/worker/src/handlers/render-video';
import { createTranscribeMediaHandler } from '../../../apps/worker/src/handlers/transcribe-media';
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
