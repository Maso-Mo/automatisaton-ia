import {
  AppError,
  contentTargetSpec,
  type ContentDraftsOutput,
  type ContentTarget,
  type TargetDraft,
} from '@aia/shared';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_STATE_TRANSITIONS,
  assertTransition,
  needsRegeneration,
  pickDraft,
  targetMeta,
  unexpectedTargets,
} from './content';
import type { DraftValidation } from './validation';

/**
 * La **couverture d'un lot** se teste sans base et sans réseau : ce qui est
 * vérifié ici est la propriété qui protège le produit d'un échec silencieux —
 * « trois contenus sur quatre » n'est jamais un résultat acceptable.
 */

const DRAFT: TargetDraft = {
  title: null,
  hook: 'Une accroche qui tient toute seule',
  body: 'Un corps de brouillon assez long pour passer le minimum du schéma partagé.',
  hashtags: ['#automatisation'],
  mentions: [],
  notes: [],
};

function output(targets: ContentTarget[]): ContentDraftsOutput {
  const drafts: Record<string, TargetDraft> = {};
  for (const target of targets) drafts[target] = DRAFT;
  return { drafts };
}

function validation(target: ContentTarget, ok: boolean): DraftValidation {
  return {
    target,
    ok,
    blocking: ok
      ? []
      : [{ code: 'BODY_TOO_LONG', severity: 'blocking', field: 'body', message: '' }],
    warnings: [],
    stats: { charCount: 0, wordCount: 0, readingTimeSec: 0, hashtagCount: 0, chapters: 0 },
  };
}

/** Le code d'une erreur applicative levée, ou `undefined` si rien n'est levé. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : 'NOT_AN_APP_ERROR';
  }
}

describe('pickDraft — toutes les cibles demandées, jamais moins', () => {
  it('rend le brouillon de la cible demandée', () => {
    const picked = pickDraft(output(['linkedin_post', 'reddit_post']), 'reddit_post');

    expect(picked.body).toBe(DRAFT.body);
  });

  it('échoue bruyamment quand le lot est incomplet', () => {
    const lot = output(['linkedin_post']);
    const error = (() => {
      try {
        pickDraft(lot, 'reddit_post');
        return null;
      } catch (caught) {
        return caught as AppError;
      }
    })();

    expect(error?.code).toBe('DRAFT_MISSING');
    expect(error?.message).toContain(contentTargetSpec('reddit_post').label);
    expect(error?.details).toEqual({ target: 'reddit_post' });
  });
});

describe('unexpectedTargets — une cible inventée n’est pas un contenu', () => {
  it('signale les clés non demandées et ignore les autres', () => {
    const lot = output(['linkedin_post', 'reddit_post', 'tiktok_short']);
    const unexpected = unexpectedTargets(lot, ['linkedin_post', 'reddit_post']);

    expect(unexpected).toEqual(['tiktok_short']);
    expect(unexpectedTargets(lot, ['linkedin_post', 'reddit_post', 'tiktok_short'])).toEqual([]);
    expect(unexpectedTargets({ drafts: {} }, ['linkedin_post'])).toEqual([]);
  });

  it('signale une clé libre, même proche d’une cible connue', () => {
    const lot: ContentDraftsOutput = { drafts: { linkedin: DRAFT as TargetDraft } };

    expect(unexpectedTargets(lot, ['linkedin_post'])).toEqual(['linkedin']);
  });
});

describe('needsRegeneration — seules les cibles fautives', () => {
  it('ne retient que les cibles dont le contrôle a échoué', () => {
    const validations = [
      validation('linkedin_post', true),
      validation('reddit_post', false),
      validation('tiktok_short', true),
      validation('youtube_long', false),
    ];

    // Le critère de docs/05 §4.4 : on ne régénère pas un lot entier parce qu'une
    // plateforme a mal tourné — c'est le coût le plus visible du produit.
    expect(needsRegeneration(validations)).toEqual(['reddit_post', 'youtube_long']);
    expect(needsRegeneration([validation('linkedin_post', true)])).toEqual([]);
    expect(needsRegeneration([])).toEqual([]);
  });
});

describe('targetMeta — la plateforme vient de la spécification', () => {
  it('dérive plateforme, format et libellé sans les recopier', () => {
    const meta = targetMeta('youtube_long');
    const spec = contentTargetSpec('youtube_long');

    expect(meta.platform).toBe(spec.platform);
    expect(meta.format).toBe(spec.format);
    expect(meta.label).toBe(spec.label);
  });
});

describe('transitions d’état du contenu', () => {
  it('autorise les transitions prévues et refuse les autres', () => {
    expect(() => assertTransition('generated', 'in_review')).not.toThrow();
    expect(() => assertTransition('in_review', 'approved')).not.toThrow();
    expect(() => assertTransition('approved', 'editing')).not.toThrow();
    // Idempotence : réaffirmer l'état courant n'est pas une transition.
    expect(() => assertTransition('in_review', 'in_review')).not.toThrow();

    expect(codeOf(() => assertTransition('generated', 'approved'))).toBe(
      'CONTENT_STATE_TRANSITION',
    );
    expect(codeOf(() => assertTransition('archived', 'in_review'))).toBe(
      'CONTENT_STATE_TRANSITION',
    );
    expect(codeOf(() => assertTransition('draft', 'published'))).toBe('CONTENT_STATE_TRANSITION');
  });

  it('décrit un graphe fermé et sans auto-transition', () => {
    const states = Object.keys(
      CONTENT_STATE_TRANSITIONS,
    ) as (keyof typeof CONTENT_STATE_TRANSITIONS)[];

    for (const state of states) {
      expect(CONTENT_STATE_TRANSITIONS[state]).not.toContain(state);
      for (const next of CONTENT_STATE_TRANSITIONS[state]) {
        // Une cible inconnue serait une transition vers un état qui n'existe pas.
        expect(states).toContain(next);
      }
    }

    // Aucun contenu ne peut être publié sans être passé par la relecture.
    expect(CONTENT_STATE_TRANSITIONS.generated).not.toContain('approved');
  });
});
