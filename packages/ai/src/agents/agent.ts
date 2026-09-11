import { ValidationError } from '@aia/shared';
import type { ZodType } from 'zod';
import { estimatePromptTokens } from '../pricing';
import type { GenerateOptions, LLMCallContext, LLMProvider, LLMUsage } from '../provider';

/**
 * Contrat d'agent (docs/04 §3.3) : la forme est **la même pour tous**, et deux
 * de ses clauses sont des invariants, pas des politesses :
 *
 * 1. `outputSchema` — « le modèle ne renvoie jamais du texte libre » : toute
 *    sortie que du code consomme est validée par un schéma Zod ;
 * 2. `estimateTokens` — calculé **sans réseau**, pour pouvoir refuser une
 *    génération *avant* qu'elle ne coûte quoi que ce soit.
 *
 * Aucun agent n'a d'état : tout leur état est en base. Un agent n'est donc jamais
 * un objet qu'on garde en mémoire entre deux tours.
 */

export interface AgentRunContext {
  /** Trace : remonte dans `llm_calls` (agent, task, projet, job, prompt). */
  callContext: LLMCallContext;
  /** Annulation coopérative : l'utilisateur ferme l'onglet. */
  signal?: AbortSignal;
  options?: GenerateOptions;
}

export interface Agent<TIn, TOut> {
  readonly name: string;
  readonly task: string;
  /** Un prompt = un fichier versionné du dépôt (docs/04 §6.1). */
  readonly promptFile: string;
  estimateTokens(input: TIn): { input: number; output: number };
  run(input: TIn, ctx: AgentRunContext): Promise<AgentResult<TOut>>;
}

export interface AgentResult<TOut> {
  output: TOut;
  usage: LLMUsage;
  /** `true` : la sortie a nécessité une réparation. Un taux élevé = prompt à revoir. */
  repaired: boolean;
}

export interface PromptSource {
  promptVersionId: string;
  body: string;
  filePath: string;
}

export interface StructuredAgentOptions<TIn, TOut> {
  name: string;
  task: string;
  provider: LLMProvider;
  prompt: PromptSource;
  schema: ZodType<TOut>;
  /** Rend le prompt final : instructions + contexte injecté (jamais dans le fichier). */
  buildPrompt(input: TIn): string;
  maxOutputTokens: number;
  /**
   * Plafond d'entrée. Le dépassement est une **erreur**, pas un avertissement :
   * un contexte qui gonfle est le risque n° 1 de cette étape (docs/10 §4.2).
   */
  maxInputTokens: number;
  temperature?: number;
  /** Estimation de sortie, annoncée avant l'appel pour le veto de budget. */
  expectedOutputTokens?: number;
}

/**
 * Fabrique d'agent à sortie structurée : un seul chemin d'appel, donc un seul
 * endroit où la validation, la réparation et le coût sont appliqués.
 */
export function createStructuredAgent<TIn, TOut>(
  options: StructuredAgentOptions<TIn, TOut>,
): Agent<TIn, TOut> {
  return {
    name: options.name,
    task: options.task,
    promptFile: options.prompt.filePath,

    estimateTokens(input) {
      const prompt = options.buildPrompt(input);
      return {
        input: estimatePromptTokens(prompt),
        output: options.expectedOutputTokens ?? options.maxOutputTokens,
      };
    },

    async run(input, ctx) {
      const prompt = options.buildPrompt(input);
      const inputTokens = estimatePromptTokens(prompt);
      if (inputTokens > options.maxInputTokens) {
        throw new ValidationError(
          `Contexte trop long pour l’agent ${options.name} : ${inputTokens} jetons estimés > ${options.maxInputTokens}. Réduire le paquet de mémoire plutôt que le budget (docs/04 §5.2).`,
          {
            code: 'AGENT_CONTEXT_TOO_LONG',
            details: { agent: options.name, inputTokens, maxInputTokens: options.maxInputTokens },
          },
        );
      }

      const result = await options.provider.structuredOutput(
        prompt,
        options.schema,
        {
          maxOutputTokens: options.maxOutputTokens,
          temperature: options.temperature ?? 0.2,
          ...(ctx.options ?? {}),
        },
        {
          ...ctx.callContext,
          agent: options.name,
          task: options.task,
          promptVersionId: options.prompt.promptVersionId,
        },
      );

      return { output: result.data, usage: result.usage, repaired: result.repaired };
    },
  };
}
