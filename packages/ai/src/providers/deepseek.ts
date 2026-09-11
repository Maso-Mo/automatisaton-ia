import { CapabilityError, type Clock, type LlmProviderId } from '@aia/shared';
import { findPrice, type ModelPrice } from '../pricing';
import type { LLMProvider } from '../provider';
import {
  OpenAiCompatibleProvider,
  type FetchLike,
  type OpenAiCompatibleConfig,
} from './openai-compatible';

/**
 * Provider **DeepSeek** réel, branché sur l'abstraction `LLMProvider` et sur
 * elle seule (docs/02 §9.1, docs/04 §7.1).
 *
 * Ce qui est **spécifique** à DeepSeek tient en quatre lignes : une adresse, un
 * préfixe d'authentification, des noms de modèles et un tarif. Tout le reste —
 * sortie structurée, réparation, mapping des erreurs, coût — est commun et vit
 * dans `openai-compatible.ts`. Le domaine ne connaît donc jamais DeepSeek : il
 * connaît `LLMProvider`, et le fournisseur s'échange par configuration.
 *
 * ⚠️ À VÉRIFIER avant un usage réel : le modèle par défaut et le tarif
 * (`PRICE_TABLE`, docs/08 §7.3). Aucun prix n'est inventé ici : il vient de la
 * table datée et marquée `verified: false` tant qu'il n'a pas été recontrôlé.
 */

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';

export interface DeepSeekProviderOptions {
  apiKey: string | null;
  model?: string;
  clock: Clock;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  price?: ModelPrice;
}

export class DeepSeekProvider extends OpenAiCompatibleProvider {
  constructor(options: DeepSeekProviderOptions) {
    const model = options.model ?? DEEPSEEK_DEFAULT_MODEL;
    const config: OpenAiCompatibleConfig = {
      provider: 'deepseek',
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? DEEPSEEK_BASE_URL,
      model,
      // Une clé absente ne bloque pas le démarrage : elle fait échouer l'appel en
      // `MissingCredentialError`, et l'écran de diagnostic l'affiche (docs/02 §11).
      price: options.price ?? findPrice('deepseek', model),
      clock: options.clock,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    };
    super(config);
  }
}

/** Modèle local : aucune clé, aucun coût, donc aucun tarif à vérifier. */
export class LocalOpenAiProvider extends OpenAiCompatibleProvider {
  protected override requiresKey(): boolean {
    return false;
  }
}

export interface LlmProviderFactoryConfig {
  providerId: LlmProviderId;
  apiKey: string | null;
  model: string | null;
  clock: Clock;
  /** Adresse du serveur local (Ollama). Ignorée pour les fournisseurs distants. */
  localBaseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Modèle par défaut par fournisseur : une seule table, lisible et testable. */
export const DEFAULT_MODELS: Partial<Record<LlmProviderId, string>> = {
  deepseek: DEEPSEEK_DEFAULT_MODEL,
  ollama: 'llama3.1',
};

/**
 * Fabrique de fournisseurs : le seul endroit où une configuration devient un
 * `LLMProvider`. Les fournisseurs non encore branchés **échouent explicitement**
 * en nommant ce qui manque, plutôt que de retomber silencieusement sur un autre
 * modèle — une substitution silencieuse changerait la qualité et le prix sans
 * que personne ne le sache.
 */
export function createLlmProvider(config: LlmProviderFactoryConfig): LLMProvider {
  const model = config.model ?? DEFAULT_MODELS[config.providerId] ?? null;

  switch (config.providerId) {
    case 'deepseek':
      return new DeepSeekProvider({
        apiKey: config.apiKey,
        ...(model ? { model } : {}),
        clock: config.clock,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      });
    case 'ollama':
      return new LocalOpenAiProvider({
        provider: 'ollama',
        apiKey: null,
        baseUrl: config.localBaseUrl ?? 'http://127.0.0.1:11434/v1',
        model: model ?? 'llama3.1',
        price: findPrice('local', 'local-small'),
        clock: config.clock,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
      });
    default:
      throw new CapabilityError(
        `Fournisseur « ${config.providerId} » non branché : il demande une entrée de tarif datée dans PRICE_TABLE (docs/08 §7.3) avant tout appel. Utiliser deepseek ou ollama.`,
        { code: 'LLM_PROVIDER_NOT_IMPLEMENTED', details: { providerId: config.providerId } },
      );
  }
}
