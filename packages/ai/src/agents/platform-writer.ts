import {
  ValidationError,
  contentDraftsOutputSchema,
  contentTargetSpec,
  hashText,
  sortContentTargets,
  type ContentDraftsOutput,
  type ContentTarget,
} from '@aia/shared';
import { estimatePromptTokens } from '../pricing';
import { renderMemoryPack, type MemoryPack } from '../memory-pack';
import type { LLMProvider } from '../provider';
import { createStructuredAgent, type Agent, type PromptSource } from './agent';

/**
 * `platform_writer` — le rédacteur multi-plateformes (docs/04 §4.3), tâche
 * `drafts`.
 *
 * Trois décisions structurent cet agent, et elles viennent toutes du même
 * constat : écrire pour cinq plateformes, c'est écrire cinq textes, mais c'est
 * **un seul contexte**.
 *
 * 1. **Un appel par lot, pas un appel par plateforme** (docs/04 §4.3). Le sujet,
 *    l'angle, la voix et les faits sont envoyés une fois ; le modèle rend un
 *    objet dont les clés sont les cibles demandées. Cinq appels enverraient cinq
 *    fois le même contexte et coûteraient cinq fois le prix d'entrée ;
 * 2. **Un prompt par plateforme, plus des règles communes** : `rules.md` porte ce
 *    qui vaut pour tous les textes, chaque fichier de plateforme porte son ton,
 *    sa structure et ses interdits. Le prompt final est la concaténation, dans
 *    l'ordre de `sortContentTargets` — donc reproductible ;
 * 3. **Les limites sont injectées depuis le code**, pas recopiées dans le prompt :
 *    elles sont lues dans `contentTargetSpec` au moment de construire le prompt.
 *    Un chiffre écrit à la main dans un fichier de prompt finit toujours par
 *    diverger du code qui vérifie (`validateDraft`), et c'est le code qui a
 *    raison.
 *
 * Ce que cet agent ne fait **pas**, volontairement : critiquer, vérifier les
 * affirmations, ou décider si le texte est publiable. C'est l'étape 5.
 */

export const PLATFORM_WRITER_AGENT = 'platform_writer';
/** Tâche des règles communes ; chaque cible est sa propre tâche (`linkedin_post`…). */
export const PLATFORM_WRITER_RULES_TASK = 'editorial_rules';
/**
 * Tâche de l'agent lui-même : **un** appel couvre toutes les cibles demandées.
 * C'est la valeur écrite dans `llm_calls.task`, partagée avec le worker par
 * cette constante plutôt que recopiée des deux côtés.
 */
export const PLATFORM_WRITER_TASK = 'drafts';
/**
 * Température de la rédaction : plus haute que l'entretien (qui doit être
 * stable), plus basse que la génération d'idées d'angles (qui doit surprendre).
 */
export const PLATFORM_WRITER_TEMPERATURE = 0.4;

/** Cinq textes dans un seul appel : l'entrée est bornée, la sortie l'est aussi. */
export const PLATFORM_WRITER_MAX_INPUT_TOKENS = 10_000;
export const PLATFORM_WRITER_MAX_OUTPUT_TOKENS = 6_000;

export interface PlatformWriterSubject {
  title: string;
  thesis: string;
  pillar: string | null;
}

/** L'angle choisi : c'est lui qui porte l'argumentaire du texte. */
export interface PlatformWriterAngle {
  hook: string;
  angleType: string;
  structure: readonly string[];
  evidence: readonly string[];
  difficulty: string;
  estimatedLength: string;
  platformHint: string | null;
  rationale: string;
}

/**
 * Une réécriture **ciblée** : une seule plateforme est concernée, et le modèle
 * repart du texte refusé plutôt que de zéro — sinon il réintroduit les mêmes
 * défauts (docs/04 §4.3).
 */
export interface PlatformWriterRetry {
  target: ContentTarget;
  /** Le reproche, en clair : c'est aussi ce qui sera affiché à l'utilisateur. */
  reason: string;
  /** Le texte précédent, tel qu'il a été produit. */
  previousBody: string;
}

export interface PlatformWriterInput {
  memoryPack: MemoryPack;
  subject: PlatformWriterSubject;
  angle: PlatformWriterAngle;
  /** Les cibles demandées. Elles sont triées ici, jamais par l'appelant. */
  targets: readonly ContentTarget[];
  retries?: readonly PlatformWriterRetry[];
}

export interface PlatformWriterAgentOptions {
  provider: LLMProvider;
  /** `prompts/platform_writer/rules.md` — les règles communes à toutes les cibles. */
  rules: PromptSource;
  /** Un prompt par cible. Une cible sans prompt est refusée avant tout appel. */
  targets: Partial<Record<ContentTarget, PromptSource>>;
  maxOutputTokens?: number;
  maxInputTokens?: number;
  temperature?: number;
}

/**
 * Les prompts réellement utilisés par un lot : les règles, puis une section par
 * cible. C'est ce que l'appelant journalise comme empreinte — un lot qui change
 * de prompt pour une seule plateforme change l'empreinte du lot.
 */
export function platformWriterPromptSources(
  rules: PromptSource,
  targets: Partial<Record<ContentTarget, PromptSource>>,
  requested: readonly ContentTarget[],
): PromptSource[] {
  return [
    rules,
    ...sortContentTargets(requested).map((target) => {
      const source = targets[target];
      if (!source) throw missingPromptError(target);
      return source;
    }),
  ];
}

/** Empreinte combinée d'un lot : ce que reçoit `content_versions.prompt_version_hash`. */
export function platformWriterPromptHash(sources: readonly PromptSource[]): string {
  return hashText(
    sources.map((source) => `${source.filePath}:${source.promptVersionId}`).join('|'),
  );
}

function missingPromptError(target: ContentTarget): ValidationError {
  return new ValidationError(
    `Aucun prompt actif pour la cible « ${contentTargetSpec(target).label} » : la génération ne part pas sans ses règles de plateforme.`,
    { code: 'PROMPT_MISSING', details: { agent: PLATFORM_WRITER_AGENT, target } },
  );
}

/** Les rappels chiffrés, lus dans le code au moment de construire le prompt. */
function constraintBlock(target: ContentTarget): string[] {
  const spec = contentTargetSpec(target);
  return [
    `### Contraintes vérifiées en code pour \`${spec.key}\``,
    `- clé de sortie : "${spec.key}"`,
    `- forme attendue : ${spec.shape}`,
    `- \`body\` : ${spec.bodyMaxChars} caractères maximum (vise ${spec.bodyTargetChars})`,
    spec.titleMaxChars === null
      ? '- `title` : aucun titre pour cette cible (`null`)'
      : `- \`title\` : obligatoire, ${spec.titleMaxChars} caractères maximum`,
    `- \`hook\` : ${spec.hookMaxChars} caractères maximum`,
    spec.hashtagsMax === 0
      ? '- `hashtags` : aucun (liste vide)'
      : `- \`hashtags\` : de ${spec.hashtagsMin} à ${spec.hashtagsMax}`,
    spec.segmentsRequired
      ? '- le corps doit contenir des chapitres horodatés (`mm:ss` en début de ligne)'
      : '- pas de chapitres horodatés exigés',
  ];
}

function retryBlock(retry: PlatformWriterRetry): string[] {
  return [
    `### Réécriture demandée pour \`${retry.target}\``,
    `Motif du refus : ${retry.reason}`,
    'Texte précédent (à reprendre, pas à recopier tel quel) :',
    '```',
    retry.previousBody,
    '```',
  ];
}

/**
 * Construit le prompt complet d'un lot. Exporté pour les tests : ce que le modèle
 * reçoit doit pouvoir être relu **sans appeler de modèle** (docs/09 §6).
 */
export function buildPlatformWriterPrompt(
  input: PlatformWriterInput,
  sections: Partial<Record<ContentTarget, string>>,
): string {
  const targets = sortContentTargets(input.targets);
  if (targets.length === 0) {
    throw new ValidationError('Aucune cible demandée : le rédacteur ne se lance pas.', {
      code: 'NO_CONTENT_TARGET',
      details: { agent: PLATFORM_WRITER_AGENT },
    });
  }

  const lines: string[] = [];
  lines.push(renderMemoryPack(input.memoryPack));
  lines.push('');
  lines.push('## Sujet retenu');
  lines.push(`Titre : ${input.subject.title}`);
  lines.push(`Thèse : ${input.subject.thesis}`);
  if (input.subject.pillar) lines.push(`Pilier : ${input.subject.pillar}`);

  lines.push('', '## Angle choisi');
  lines.push(`Accroche : ${input.angle.hook}`);
  lines.push(`Type d’angle : ${input.angle.angleType}`);
  lines.push(`Difficulté : ${input.angle.difficulty}`);
  lines.push(`Longueur estimée : ${input.angle.estimatedLength}`);
  if (input.angle.platformHint) lines.push(`Note de plateforme : ${input.angle.platformHint}`);
  if (input.angle.structure.length > 0) {
    lines.push('Structure proposée :');
    lines.push(...input.angle.structure.map((step) => `- ${step}`));
  }
  if (input.angle.evidence.length > 0) {
    lines.push('Éléments de preuve disponibles :');
    lines.push(...input.angle.evidence.map((item) => `- ${item}`));
  }
  lines.push(`Pourquoi cet angle : ${input.angle.rationale}`);

  const retries = input.retries ?? [];
  for (const retry of retries) {
    lines.push('', ...retryBlock(retry));
  }

  lines.push('', `## Plateformes à produire (${targets.length})`);
  lines.push(
    'Une section par cible. Les règles communes sont au-dessus : elles s’appliquent à toutes.',
  );
  for (const target of targets) {
    const section = sections[target];
    if (section === undefined) throw missingPromptError(target);
    lines.push('', '---', '', section.trim(), '', ...constraintBlock(target));
    if (retries.some((candidate) => candidate.target === target)) {
      lines.push(
        'Cette cible est en réécriture : corrige ce que le motif de refus décrit, sans changer le reste.',
      );
    }
  }

  lines.push(
    '',
    '## Réponse attendue',
    `Objet JSON unique : \`{ "drafts": { ${targets
      .map((target) => `"${target}": { … }`)
      .join(', ')} } }\`.`,
    'Exactement ces clés, ni plus ni moins. Pas de texte autour du JSON.',
  );

  return lines.join('\n');
}

/**
 * Fabrique de l'agent. `buildPrompt` fait deux choses que le reste du produit
 * suppose acquises : refuser une cible sans prompt **avant** l'appel, et injecter
 * les limites depuis `contentTargetSpec`.
 */
export function createPlatformWriterAgent(
  options: PlatformWriterAgentOptions,
): Agent<PlatformWriterInput, ContentDraftsOutput> {
  const sections: Partial<Record<ContentTarget, string>> = {};
  for (const [target, source] of Object.entries(options.targets)) {
    if (source) sections[target as ContentTarget] = source.body;
  }

  return createStructuredAgent<PlatformWriterInput, ContentDraftsOutput>({
    name: PLATFORM_WRITER_AGENT,
    task: PLATFORM_WRITER_TASK,
    provider: options.provider,
    prompt: options.rules,
    schema: contentDraftsOutputSchema,
    maxOutputTokens: options.maxOutputTokens ?? PLATFORM_WRITER_MAX_OUTPUT_TOKENS,
    maxInputTokens: options.maxInputTokens ?? PLATFORM_WRITER_MAX_INPUT_TOKENS,
    temperature: options.temperature ?? PLATFORM_WRITER_TEMPERATURE,
    // La sortie attendue s'annonce par lot : la génération est la dépense la plus
    // lourde du produit, donc celle dont le veto de budget a le plus besoin d'une
    // estimation honnête (docs/08 §7.2).
    expectedOutputTokens: options.maxOutputTokens ?? PLATFORM_WRITER_MAX_OUTPUT_TOKENS,
    buildPrompt: (input) => buildPlatformWriterPrompt(input, sections),
  });
}

/** Jetons estimés d'un lot, sans réseau : sert au veto de budget et aux tests. */
export function estimatePlatformWriterTokens(
  input: PlatformWriterInput,
  sections: Partial<Record<ContentTarget, string>>,
  maxOutputTokens = PLATFORM_WRITER_MAX_OUTPUT_TOKENS,
): { input: number; output: number } {
  return {
    input: estimatePromptTokens(buildPlatformWriterPrompt(input, sections)),
    output: maxOutputTokens,
  };
}
