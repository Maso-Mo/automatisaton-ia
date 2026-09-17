import {
  PLATFORM_WRITER_AGENT,
  PLATFORM_WRITER_TASK,
  PLATFORM_WRITER_TEMPERATURE,
  ScriptedLLMProvider,
  createLlmCallRecorder,
  findPrice,
  syncPrompts,
  withRecording,
  type Agent,
  type AnglePlannerInput,
  type LLMUsage,
  type PromptSyncReport,
} from '@aia/ai';
import { createBudgetPort, type BudgetPort } from '@aia/analytics';
import {
  createConversationStore,
  createEditorialStore,
  createProjectMemoryStore,
} from '@aia/database';
import type { EditorialPorts, ProjectMemoryPorts } from '@aia/core';
import { createJobRegistry, generateContentSpec, SqliteQueue, type JobRegistry } from '@aia/queue';
import {
  uuidv7,
  createSeededRandom,
  type ContentDraftsOutput,
  type EditorialPlanOutput,
  type TargetDraft,
} from '@aia/shared';
import type { EditorialAgents } from '../../apps/api/src/features/agents';
import type { WriterProviderFactory } from '../../apps/worker/src/features/platform-writer';
import { createGenerateContentHandler } from '../../apps/worker/src/handlers/generate-content';
import { createWorkerLoop, type WorkerLoop } from '../../apps/worker/src/loop';
import { REPO_PROMPTS_DIR, type TestContext } from './harness';

/**
 * `tests/support/editorial` — la chaîne de **l'étape 4** (docs/05 §4), montée
 * avec du code de production : mêmes ports de domaine que l'API, même job que
 * `@aia/queue`, même handler que le worker.
 *
 * Un seul composant est scripté, et c'est le même que partout ailleurs : le
 * **modèle**. Deux sorties sont écrites à la main — le plan d'angles et les
 * brouillons — parce qu'elles sont le contrat que l'agent doit produire, et
 * qu'un test qui les inventerait ne vérifierait que lui-même.
 */

const USAGE: LLMUsage = {
  provider: 'scripted',
  model: 'scripted-model',
  inputTokens: 1_200,
  outputTokens: 600,
  cachedTokens: 0,
  costUsd: 0.0008,
  costMicroUsd: 800,
  latencyMs: 12,
};

/**
 * Le **plan d'angles** scripté : un `Agent` de test, comme `scriptedInterviewer`
 * (docs/04 §4.2). Chaque sujet et chaque angle citent un extrait **exact** d'un
 * fait confirmé — `checkGrounding` refuse le reste, et c'est justement ce qu'on
 * veut éprouver.
 */
export function scriptedAnglePlanner(
  output: EditorialPlanOutput,
): Agent<AnglePlannerInput, EditorialPlanOutput> {
  return {
    name: 'strategist',
    task: 'angles',
    promptFile: 'strategist/angles.md',
    estimateTokens: () => ({ input: 600, output: 900 }),
    run: () => Promise.resolve({ output, repaired: false, usage: USAGE }),
  };
}

/** L'extrait d'ancrage : un morceau littéral du fait « 12 factures automatisées ». */
export const EVIDENCE_QUOTE = '12 factures';

/** Un plan valide : 3 sujets, 2 angles chacun, tous ancrés sur le même fait. */
export function defaultPlanOutput(): EditorialPlanOutput {
  return {
    subjects: [
      {
        title: 'Automatiser sa facturation sans y passer ses soirées',
        thesis:
          'Automatiser la facturation libère des heures chaque mois, à condition de commencer petit.',
        pillar: 'Automatisation',
        evidence: [EVIDENCE_QUOTE],
        angles: [
          {
            hook: 'J’ai automatisé 12 factures en une soirée : voici le montage exact.',
            angle_type: 'retour_experience',
            structure: ['Le problème de départ', 'Le montage n8n', 'Ce que ça change'],
            estimated_length: 'court',
            difficulty: 'faible',
            platform_hint: 'linkedin',
            rationale:
              'Un chiffre précis et vérifiable rend le récit crédible sans promettre de résultat.',
            evidence: [EVIDENCE_QUOTE],
          },
          {
            hook: 'Automatiser la facturation quand on est seul : par où commencer.',
            angle_type: 'tutoriel',
            structure: ['Prérequis', 'Étape 1', 'Étape 2', 'Contrôle final'],
            estimated_length: 'moyen',
            difficulty: 'moyenne',
            platform_hint: null,
            rationale: 'Le tutoriel répond à la question la plus fréquente de la cible.',
            evidence: [EVIDENCE_QUOTE],
          },
        ],
      },
      {
        title: 'Ce que l’automatisation ne règle pas',
        thesis:
          'Automatiser la facturation ne dispense pas de relire : ce qui reste manuel, et pourquoi.',
        pillar: 'Automatisation',
        evidence: [EVIDENCE_QUOTE],
        angles: [
          {
            hook: 'Automatiser 12 factures n’a pas supprimé mon contrôle du vendredi.',
            angle_type: 'opinion',
            structure: ['Ce qui est automatisé', 'Ce qui ne l’est pas', 'La règle que je garde'],
            estimated_length: 'court',
            difficulty: 'faible',
            platform_hint: 'linkedin',
            rationale: 'Nuancer l’automatisation installe la crédibilité de l’auteur.',
            evidence: [EVIDENCE_QUOTE],
          },
          {
            hook: 'Automatisation contre robotisation : la nuance qui change tout.',
            angle_type: 'comparaison',
            structure: ['Deux définitions', 'Un exemple vécu', 'Ce que j’en garde'],
            estimated_length: 'moyen',
            difficulty: 'faible',
            platform_hint: null,
            rationale: 'Comparer deux notions proches clarifie une confusion fréquente.',
            evidence: [EVIDENCE_QUOTE],
          },
        ],
      },
      {
        title: 'Le montage n8n, étape par étape',
        thesis:
          'Le détail du montage qui a automatisé 12 factures, sans outil payant supplémentaire.',
        pillar: 'n8n',
        evidence: [EVIDENCE_QUOTE],
        angles: [
          {
            hook: '12 factures automatisées : le détail du montage n8n, sans jargon.',
            angle_type: 'tutoriel',
            structure: ['Déclencheur', 'Transformation', 'Envoi', 'Journal'],
            estimated_length: 'long',
            difficulty: 'moyenne',
            platform_hint: 'youtube',
            rationale: 'Le montage complet est le contenu le plus consulté de ce type de compte.',
            evidence: [EVIDENCE_QUOTE],
          },
          {
            hook: 'L’erreur qui m’a coûté deux heures sur ce montage n8n.',
            angle_type: 'erreur',
            structure: ['Le contexte', 'L’erreur', 'La correction'],
            estimated_length: 'court',
            difficulty: 'faible',
            platform_hint: 'tiktok',
            rationale: 'Raconter une erreur retient l’attention mieux qu’un succès.',
            evidence: [EVIDENCE_QUOTE],
          },
        ],
      },
    ],
  };
}

/** Un corps commun, assez long pour les limites les plus serrées (YouTube court). */
const BODY =
  'Le montage tient en trois nœuds : un déclencheur qui lit le dossier, un nœud de transformation ' +
  'qui remplit le modèle de facture, et un nœud d’envoi qui archive une copie. Rien n’est ' +
  'automatisé « en aveugle » : le vendredi, je relis les douze factures produites, et c’est ce ' +
  'contrôle qui rend le montage fiable. Ce qui compte, ce n’est pas l’outil mais l’ordre des ' +
  'étapes : d’abord le journal, ensuite l’envoi.';

/**
 * Les **brouillons scriptés** : un contenu par cible, calibré sur les limites
 * dures de `contentTargetSpec` (docs/06 §5) — titres là où ils sont
 * obligatoires, aucun mot-dièse sur Reddit (sa limite est zéro), et une note
 * opérationnelle là où la plateforme l’exige.
 */
export function defaultDrafts(): ContentDraftsOutput {
  const linkedinHook = 'J’ai automatisé 12 factures en une soirée, avec n8n.';
  const redditHook = 'Retour d’expérience : ce qui a marché, et ce qui a cassé.';
  const tiktokHook = 'J’ai automatisé 12 factures avec n8n — voilà comment.';
  const youtubeHook = 'Le montage complet de mon automatisation de facturation, sans jargon.';

  return {
    drafts: {
      linkedin_post: {
        hook: linkedinHook,
        body: `${linkedinHook}\n\n${BODY}`,
        hashtags: ['#automatisation', '#n8n', '#freelance'],
        mentions: [],
        notes: [],
      },
      reddit_post: {
        title: 'J’ai automatisé 12 factures avec n8n : ce que j’ai appris',
        hook: redditHook,
        body: `${redditHook}\n\n${BODY}`,
        hashtags: [],
        mentions: [],
        notes: [
          'Vérifier la règle d’auto-promotion du subreddit',
          'Subreddit choisi par l’utilisateur',
        ],
      },
      tiktok_short: {
        hook: tiktokHook,
        body: `${tiktokHook}\n\n${BODY}`,
        hashtags: ['#automatisation', '#n8n', '#productivite'],
        mentions: [],
        notes: [],
      },
      youtube_short: {
        title: 'Automatiser 12 factures avec n8n',
        hook: youtubeHook,
        body: `${youtubeHook}\n\n${BODY}`,
        hashtags: ['#n8n', '#automatisation'],
        mentions: [],
        notes: [],
      },
    },
  };
}

/** Un brouillon unique, pour une **régénération ciblée** (docs/05 §4.4). */
export function singleDraft(
  target: keyof ContentDraftsOutput['drafts'],
  overrides: Partial<TargetDraft> = {},
): ContentDraftsOutput {
  const base = defaultDrafts().drafts[target];
  if (!base) throw new Error(`cible inconnue du script : ${target}`);
  return { drafts: { [target]: { ...base, ...overrides } } };
}

export interface EditorialStackOptions {
  /** Sorties scriptées, dans l’ordre des appels : le lot, puis la régénération. */
  drafts?: readonly ContentDraftsOutput[];
  plan?: EditorialPlanOutput;
  promptsDir?: string;
  workerId?: string;
  model?: string;
  seed?: number;
}

export interface EditorialStack {
  queue: SqliteQueue;
  loop: WorkerLoop;
  registry: JobRegistry;
  ports: EditorialPorts;
  memory: ProjectMemoryPorts;
  budget: BudgetPort;
  agents: EditorialAgents;
  syncReport: PromptSyncReport;
  /** Nombre d’appels au modèle réellement demandés par la rédaction. */
  writerCallCount(): number;
}

/**
 * Monte la chaîne éditoriale **complète** sur une base de test : les ports du
 * domaine, l'agent de plan, la file et la boucle du worker, avec le handler
 * `generate_content` enregistré et la **même** spécification que l'API.
 *
 * C'est ce que fait `apps/worker/src/bootstrap.ts` ; le seul écart est le
 * fournisseur, scripté ici (docs/09 §1.1 : aucun test ne sort du réseau).
 */
export function createEditorialStack(
  context: TestContext,
  options: EditorialStackOptions = {},
): EditorialStack {
  const { handle, clock, logger } = context;
  const promptsDir = options.promptsDir ?? REPO_PROMPTS_DIR;
  const model = options.model ?? 'deepseek-chat';

  const syncReport = syncPrompts({ handle, promptsDir, clock, logger, gitCommit: null });
  const recorder = createLlmCallRecorder(handle, clock);
  const budget = createBudgetPort({
    handle,
    clock,
    timeZone: 'UTC',
    limits: { dailyUsd: 1, monthlyUsd: 5, dailyTokenLimit: 2_000_000 },
  });

  const store = createProjectMemoryStore(handle, { nowMs: () => clock.nowMs() });
  const memory: ProjectMemoryPorts = { store, clock, newId: () => uuidv7(clock.nowMs()) };
  const ports: EditorialPorts = {
    store: createEditorialStore(handle, { nowMs: () => clock.nowMs() }),
    memory: store,
    briefs: createConversationStore(handle, { nowMs: () => clock.nowMs() }).briefs,
    clock,
    newId: () => uuidv7(clock.nowMs()),
  };

  const drafts = options.drafts ?? [defaultDrafts()];
  let calls = 0;

  const createProvider: WriterProviderFactory = (ctx, request) => {
    let lastCallId: string | null = null;
    // La séquence se répète à partir de la dernière entrée : un test qui ne
    // scripte qu'un lot décrit quand même la régénération.
    const scripted = new ScriptedLLMProvider({
      model,
      price: findPrice('deepseek', model),
      clock,
      responses: [JSON.stringify(drafts[Math.min(calls, drafts.length - 1)])],
    });
    calls += 1;

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
        promptsDir,
        model,
        temperature: PLATFORM_WRITER_TEMPERATURE,
        createProvider,
      },
    }),
  });

  const queue = new SqliteQueue({
    db: handle,
    registry,
    clock,
    random: createSeededRandom(options.seed ?? 11),
    logger,
    leaseMs: 60_000,
  });

  const loop = createWorkerLoop({
    handle,
    queue,
    registry,
    logger,
    clock,
    workerId: options.workerId ?? 'worker-editorial-test',
    pollMs: 60_000,
    heartbeatMs: 10_000,
    batchSize: 4,
    offline: false,
  });

  return {
    queue,
    loop,
    registry,
    ports,
    memory,
    budget,
    agents: {
      anglePlanner: () => ({
        agent: scriptedAnglePlanner(options.plan ?? defaultPlanOutput()),
        prompt: { promptVersionId: 'prompt-angles', filePath: 'strategist/angles.md' },
        lastCallId: () => null,
      }),
    },
    syncReport,
    writerCallCount: () => calls,
  };
}
