import { interviewerOutputSchema, type InterviewerOutput } from '@aia/shared';
import { renderMemoryPack, type MemoryPack } from '../memory-pack';
import type { LLMProvider } from '../provider';
import { createStructuredAgent, type Agent, type PromptSource } from './agent';

/**
 * `interviewer` — l'intervieweur (docs/04 §4.1).
 *
 * Ce qui le distingue d'un chatbot : il ne cherche pas à être agréable, il
 * cherche à **combler les trous** de la fiche maître. La trame (« ce qu'il
 * manque ») est calculée localement par le domaine ; l'agent la reçoit et la
 * reformule. Il ne décide donc jamais quelle question poser — il l'énonce.
 *
 * Garde-fou de niveau 3 (docs/04 §6.3) : tout fait proposé doit citer un extrait
 * du message de l'utilisateur. Le domaine vérifie cette citation et refuse les
 * autres : un fait inventé n'a pas de citation à produire.
 */

/** Message de la fenêtre glissante, tel que le domaine le fournit. */
export interface InterviewerWindowMessage {
  role: string;
  content: string | null;
  messageType: string;
}

export interface InterviewerInput {
  memoryPack: MemoryPack;
  /** Dix derniers messages verbatim (docs/03 §6.6, docs/04 §5.2). */
  window: readonly InterviewerWindowMessage[];
  /** Résumés des blocs de 20 messages déjà couverts. */
  summaries: readonly string[];
  /** La lacune courante, nommée par le domaine. `null` : plus rien ne manque. */
  slot: string | null;
  /** Trame locale associée à la lacune (formulation de départ, pas une consigne figée). */
  guidance: string | null;
  /** Questions restées ouvertes au tour précédent : à ne pas oublier. */
  openQuestions: readonly string[];
  /** Nouveau message de l'utilisateur : la source des citations autorisées. */
  userMessage: string;
  projectName: string;
}

export interface InterviewerAgentOptions {
  provider: LLMProvider;
  prompt: PromptSource;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  temperature?: number;
}

/** Le plafond d'entrée borne le coût d'un tour (docs/04 §5.2 : ~6 000 jetons). */
export const INTERVIEWER_MAX_INPUT_TOKENS = 6_000;
export const INTERVIEWER_MAX_OUTPUT_TOKENS = 1_500;

export function buildInterviewerPrompt(input: InterviewerInput): string {
  const parts: string[] = [];
  parts.push('# Contexte du projet');
  parts.push(renderMemoryPack(input.memoryPack));
  parts.push('', '# Échanges récents');

  if (input.summaries.length > 0) {
    parts.push('## Résumés des échanges antérieurs');
    parts.push(input.summaries.map((summary) => `- ${summary}`).join('\n'));
  }

  parts.push(
    input.window.length === 0
      ? '(aucun échange pour l’instant : c’est le tout premier message)'
      : input.window
          .map((message) => `${labelFor(message)} : ${message.content ?? '(vide)'}`)
          .join('\n'),
  );

  parts.push('', '# Ce qu’il reste à apprendre (calculé, jamais deviné)');
  parts.push(
    input.slot === null
      ? 'La mémoire du projet est complète pour une fiche maître. Ne pas inventer de nouvelles lacunes.'
      : `Lacune courante : ${input.slot}. ${input.guidance ?? ''}`,
  );

  if (input.openQuestions.length > 0) {
    parts.push('', '# Questions restées ouvertes');
    parts.push(input.openQuestions.map((question) => `- ${question}`).join('\n'));
  }

  parts.push('', '# Nouveau message de l’utilisateur', input.userMessage);
  return parts.join('\n');
}

function labelFor(message: InterviewerWindowMessage): string {
  if (message.role === 'user') return 'Utilisateur';
  if (message.role === 'tool') return 'Mémoire consultée';
  return 'Assistant';
}

export function createInterviewerAgent(
  options: InterviewerAgentOptions,
): Agent<InterviewerInput, InterviewerOutput> {
  return createStructuredAgent<InterviewerInput, InterviewerOutput>({
    name: 'interviewer',
    task: 'converse',
    provider: options.provider,
    prompt: options.prompt,
    schema: interviewerOutputSchema,
    buildPrompt: (input) => `${options.prompt.body}\n\n${buildInterviewerPrompt(input)}`,
    maxOutputTokens: options.maxOutputTokens ?? INTERVIEWER_MAX_OUTPUT_TOKENS,
    maxInputTokens: options.maxInputTokens ?? INTERVIEWER_MAX_INPUT_TOKENS,
    temperature: options.temperature ?? 0.3,
    expectedOutputTokens: 700,
  });
}
