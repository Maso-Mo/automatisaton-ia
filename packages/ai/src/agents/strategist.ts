import { masterBriefOutputSchema, type MasterBriefOutput } from '@aia/shared';
import { renderMemoryPack, type MemoryPack } from '../memory-pack';
import type { LLMProvider } from '../provider';
import { createStructuredAgent, type Agent, type PromptSource } from './agent';

/**
 * `strategist` — le stratège (docs/04 §4.2), tâche `master_brief`.
 *
 * La fiche maître **n'est pas un résumé de conversation** : c'est une structure
 * (problème traité, positionnement, public, piliers, thèmes, formats, rythme,
 * critères de réussite), dont les trous sont explicites. Un modèle qui n'a pas
 * l'information écrit `null` : l'interface affiche « à compléter » et
 * l'intervieweur repose la question au tour suivant.
 *
 * Le routage (`docs/04 §7.1`) place cette tâche sur un modèle **intermédiaire** :
 * la fiche maître conditionne tout le reste, c'est là que la qualité se paie.
 *
 * Sortie volontairement unimodale à cette étape : les sujets et les angles
 * viendront avec l'étape éditoriale ; les produire ici serait du code qui
 * remplirait des tables qui n'existent pas encore (docs/10 §1.3).
 */

export interface StrategistInput {
  memoryPack: MemoryPack;
  /** Points restés ouverts après l'entretien : ils deviennent des trous assumés. */
  openQuestions: readonly string[];
  /** Résumés de l'entretien : la matière d'une synthèse, bornée en taille. */
  summaries: readonly string[];
  /** Messages de l'entretien retenus comme source (traçabilité de la fiche). */
  window: readonly string[];
}

export interface StrategistAgentOptions {
  provider: LLMProvider;
  prompt: PromptSource;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  temperature?: number;
}

export const STRATEGIST_MAX_INPUT_TOKENS = 8_000;
export const STRATEGIST_MAX_OUTPUT_TOKENS = 2_500;

export function buildStrategistPrompt(input: StrategistInput): string {
  const parts: string[] = [];
  parts.push('# Mémoire vérifiée du projet');
  parts.push(renderMemoryPack(input.memoryPack));

  if (input.summaries.length > 0) {
    parts.push('', '# Résumés de l’entretien');
    parts.push(input.summaries.map((summary) => `- ${summary}`).join('\n'));
  }

  if (input.window.length > 0) {
    parts.push('', '# Extraits de l’entretien');
    parts.push(input.window.map((line) => `- ${line}`).join('\n'));
  }

  parts.push('', '# Points restés ouverts');
  parts.push(
    input.openQuestions.length === 0
      ? 'Aucun point ouvert signalé par l’entretien.'
      : input.openQuestions.map((question) => `- ${question}`).join('\n'),
  );
  parts.push(
    '',
    'Rappel : pour toute information absente, écris null. Un trou visible vaut mieux qu’une invention plausible.',
  );
  return parts.join('\n');
}

export function createStrategistAgent(
  options: StrategistAgentOptions,
): Agent<StrategistInput, MasterBriefOutput> {
  return createStructuredAgent<StrategistInput, MasterBriefOutput>({
    name: 'strategist',
    task: 'master_brief',
    provider: options.provider,
    prompt: options.prompt,
    schema: masterBriefOutputSchema,
    buildPrompt: (input) => `${options.prompt.body}\n\n${buildStrategistPrompt(input)}`,
    maxOutputTokens: options.maxOutputTokens ?? STRATEGIST_MAX_OUTPUT_TOKENS,
    maxInputTokens: options.maxInputTokens ?? STRATEGIST_MAX_INPUT_TOKENS,
    temperature: options.temperature ?? 0.3,
    expectedOutputTokens: 1_200,
  });
}
