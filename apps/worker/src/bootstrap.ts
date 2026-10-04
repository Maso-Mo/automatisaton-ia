import { hostname } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import {
  applyMigrations,
  createConversationStore,
  createEditorialStore,
  createMediaStore,
  createProjectMemoryStore,
  createPublishingStore,
  createSchedulingStore,
  createVideoRenderStore,
  missingTables,
  openDatabase,
  REQUIRED_TABLE_NAMES,
  type DatabaseHandle,
} from '@aia/database';
import {
  PUBLICATION_TASK,
  createBudgetPort,
  evaluateBudgetBrake,
  loadScopedBudgetLimits,
  type BudgetPort,
} from '@aia/analytics';
import {
  decryptToken,
  ensureLocalDirectories,
  llmModelFor,
  loadConfig,
  providerApiKey,
  type Config,
} from '@aia/config';
import { createLogger, type AppLogger } from '@aia/observability';
import {
  PUBLISH_CONTENT_JOB,
  createJobRegistry,
  generateContentSpec,
  SqliteQueue,
  type JobRegistry,
} from '@aia/queue';
import {
  LocalStorageAdapter,
  SpawnFfmpegRunner,
  WhisperCppTranscriber,
  type FFmpegRunner,
  type Transcriber,
} from '@aia/media';
import {
  NotFoundError,
  createSystemClock,
  createSystemRandom,
  usdToMicro,
  uuidv7,
  type Clock,
  type PlatformId,
} from '@aia/shared';
import {
  PLATFORM_WRITER_AGENT,
  PLATFORM_WRITER_TASK,
  PLATFORM_WRITER_TEMPERATURE,
  createLlmCallRecorder,
  createLlmProvider,
  loadActivePrompt,
  readGitCommit,
  syncPrompts,
  withRecording,
  type LlmCallRecorder,
} from '@aia/ai';
import {
  CALENDAR_LATE_TOLERANCE_MS,
  CONTENT_STATE_TRANSITIONS,
  type EditorialPorts,
  type ProjectMemoryPorts,
} from '@aia/core';
import {
  createAccountLocks,
  createApiConnector,
  resolveConnectorForAccount,
  resolveCredentials,
  type PlatformConnector,
} from '@aia/publishing';
import { createGenerateContentHandler } from './handlers/generate-content';
import {
  createPublishContentHandler,
  type PublicationContentSource,
} from './handlers/publish-content';
import { createRenderVideoHandler } from './handlers/render-video';
import { createTranscribeMediaHandler } from './handlers/transcribe-media';
import { createSemaphore } from './features/semaphore';
import { createNoopHandler, createScriptedProviderFactory } from './handlers/noop';
import type { WriterProviderFactory } from './features/platform-writer';
import { createWorkerLoop, type WorkerLoop } from './loop';

/**
 * Composition root du worker. C'est le seul endroit où les implémentations
 * d'infrastructure rencontrent le domaine : SQLite, la file, le fournisseur et
 * les promptes sont assemblés ici, jamais dans `packages/core` (docs/02 §5).
 */

/**
 * La fabrique du fournisseur de **rédaction** (étape 4, docs/05 §4.3).
 *
 * Elle est au worker ce que `apps/api/src/features/agents.ts` est à l'API : le
 * seul endroit qui choisit un fournisseur, un modèle et une température pour
 * `platform_writer`. Trois propriétés y sont portées, et aucune n'est laissée à
 * la discipline d'un appelant :
 *
 * 1. **un fournisseur enregistré** (`withRecording`) : chaque appel part dans
 *    `llm_calls`, y compris en erreur — un appel qui timeout a coûté ;
 * 2. **le veto de budget avant l'appel** : l'estimation est comparée au solde
 *    restant, et un refus n'écrit rien ni ne paie (docs/08 §8.1) ;
 * 3. **le coût est cumulé sur le job** (`ctx.recordCost`) : `jobs.cost_micro_usd`
 *    est la somme des appels du job, jamais une valeur recalculée après coup.
 *
 * Un bundle par appel, jamais un fournisseur partagé : `lastCallId()` désigne
 * alors l'appel de **ce** lot, celui dont la version de contenu dépend.
 */
function createWriterProviderFactory(options: {
  config: Config;
  clock: Clock;
  logger: AppLogger;
  recorder: LlmCallRecorder;
  budget: BudgetPort;
}): WriterProviderFactory {
  const providerId = options.config.env.LLM_DEFAULT_PROVIDER;
  const model = llmModelFor(options.config.env, 'standard');

  options.logger.info(
    { provider: providerId, model, temperature: PLATFORM_WRITER_TEMPERATURE },
    'rédacteur configuré : un appel par lot, journalisé et soumis au budget',
  );

  return (ctx, request) => {
    let lastCallId: string | null = null;

    const inner = createLlmProvider({
      providerId,
      apiKey: providerApiKey(options.config.env, providerId),
      model,
      clock: options.clock,
      localBaseUrl: `${options.config.env.OLLAMA_BASE_URL}/v1`,
    });

    const provider = withRecording(inner, {
      recorder: options.recorder,
      clock: options.clock,
      // Sans le job dans le contexte, un coût de rédaction ne serait rattaché à rien.
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
        const snapshot = options.budget.snapshot();
        return {
          remainingMicroUsd: snapshot.remainingMicroUsd,
          hardStop: snapshot.hardStop,
          periodLabel: snapshot.periodLabel,
        };
      },
    });

    return { provider, lastCallId: () => lastCallId };
  };
}
/**
 * **Le contenu suit la publication** (étape 8). Quand une publication est réglée,
 * l'état du contenu doit refléter l'issue — mais **seulement** quand la machine à
 * états l'autorise, et seulement quand **toutes** les cibles sont réglées.
 *
 * Deux règles y sont tenues, et ce sont les deux qui évitent les incohérences :
 *
 * 1. un contenu multi-plateformes ne passe à `published` que si aucune autre
 *    publication n'est encore en suspens (`countUnsettledByItem`) — sinon une
 *    cible publiée et une cible en échec donneraient un état qui ment ;
 * 2. la transition passe par `publishing` si le contenu n'y est pas encore : le
 *    domaine n'autorise pas `approved → published` directement, et forcer la
 *    table ici serait nier la machine à états de `packages/core`.
 */
function applyPublicationOutcome(input: {
  publications: ReturnType<typeof createPublishingStore>;
  editorial: EditorialPorts;
  publicationId: string;
  outcome: string;
  nowMs: number;
}): void {
  const publication = input.publications.getPublication(input.publicationId);
  if (!publication) return;
  const item = input.editorial.store.getContentItem(publication.contentItemId);
  if (!item) return;

  const target =
    input.outcome === 'published'
      ? ('published' as const)
      : input.outcome === 'ambiguous'
        ? ('publish_ambiguous' as const)
        : input.outcome === 'failed'
          ? ('publish_failed' as const)
          : null;
  if (!target) return;
  if (target === 'published' && input.publications.countUnsettledByItem(item.id) > 0) return;

  if (!CONTENT_STATE_TRANSITIONS[item.state].includes(target)) {
    if (!CONTENT_STATE_TRANSITIONS[item.state].includes('publishing')) return;
    input.editorial.store.updateContentItem(item.id, { state: 'publishing' });
  }
  input.editorial.store.updateContentItem(item.id, {
    state: target,
    ...(target === 'published' ? { publishedAt: input.nowMs } : {}),
  });
}

export interface WorkerContext {
  config: Config;
  handle: DatabaseHandle;
  logger: AppLogger;
  clock: Clock;
  budget: BudgetPort;
  registry: JobRegistry;
  queue: SqliteQueue;
  loop: WorkerLoop;
  workerId: string;
  shutdown: () => Promise<void>;
}

export function buildWorker(
  overrides: {
    config?: Config;
    logger?: AppLogger;
    transcriber?: Transcriber;
    /** Lanceur FFmpeg injectable : les tests n'encodent pas de vraie vidéo. */
    ffmpeg?: FFmpegRunner;
  } = {},
): WorkerContext {
  const config = overrides.config ?? loadConfig();
  ensureLocalDirectories(config);

  const logger =
    overrides.logger ??
    createLogger({
      level: config.env.LOG_LEVEL,
      pretty: config.env.LOG_PRETTY && config.env.APP_ENV !== 'production',
      name: 'worker',
    });

  const clock = createSystemClock();
  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });

  const migration = applyMigrations(handle);
  logger.info(
    { applied: migration.applied, total: migration.total },
    'migrations de base vérifiées',
  );

  const missing = missingTables(handle, REQUIRED_TABLE_NAMES);
  if (missing.length > 0) {
    handle.close();
    throw new Error(
      `Schéma incomplet : ${missing.length} table(s) manquante(s) sur ${REQUIRED_TABLE_NAMES.length} (${missing.join(', ')}). Lancer « pnpm db:migrate ».`,
    );
  }

  const promptSync = syncPrompts({
    handle,
    promptsDir: config.paths.promptsDir,
    clock,
    logger,
    gitCommit: readGitCommit(),
  });
  if (promptSync.active === 0) {
    handle.close();
    throw new Error(
      `Aucun prompt actif trouvé dans ${config.paths.promptsDir} : vérifier l’en-tête agent/task des fichiers.`,
    );
  }

  const budget = createBudgetPort({
    handle,
    clock,
    limits: {
      dailyUsd: config.env.DAILY_BUDGET_USD,
      monthlyUsd: config.env.MONTHLY_BUDGET_USD,
      dailyTokenLimit: config.env.DAILY_TOKEN_LIMIT,
    },
  });

  const recorder = createLlmCallRecorder(handle, clock);
  const registry = createJobRegistry();

  const costProbe = loadActivePrompt(handle, config.paths.promptsDir, 'system', 'cost_probe');
  if (!costProbe) {
    handle.close();
    throw new Error('Prompt actif introuvable : system/cost_probe (job noop de l’étape 1)');
  }

  registry.register(
    createNoopHandler({
      handle,
      clock,
      logger,
      recorder,
      budget,
      resolvePrompt: () => costProbe,
      createProvider: createScriptedProviderFactory({
        clock,
        recorder,
        budget,
        model: config.env.LLM_MODEL_LIGHT ?? 'deepseek-chat',
      }),
    }),
  );

  /**
   * Éditorial (étape 4) : les ports du domaine, puis le job de rédaction.
   *
   * Les ports sont les **mêmes** que ceux de l'API — le domaine éditorial est
   * partagé par les deux processus, et sa seule source de vérité est
   * `packages/core` : l'API enfile, le worker exécute, et les deux lisent les
   * mêmes tables. La fiche maître vient du domaine « conversation », qui en est
   * le propriétaire : la recopier créerait deux vérités.
   *
   * Le job est enregistré **avec** sa spécification (`generateContentSpec`,
   * importée de `@aia/queue`) : c'est la même que celle utilisée par l'API pour
   * enfiler. Un worker qui recopierait ses valeurs produirait un autre job que
   * celui que l'API a écrit — et le refus arriverait au mauvais endroit.
   */
  const memoryPorts: ProjectMemoryPorts = {
    store: createProjectMemoryStore(handle, { nowMs: () => clock.nowMs() }),
    clock,
    newId: () => uuidv7(clock.nowMs()),
  };

  const conversationStore = createConversationStore(handle, { nowMs: () => clock.nowMs() });

  const editorialPorts: EditorialPorts = {
    store: createEditorialStore(handle, { nowMs: () => clock.nowMs() }),
    memory: memoryPorts.store,
    briefs: conversationStore.briefs,
    clock,
    newId: () => uuidv7(clock.nowMs()),
  };

  registry.register({
    ...generateContentSpec,
    handler: createGenerateContentHandler({
      handle,
      memory: memoryPorts,
      ports: editorialPorts,
      logger,
      writer: {
        promptsDir: config.paths.promptsDir,
        model: llmModelFor(config.env, 'standard'),
        temperature: PLATFORM_WRITER_TEMPERATURE,
        createProvider: createWriterProviderFactory({ config, clock, logger, recorder, budget }),
      },
    }),
  });

  const media = createMediaStore(handle, () => clock.nowMs());
  const storage = new LocalStorageAdapter(config.paths.mediaRoot);
  const configuredModelPath = config.env.WHISPER_MODEL_PATH;
  const transcriber =
    overrides.transcriber ??
    new WhisperCppTranscriber({
      whisperBin: config.env.WHISPER_BIN,
      ffmpegBin: config.env.FFMPEG_BIN,
      modelPath: isAbsolute(configuredModelPath)
        ? configuredModelPath
        : resolve(config.paths.root, configuredModelPath),
    });

  registry.register(
    createTranscribeMediaHandler({
      media,
      storage,
      transcriber,
      clock,
      // Le plafond est validé **après** décodage : l'en-tête d'un fichier ne dit
      // pas la vérité sur sa durée, et un WebM tronqué peut annoncer 5 s pour
      // 40 min. Une valeur ici évite qu'un seul enregistrement bloque le worker.
      maxDurationMs: config.env.MEDIA_MAX_DURATION_S * 1_000,
    }),
  );

  /**
   * Rendu vidéo (étape 7) : FFmpeg est le seul binaire du pipeline, et il est
   * **injectable** — les tests exercent le handler réel sans encoder une seconde
   * de vidéo (docs/09 §1.1).
   *
   * Le sémaphore est unique et partagé : deux `render_video` réservés en parallèle
   * (la file en réserve jusqu'à `QUEUE_CONCURRENCY`) s'exécutent l'un **après**
   * l'autre. C'est le choix de confort de docs/05 §6.4 — garder la machine
   * réactive prime sur le fait de finir plus tôt.
   */
  const ffmpeg: FFmpegRunner =
    overrides.ffmpeg ??
    new SpawnFfmpegRunner({
      ffmpegBin: config.env.FFMPEG_BIN,
      ffprobeBin: config.env.FFPROBE_BIN,
      timeoutMs: config.env.VIDEO_RENDER_TIMEOUT_MS,
    });

  registry.register(
    createRenderVideoHandler({
      renders: createVideoRenderStore(handle, () => clock.nowMs()),
      media,
      storage,
      ffmpeg,
      clock,
      semaphore: createSemaphore(1),
      maxClipMs: config.env.VIDEO_MAX_CLIP_S * 1_000,
    }),
  );

  const workerId = `worker-${hostname()}-${uuidv7().slice(-8)}`;
  const queue = new SqliteQueue({
    db: handle,
    registry,
    clock,
    random: createSystemRandom(),
    logger,
    leaseMs: config.env.JOB_LEASE_MS,
    offline: config.env.OFFLINE_MODE,
  });

  /**
   * Publication par API (étape 8).
   *
   * Le handler `publish_content` est le **seul** job qui produit un effet de bord
   * public. Cette composition lui donne six choses, et rien d'autre :
   *
   * - les **publications** et leurs tentatives (`createPublishingStore`) ;
   * - la **version approuvée gelée** (`PublicationContentSource`) — jamais le
   *   contenu courant, qui pourrait avoir changé depuis l'approbation ;
   * - le **choix du connecteur AVANT l'appel** (`resolveConnectorForAccount`) :
   *   un compte dont les capacités ne permettent pas d'écrire retombe en niveau C
   *   (paquet manuel), jamais en erreur ;
   * - le **frein de budget opposable** (`evaluateBudgetBrake`), évalué avant tout
   *   envoi (docs/11 §2.7) ;
   * - la **reprogrammation** (`reschedule`) : une publication retenue ou reportée
   *   est remise en file, jamais détruite ;
   * - le **retour vers le contenu** (`onSettled`) : l'état du contenu suit l'issue.
   *
   * Les jetons LinkedIn sont déchiffrés **au dernier moment**, par compte, sous
   * verrou (`createAccountLocks`) : deux rafraîchissements concurrents avec un
   * jeton rotatif révoqueraient le compte (docs/06 §10.2).
   */
  const publications = createPublishingStore(handle, () => clock.nowMs());
  const scheduling = createSchedulingStore(handle, () => clock.nowMs());

  const contentSource: PublicationContentSource = {
    item: (id) => {
      const item = editorialPorts.store.getContentItem(id);
      if (!item) return null;
      return {
        id: item.id,
        projectId: item.projectId,
        platform: item.platform,
        target: item.target,
        state: item.state,
        approvedVersionId: item.approvedVersionId,
      };
    },
    version: (id) => {
      const version = editorialPorts.store.getVersion(id);
      if (!version) return null;
      return {
        id: version.id,
        body: version.body,
        title: version.title,
        hook: version.hook,
        hashtags: version.hashtags,
        mentions: version.mentions,
        mediaAssetIds: version.mediaAssetIds,
        approvedAt: version.approvedAt,
      };
    },
  };

  const envBudgetLimits = {
    dailyUsd: config.env.DAILY_BUDGET_USD,
    monthlyUsd: config.env.MONTHLY_BUDGET_USD,
    dailyTokenLimit: config.env.DAILY_TOKEN_LIMIT,
  };

  const accountLocks = createAccountLocks();
  const apiConnectors = new Map<PlatformId, PlatformConnector | null>();
  const apiConnectorFor = (platform: PlatformId): PlatformConnector | null => {
    const cached = apiConnectors.get(platform);
    if (cached !== undefined) return cached;
    const connector = createApiConnector(platform, {
      apiVersions: { linkedin: config.env.LINKEDIN_API_VERSION },
      credentialsFor: async (account) => {
        const record = publications.getAccount(account.platformAccountId);
        if (!record) {
          throw new NotFoundError(`Compte plateforme introuvable : ${account.platformAccountId}`, {
            code: 'PLATFORM_ACCOUNT_NOT_FOUND',
          });
        }
        return accountLocks.run(
          record.id,
          async () =>
            resolveCredentials({
              account: record,
              decrypt: (envelope, keyVersion) =>
                decryptToken(envelope, new Map([[keyVersion, config.encryptionKey]])),
              nowMs: clock.nowMs(),
            }).credentials,
        );
      },
      now: () => clock.nowMs(),
    });
    apiConnectors.set(platform, connector);
    return connector;
  };

  registry.register(
    createPublishContentHandler({
      publications,
      content: contentSource,
      resolveConnector: ({ platform, accountId }) => {
        const account = publications.getAccount(accountId);
        return resolveConnectorForAccount({
          platform,
          account: {
            platformAccountId: accountId,
            platform,
            remoteAccountId: account?.remoteAccountId ?? null,
            label: account?.accountLabel ?? '',
            scopes: account?.scopes ?? [],
          },
          capabilities: (account?.capabilities ?? null) as {
            level?: string;
            directPublish?: boolean;
            draft?: boolean;
          } | null,
          connectionState: account?.connectionState,
          apiConnector: apiConnectorFor(platform),
        });
      },
      budgetBrake: ({ projectId, estimatedMicroUsd }) =>
        evaluateBudgetBrake({
          handle,
          limits: loadScopedBudgetLimits(handle, envBudgetLimits),
          nowMs: clock.nowMs(),
          timeZone: budget.timeZone(),
          projectId,
          task: PUBLICATION_TASK,
          estimatedMicroUsd,
        }),
      reschedule: async ({ publicationId, delayMs }) => {
        const publication = publications.getPublication(publicationId);
        const scheduledFor = clock.nowMs() + delayMs;
        publications.settlePublication(publicationId, {
          status: 'planned',
          scheduledFor,
        });
        const jobId = await queue.enqueue(
          PUBLISH_CONTENT_JOB,
          { publicationId },
          {
            delayMs,
            dedupeKey: `publish:${publicationId}:retry:${scheduledFor}`,
            ...(publication
              ? { projectId: publication.projectId, contentItemId: publication.contentItemId }
              : {}),
          },
        );
        scheduling.rescheduleByPublication(
          publicationId,
          scheduledFor,
          'Publication reprogrammée par le pipeline.',
          jobId,
        );
      },
      onPublishing: (publicationId) => {
        scheduling.setStatusByPublication(publicationId, 'publishing');
      },
      onSettled: (publicationId, outcome) => {
        applyPublicationOutcome({
          publications,
          editorial: editorialPorts,
          publicationId,
          outcome,
          nowMs: clock.nowMs(),
        });
        scheduling.setStatusByPublication(
          publicationId,
          outcome === 'published'
            ? 'published'
            : outcome === 'manual_required'
              ? 'manual_required'
              : outcome === 'ambiguous'
                ? 'failed'
                : 'failed',
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
      estimatedCostMicroUsd: usdToMicro(config.env.PUBLISH_ESTIMATED_COST_USD),
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
    workerId,
    pollMs: config.env.WORKER_POLL_MS,
    heartbeatMs: config.env.JOB_HEARTBEAT_MS,
    batchSize: config.env.QUEUE_CONCURRENCY,
    offline: config.env.OFFLINE_MODE,
    promoteCalendar: (nowMs) => scheduling.promoteDue(nowMs, CALENDAR_LATE_TOLERANCE_MS),
  });

  const shutdown = async (): Promise<void> => {
    await loop.stop();
    handle.close();
  };

  return { config, handle, logger, clock, budget, registry, queue, loop, workerId, shutdown };
}
