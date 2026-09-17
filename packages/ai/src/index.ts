/**
 * `@aia/ai` — orchestrateur IA, agents, prompts et abstraction `LLMProvider`.
 *
 * À l'étape 1, ce paquet apporte exactement trois choses, et rien de plus :
 *
 * 1. **le contrat `LLMProvider`** (figé avant le code, docs/02 §9.1) ;
 * 2. **le calcul du coût** et l'enregistrement obligatoire de chaque appel
 *    dans `llm_calls` ;
 * 3. **la synchronisation des prompts** fichiers → `prompt_versions`.
 *
 * L'orchestrateur, les agents et les fournisseurs réels (DeepSeek, OpenRouter,
 * Ollama) arrivent à l'étape 3 : c'est la première étape où une fonctionnalité
 * métier en a besoin.
 */

export * from './agents/agent';
export * from './agents/interviewer';
export * from './agents/platform-writer';
export * from './agents/strategist';
export * from './memory-pack';
export * from './pricing';
export * from './prompts/sync';
export * from './provider';
export * from './providers/deepseek';
export * from './providers/openai-compatible';
export * from './providers/scripted';
export * from './recorder';
export * from './recording-provider';
