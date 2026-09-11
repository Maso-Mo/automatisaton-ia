import {
  createInterviewerAgent,
  createLlmProvider,
  createStrategistAgent,
  loadActivePrompt,
  withRecording,
  type Agent,
  type InterviewerInput,
  type PromptSource,
  type StrategistInput,
} from '@aia/ai';
import type { BudgetPort } from '@aia/analytics';
import type { Config } from '@aia/config';
import type { DatabaseHandle } from '@aia/database';
import type { ConversationAgentBundle } from './conversation';
import type { AppLogger } from '@aia/observability';
import {
  ValidationError,
  type Clock,
  type InterviewerOutput,
  type LlmProviderId,
  type MasterBriefOutput,
} from '@aia/shared';
import type { LlmCallRecorder } from '@aia/ai';

/**
 * Câblage des agents de l'étape 3 : le seul endroit où le produit choisit un
 * fournisseur, un modèle et un prompt.
 *
 * Trois décisions y sont prises explicitement :
 *
 * 1. **un fournisseur, pas un client HTTP** : `createLlmProvider` lit
 *    `LLM_DEFAULT_PROVIDER` et la clé correspondante. Remplacer DeepSeek par un
 *    modèle local ne touche ni le domaine, ni les agents ;
 * 2. **un modèle par tâche** (docs/08 §9.1) : l'entretien est l'appel le plus
 *    fréquent, donc économique ; la fiche maître conditionne tout le reste, donc
 *    elle a droit au modèle standard ;
 * 3. **la journalisation est obligatoire** : `withRecording` enveloppe le
 *    fournisseur, applique le veto de budget **avant** l'appel et écrit chaque
 *    appel dans `llm_calls`, y compris en erreur (docs/08 §7.3).
 */

export interface ConversationAgentsDeps {
  config: Config;
  handle: DatabaseHandle;
  clock: Clock;
  logger: AppLogger;
  budget: BudgetPort;
  recorder: LlmCallRecorder;
}

export interface ConversationAgents {
  interviewer(): ConversationAgentBundle<InterviewerInput, InterviewerOutput>;
  strategist(): ConversationAgentBundle<StrategistInput, MasterBriefOutput>;
}

/** Clé du fournisseur par défaut : jamais lue ailleurs, jamais journalisée. */
function apiKeyForProvider(config: Config, providerId: LlmProviderId): string | null {
  switch (providerId) {
    case 'deepseek':
      return config.env.DEEPSEEK_API_KEY ?? null;
    case 'openrouter':
      return config.env.OPENROUTER_API_KEY ?? null;
    case 'openai':
      return config.env.OPENAI_API_KEY ?? null;
    case 'anthropic':
      return config.env.ANTHROPIC_API_KEY ?? null;
    case 'gemini':
      return config.env.GEMINI_API_KEY ?? null;
    case 'ollama':
      return null;
    default:
      return null;
  }
}

export function createConversationAgents(deps: ConversationAgentsDeps): ConversationAgents {
  const providerId = deps.config.env.LLM_DEFAULT_PROVIDER;

  const modelFor = (task: 'converse' | 'master_brief'): string | null =>
    task === 'master_brief'
      ? (deps.config.env.LLM_MODEL_STANDARD ?? deps.config.env.DEEPSEEK_MODEL)
      : (deps.config.env.LLM_MODEL_LIGHT ?? deps.config.env.DEEPSEEK_MODEL);

  /**
   * Un agent = un prompt actif + un fournisseur enregistré. Le bundle est
   * reconstruit à chaque tour : `lastCallId()` désigne donc **l'appel de ce
   * tour**, jamais celui d'avant — la traçabilité ne dépend pas d'un ordre
   * implicite.
   */
  function bind<TIn, TOut>(
    agent: string,
    task: string,
    build: (
      provider: ReturnType<typeof createLlmProvider>,
      prompt: PromptSource,
    ) => Agent<TIn, TOut>,
  ): ConversationAgentBundle<TIn, TOut> {
    const prompt = loadActivePrompt(deps.handle, deps.config.paths.promptsDir, agent, task);
    if (!prompt) {
      throw new ValidationError(
        `Prompt actif introuvable : ${agent}/${task}. Vérifier ${deps.config.paths.promptsDir} et relancer l’application (la synchronisation des prompts se fait au démarrage).`,
        { code: 'PROMPT_MISSING', details: { agent, task } },
      );
    }

    let lastCallId: string | null = null;
    const inner = createLlmProvider({
      providerId,
      apiKey: apiKeyForProvider(deps.config, providerId),
      model: modelFor(task as 'converse' | 'master_brief'),
      clock: deps.clock,
      localBaseUrl: `${deps.config.env.OLLAMA_BASE_URL}/v1`,
    });

    const provider = withRecording(inner, {
      recorder: deps.recorder,
      clock: deps.clock,
      baseContext: { agent, task },
      onLlmCallId: (id) => {
        lastCallId = id;
      },
      budget: () => {
        const snapshot = deps.budget.snapshot();
        return {
          remainingMicroUsd: snapshot.remainingMicroUsd,
          hardStop: snapshot.hardStop,
          periodLabel: snapshot.periodLabel,
        };
      },
    });

    const built = build(provider, prompt);
    return {
      agent: built,
      prompt: { promptVersionId: prompt.promptVersionId, filePath: prompt.filePath },
      lastCallId: () => lastCallId,
    };
  }

  return {
    interviewer: () =>
      bind<InterviewerInput, InterviewerOutput>('interviewer', 'converse', (provider, prompt) =>
        createInterviewerAgent({ provider, prompt }),
      ),
    strategist: () =>
      bind<StrategistInput, MasterBriefOutput>('strategist', 'master_brief', (provider, prompt) =>
        createStrategistAgent({ provider, prompt }),
      ),
  };
}
