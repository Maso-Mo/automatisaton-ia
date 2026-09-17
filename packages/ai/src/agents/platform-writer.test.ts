import {
  createManualClock,
  contentTargetSpec,
  ValidationError,
  type ContentTarget,
} from '@aia/shared';
import { describe, expect, it } from 'vitest';
import type { MemoryPack } from '../memory-pack';
import { findPrice } from '../pricing';
import { ScriptedLLMProvider } from '../providers/scripted';
import type { PromptSource } from './agent';
import {
  PLATFORM_WRITER_AGENT,
  PLATFORM_WRITER_MAX_INPUT_TOKENS,
  PLATFORM_WRITER_MAX_OUTPUT_TOKENS,
  buildPlatformWriterPrompt,
  createPlatformWriterAgent,
  estimatePlatformWriterTokens,
  platformWriterPromptHash,
  platformWriterPromptSources,
  type PlatformWriterInput,
} from './platform-writer';

/**
 * `platform_writer` se teste **sans réseau** : le prompt est une fonction pure du
 * contexte, donc ce que le modèle verra se relit ligne à ligne ici (docs/09 §6).
 *
 * C'est important pour une raison de coût : la génération est l'appel le plus
 * cher du produit, et les deux erreurs qu'on ne peut pas se permettre — oublier
 * une plateforme demandée, ou renvoyer cinq fois le même contexte — se voient
 * dans le prompt, pas dans la réponse.
 */

const clock = createManualClock(Date.UTC(2026, 2, 10, 12, 0, 0));
const price = findPrice('deepseek', 'deepseek-chat');

const RULES: PromptSource = {
  promptVersionId: 'prompt-rules-v1',
  filePath: 'platform_writer/rules.md',
  body: 'RÈGLES COMMUNES : tu écris le texte, tu ne le commentes pas.',
};

function sourceFor(target: ContentTarget, version = 'v1'): PromptSource {
  return {
    promptVersionId: `prompt-${target}-${version}`,
    filePath: `platform_writer/${target}.md`,
    body: `SECTION ${target} (${version})`,
  };
}

const TARGET_SOURCES: Partial<Record<ContentTarget, PromptSource>> = {
  linkedin_post: sourceFor('linkedin_post'),
  reddit_post: sourceFor('reddit_post'),
  tiktok_short: sourceFor('tiktok_short'),
  youtube_short: sourceFor('youtube_short'),
  youtube_long: sourceFor('youtube_long'),
};

const PACK: MemoryPack = {
  project: {
    id: 'projet-1',
    name: 'Automatisation IA',
    status: 'active',
    positioning: 'Automatiser le travail répétitif des indépendants',
    targetGoal: 'Signer trois clients',
    language: 'fr',
  },
  skillFacts: [{ skill: 'n8n', level: 'avance', evidence: 'Trois workflows en production' }],
  facts: [
    {
      id: 'fait-1',
      category: 'chiffre',
      statement: 'J’ai automatisé la relance des devis en trois semaines',
      detail: null,
      importance: 5,
      verificationStatus: 'verified',
    },
  ],
  style: { name: 'Direct', tone: 'franc', formality: 2, forbiddenWords: ['disruptif'] },
  audience: {
    name: 'Freelances',
    description: null,
    knowledgeLevel: 'debutant',
    painPoints: ['devis perdus'],
  },
  learnings: [],
  recentContent: [],
  manifest: {
    factIds: ['fait-1'],
    skillNames: ['n8n'],
    audienceName: 'Freelances',
    styleName: 'Direct',
    estimatedTokens: 120,
  },
  droppedFactIds: [],
};

function input(overrides: Partial<PlatformWriterInput> = {}): PlatformWriterInput {
  return {
    memoryPack: PACK,
    subject: {
      title: 'Relancer ses devis sans y penser',
      thesis: 'Une relance automatique bat une relance héroïque.',
      pillar: 'automatisation',
    },
    angle: {
      hook: 'J’ai arrêté de relancer mes devis à la main.',
      angleType: 'retour d’expérience',
      structure: ['Le problème', 'Ce que j’ai fait'],
      evidence: ['Trois semaines de mise en place'],
      difficulty: 'facile',
      estimatedLength: 'court',
      platformHint: null,
      rationale: 'Le sujet est déjà éprouvé auprès de deux clients.',
    },
    targets: ['linkedin_post'],
    ...overrides,
  };
}

/** Les sections telles que le câblage les fournit : un corps par cible demandée. */
function sections(targets: readonly ContentTarget[]): Partial<Record<ContentTarget, string>> {
  const result: Partial<Record<ContentTarget, string>> = {};
  for (const target of targets) {
    const source = TARGET_SOURCES[target];
    if (source) result[target] = source.body;
  }
  return result;
}

/** Le code d'une erreur de validation, ou `undefined` si rien n'est levé. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof ValidationError ? error.code : 'NOT_A_VALIDATION_ERROR';
  }
}

describe('buildPlatformWriterPrompt — un appel, toutes les plateformes', () => {
  it('envoie le contexte projet une seule fois, et une section par cible demandée', () => {
    const prompt = buildPlatformWriterPrompt(input(), sections(['linkedin_post']));

    // Le contexte : mémoire du projet, sujet, angle — sans lui, le texte n'est
    // pas « de cet utilisateur » (docs/04 §5.1).
    expect(prompt).toContain('Automatisation IA');
    expect(prompt).toContain('J’ai automatisé la relance des devis en trois semaines');
    expect(prompt).toContain('Freelances');
    expect(prompt).toContain('Relancer ses devis sans y penser');
    expect(prompt).toContain('Une relance automatique bat une relance héroïque.');
    expect(prompt).toContain('retour d’expérience');

    // Une seule section de plateforme : ce qui n'est pas demandé n'est pas envoyé.
    expect(prompt).toContain('SECTION linkedin_post (v1)');
    expect(prompt).not.toContain('SECTION reddit_post (v1)');
    expect(prompt).not.toContain('SECTION tiktok_short (v1)');
  });

  it('trie les cibles et rend le même prompt quel que soit l’ordre demandé', () => {
    const ordered = buildPlatformWriterPrompt(
      input({ targets: ['linkedin_post', 'tiktok_short', 'youtube_long'] }),
      sections(['linkedin_post', 'tiktok_short', 'youtube_long']),
    );
    const shuffled = buildPlatformWriterPrompt(
      input({ targets: ['youtube_long', 'linkedin_post', 'tiktok_short'] }),
      sections(['linkedin_post', 'tiktok_short', 'youtube_long']),
    );

    expect(shuffled).toBe(ordered);
    expect(ordered.indexOf('SECTION linkedin_post (v1)')).toBeLessThan(
      ordered.indexOf('SECTION tiktok_short (v1)'),
    );
    expect(ordered.indexOf('SECTION tiktok_short (v1)')).toBeLessThan(
      ordered.indexOf('SECTION youtube_long (v1)'),
    );
    // Les clés annoncées suivent le même ordre : le modèle rend un objet dont
    // l'ordre ne dépend jamais de celui de l'appelant.
    expect(ordered).toContain(
      '{ "drafts": { "linkedin_post": { … }, "tiktok_short": { … }, "youtube_long": { … } } }',
    );
  });

  it('lit les limites dans le code plutôt que dans le fichier de prompt', () => {
    const long = contentTargetSpec('youtube_long');
    const short = contentTargetSpec('youtube_short');
    const prompt = buildPlatformWriterPrompt(
      input({ targets: ['tiktok_short', 'youtube_short', 'youtube_long'] }),
      sections(['tiktok_short', 'youtube_short', 'youtube_long']),
    );

    // Un chiffre écrit à la main dans un prompt finit par diverger du code qui
    // vérifie (`validateDraft`) : la seule source est la spécification partagée.
    expect(prompt).toContain(`${long.bodyMaxChars} caractères maximum`);
    expect(prompt).toContain(`${long.bodyTargetChars}`);
    expect(prompt).toContain(`${long.hookMaxChars} caractères maximum`);
    expect(prompt).toContain(`de ${long.hashtagsMin} à ${long.hashtagsMax}`);
    expect(prompt).toContain('chapitres horodatés');

    expect(prompt).toContain(`obligatoire, ${short.titleMaxChars} caractères maximum`);
    expect(prompt).toContain('aucun titre pour cette cible');
  });

  it('joint le texte refusé et son motif, mais seulement pour la cible réécrite', () => {
    const prompt = buildPlatformWriterPrompt(
      input({
        targets: ['linkedin_post', 'reddit_post'],
        retries: [
          {
            target: 'reddit_post',
            reason: 'Ton promotionnel : Reddit bannit l’auto-promotion.',
            previousBody: 'Ancien texte trop commercial.',
          },
        ],
      }),
      sections(['linkedin_post', 'reddit_post']),
    );

    expect(prompt).toContain('Réécriture demandée pour `reddit_post`');
    expect(prompt).toContain('Motif du refus : Ton promotionnel : Reddit bannit l’auto-promotion.');
    expect(prompt).toContain('Ancien texte trop commercial.');
    expect(prompt).not.toContain('Réécriture demandée pour `linkedin_post`');
    // Une seule cible repart du texte précédent, les autres ne sont pas
    // retouchées : la réécriture ciblée ne coûte pas un second lot complet.
    expect(prompt.match(/Cette cible est en réécriture/g)).toHaveLength(1);
  });

  it('refuse un lot sans cible, ou une cible sans prompt, avant tout appel', () => {
    expect(codeOf(() => buildPlatformWriterPrompt(input({ targets: [] }), {}))).toBe(
      'NO_CONTENT_TARGET',
    );
    expect(
      codeOf(() =>
        buildPlatformWriterPrompt(
          input({ targets: ['linkedin_post', 'reddit_post'] }),
          sections(['linkedin_post']),
        ),
      ),
    ).toBe('PROMPT_MISSING');
  });
});

describe('platformWriterPromptSources — empreinte d’un lot', () => {
  it('liste les règles puis les cibles triées, et échoue sur un prompt manquant', () => {
    const sources = platformWriterPromptSources(RULES, TARGET_SOURCES, [
      'youtube_long',
      'linkedin_post',
    ]);

    expect(sources.map((source) => source.filePath)).toEqual([
      'platform_writer/rules.md',
      'platform_writer/linkedin_post.md',
      'platform_writer/youtube_long.md',
    ]);
    expect(
      codeOf(() =>
        platformWriterPromptSources(RULES, { linkedin_post: sourceFor('linkedin_post') }, [
          'linkedin_post',
          'tiktok_short',
        ]),
      ),
    ).toBe('PROMPT_MISSING');
  });

  it('ne dépend pas de l’ordre demandé, mais change si un prompt change', () => {
    const ordered = platformWriterPromptSources(RULES, TARGET_SOURCES, [
      'linkedin_post',
      'reddit_post',
    ]);
    const shuffled = platformWriterPromptSources(RULES, TARGET_SOURCES, [
      'reddit_post',
      'linkedin_post',
    ]);
    expect(platformWriterPromptHash(shuffled)).toBe(platformWriterPromptHash(ordered));

    // Une seule plateforme change : l'empreinte du lot change, donc la version
    // de contenu produite est distincte (docs/03 §14.4).
    const bumped = platformWriterPromptSources(
      RULES,
      { ...TARGET_SOURCES, reddit_post: sourceFor('reddit_post', 'v2') },
      ['linkedin_post', 'reddit_post'],
    );
    expect(platformWriterPromptHash(bumped)).not.toBe(platformWriterPromptHash(ordered));

    const otherRules = platformWriterPromptSources(
      { ...RULES, promptVersionId: 'prompt-rules-v2' },
      TARGET_SOURCES,
      ['linkedin_post', 'reddit_post'],
    );
    expect(platformWriterPromptHash(otherRules)).not.toBe(platformWriterPromptHash(ordered));
  });
});

/** Un brouillon minimal mais conforme au schéma : c'est le contrat de sortie. */
const DRAFT = {
  title: null,
  hook: 'Une accroche qui tient toute seule',
  body: 'Un corps de brouillon assez long pour passer le minimum imposé par le schéma partagé.',
  hashtags: ['#automatisation'],
  mentions: [],
  notes: [],
};

const RUN_CONTEXT = { callContext: { agent: PLATFORM_WRITER_AGENT, task: 'drafts' } };

function makeProvider(responses: readonly string[]) {
  return new ScriptedLLMProvider({ model: 'deepseek-chat', price, clock, responses });
}

describe('createPlatformWriterAgent — un seul appel pour tout le lot', () => {
  it('décrit l’agent et l’estime sans réseau', () => {
    const provider = makeProvider([]);
    const agent = createPlatformWriterAgent({ provider, rules: RULES, targets: TARGET_SOURCES });
    const targets: ContentTarget[] = ['linkedin_post', 'reddit_post'];

    expect(agent.name).toBe(PLATFORM_WRITER_AGENT);
    expect(agent.task).toBe('drafts');
    // Le prompt « principal » est le fichier de règles : les sections de
    // plateforme sont injectées par `buildPrompt`, jamais stockées comme prompt.
    expect(agent.promptFile).toBe(RULES.filePath);

    const estimate = agent.estimateTokens(input({ targets }));
    expect(estimate.output).toBe(PLATFORM_WRITER_MAX_OUTPUT_TOKENS);
    expect(estimate.input).toBeGreaterThan(0);
    expect(estimate.input).toBeLessThan(PLATFORM_WRITER_MAX_INPUT_TOKENS);
    expect(estimatePlatformWriterTokens(input({ targets }), sections(targets))).toEqual(estimate);
    // Estimer ne coûte rien : aucun appel n'est parti.
    expect(provider.calls).toHaveLength(0);
  });

  it('rend un brouillon par cible demandée, en un seul appel', async () => {
    const provider = makeProvider([
      JSON.stringify({ drafts: { linkedin_post: DRAFT, reddit_post: DRAFT } }),
    ]);
    const agent = createPlatformWriterAgent({ provider, rules: RULES, targets: TARGET_SOURCES });

    const result = await agent.run(
      input({ targets: ['linkedin_post', 'reddit_post'] }),
      RUN_CONTEXT,
    );

    // Le critère de sortie de l'étape 4 : quatre plateformes, un appel.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.ctx.agent).toBe(PLATFORM_WRITER_AGENT);
    expect(provider.calls[0]?.ctx.task).toBe('drafts');
    expect(provider.calls[0]?.prompt).toContain('SECTION reddit_post (v1)');
    expect(Object.keys(result.output.drafts)).toEqual(['linkedin_post', 'reddit_post']);
    expect(result.output.drafts.linkedin_post?.body).toBe(DRAFT.body);
    expect(result.repaired).toBe(false);
  });

  it('répare une sortie mal emballée et le signale', async () => {
    const provider = makeProvider([
      ['```json', JSON.stringify({ drafts: { linkedin_post: DRAFT } }), '```'].join('\n'),
    ]);
    const agent = createPlatformWriterAgent({ provider, rules: RULES, targets: TARGET_SOURCES });

    const result = await agent.run(input(), RUN_CONTEXT);

    // Une réparation réussie reste un signal : un taux élevé veut dire que le
    // prompt est à revoir, pas que tout va bien (docs/09 §2).
    expect(result.repaired).toBe(true);
    expect(result.output.drafts.linkedin_post?.hook).toBe(DRAFT.hook);
  });

  it('refuse une sortie non conforme au schéma', async () => {
    const provider = makeProvider([
      JSON.stringify({ drafts: { linkedin_post: { ...DRAFT, body: 'court' } } }),
    ]);
    const agent = createPlatformWriterAgent({ provider, rules: RULES, targets: TARGET_SOURCES });

    await expect(agent.run(input(), RUN_CONTEXT)).rejects.toThrow(/non conforme au schéma/);
  });

  it('refuse une cible sans prompt **sans** appeler le modèle', async () => {
    const provider = makeProvider(['{"drafts":{}}']);
    const agent = createPlatformWriterAgent({
      provider,
      rules: RULES,
      targets: { linkedin_post: TARGET_SOURCES.linkedin_post },
    });

    await expect(
      agent.run(input({ targets: ['linkedin_post', 'tiktok_short'] }), RUN_CONTEXT),
    ).rejects.toThrow(/Aucun prompt actif/);
    expect(provider.calls).toHaveLength(0);
  });

  it('refuse un contexte trop long plutôt que de payer un appel tronqué', async () => {
    const provider = makeProvider(['{"drafts":{}}']);
    const agent = createPlatformWriterAgent({
      provider,
      rules: RULES,
      targets: TARGET_SOURCES,
      maxInputTokens: 5,
    });

    await expect(agent.run(input(), RUN_CONTEXT)).rejects.toThrow(/Contexte trop long/);
    expect(provider.calls).toHaveLength(0);
  });
});
