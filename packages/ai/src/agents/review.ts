import {
  criticOutputSchema,
  factCheckerOutputSchema,
  type CriticOutput,
  type FactCheckerOutput,
  type PlatformId,
} from '@aia/shared';
import type { Agent, PromptSource } from './agent';
import { createStructuredAgent } from './agent';
import type { LLMProvider } from '../provider';

export interface CriticInput {
  platform: PlatformId;
  title: string | null;
  hook: string | null;
  body: string;
  recentPublishedBodies: string[];
}

export interface FactCheckerInput {
  title: string | null;
  hook: string | null;
  body: string;
  facts: Array<{ id: string; statement: string; verificationStatus: string }>;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function createCriticAgent(options: {
  provider: LLMProvider;
  prompt: PromptSource;
}): Agent<CriticInput, CriticOutput> {
  return createStructuredAgent({
    name: 'critic',
    task: 'review',
    provider: options.provider,
    prompt: options.prompt,
    schema: criticOutputSchema,
    maxInputTokens: 8_000,
    maxOutputTokens: 1_500,
    expectedOutputTokens: 700,
    temperature: 0.1,
    buildPrompt: (input) =>
      `${options.prompt.body}\n\n## Donnees a juger\n${json(input)}\n\nReponds uniquement avec l'objet JSON demande.`,
  });
}

export function createFactCheckerAgent(options: {
  provider: LLMProvider;
  prompt: PromptSource;
}): Agent<FactCheckerInput, FactCheckerOutput> {
  return createStructuredAgent({
    name: 'fact_checker',
    task: 'assess',
    provider: options.provider,
    prompt: options.prompt,
    schema: factCheckerOutputSchema,
    maxInputTokens: 8_000,
    maxOutputTokens: 2_000,
    expectedOutputTokens: 900,
    temperature: 0,
    buildPrompt: (input) =>
      `${options.prompt.body}\n\n## Texte et preuves locales\n${json(input)}\n\nReponds uniquement avec l'objet JSON demande.`,
  });
}
