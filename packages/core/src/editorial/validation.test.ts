import { contentTargetSpec, type TargetDraft } from '@aia/shared';
import { describe, expect, it } from 'vitest';
import {
  checkGrounding,
  countChapters,
  editRatioPercent,
  readingTimeSec,
  templateMarker,
  validateDraft,
} from './validation';
import type { ProjectFact } from '../projects/types';

/**
 * Le contrôle des brouillons se teste **sans réseau et sans base** : c'est du
 * code pur, et c'est ce qui permet d'exiger des longueurs.
 *
 * Ce que ces tests protègent, concrètement : un modèle ne compte pas les
 * caractères, donc si `validateDraft` se trompe, c'est un texte refusé par la
 * plateforme au moment de publier — le pire moment possible (docs/06 §4.1).
 */

const FACT: ProjectFact = {
  id: 'fait-1',
  projectId: 'projet-1',
  category: 'chiffre',
  statement: 'J’ai automatisé la relance des devis en trois semaines',
  detail: null,
  source: 'conversation',
  sourceMessageId: null,
  verificationStatus: 'verified',
  verificationNote: null,
  verifiedAt: null,
  verifiedByUser: true,
  importance: 5,
  usedCount: 0,
  lastUsedAt: null,
  supersedesFactId: null,
  supersededByFactId: null,
  supersededAt: null,
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
};

/** Un brouillon conforme pour la cible : chaque test ne casse qu'une chose. */
function draft(body: string, overrides: Partial<TargetDraft> = {}): TargetDraft {
  return {
    title: null,
    hook: body.split('\n')[0] ?? body.slice(0, 40),
    body,
    hashtags: [],
    mentions: [],
    notes: [],
    ...overrides,
  };
}

function codes(validation: ReturnType<typeof validateDraft>): string[] {
  return [...validation.blocking, ...validation.warnings].map((issue) => issue.code);
}

describe('validateDraft — longueurs et forme par plateforme', () => {
  it('accepte un post LinkedIn conforme, sans blocage', () => {
    const body = [
      'J’ai arrêté de relancer mes devis à la main, et ça a changé ma semaine.',
      '',
      'Trois semaines pour automatiser la relance, dix minutes par jour au début.',
      '',
      'Ce que j’en retiens : le plus dur n’était pas la technique, c’était de décider ce qui méritait une relance.',
    ].join('\n');

    const validation = validateDraft(
      'linkedin_post',
      draft(body, { hashtags: ['#automatisation', '#freelance', '#devis'] }),
    );

    expect(validation.ok).toBe(true);
    expect(validation.blocking).toEqual([]);
    expect(validation.stats.charCount).toBe(body.length);
    expect(validation.stats.hashtagCount).toBe(3);
  });

  it('bloque un corps qui dépasse la limite dure de la plateforme', () => {
    const spec = contentTargetSpec('linkedin_post');
    const body = 'a'.repeat(spec.bodyMaxChars + 10);

    const validation = validateDraft('linkedin_post', draft(body));

    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain('BODY_TOO_LONG');
    expect(validation.blocking[0]?.field).toBe('body');
  });

  it('avertit sans bloquer au-delà de la cible éditoriale', () => {
    const spec = contentTargetSpec('linkedin_post');
    // Juste sous la limite dure, très au-dessus du budget visé : le texte reste
    // publiable, donc c'est un avertissement — publier est une décision humaine.
    const body = `${'Un paragraphe dense '.repeat(Math.floor(spec.bodyMaxChars / 19))}`.slice(
      0,
      spec.bodyMaxChars - 1,
    );

    const validation = validateDraft('linkedin_post', draft(body));

    expect(validation.ok).toBe(true);
    expect(codes(validation)).toContain('BODY_OVER_TARGET');
  });

  it('bloque un marqueur de gabarit resté dans le texte', () => {
    const body = `${'Phrase de remplissage bien assez longue pour dépasser le minimum. '.repeat(2)}TODO : ajouter le chiffre exact.`;

    expect(templateMarker(body)).toBe('todo');
    const validation = validateDraft('linkedin_post', draft(body));

    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain('BODY_TEMPLATE_MARKER');
  });

  it('ne confond pas un texte propre avec un marqueur symbolique', () => {
    // Régression : « {{ » ne survit pas à la normalisation, il devenait la
    // chaîne vide et bloquait donc **tous** les brouillons.
    const clean = 'Un texte normal, avec {des accolades} et (des parenthèses) mais rien de bâclé.';
    expect(templateMarker(clean)).toBeNull();

    expect(templateMarker('Bonjour {{ville}}, voici le texte')).toBe('{{');
    expect(
      validateDraft('linkedin_post', draft(clean)).blocking.map((issue) => issue.code),
    ).not.toContain('BODY_TEMPLATE_MARKER');
  });

  it('exige un titre là où la plateforme en demande un', () => {
    const body =
      'Script court mais suffisamment long pour ne pas déclencher le contrôle de taille.';

    const validation = validateDraft('youtube_short', draft(body));

    expect(validation.ok).toBe(false);
    expect(codes(validation)).toContain('TITLE_MISSING');

    const withTitle = validateDraft(
      'youtube_short',
      draft(body, { title: 'Automatiser ses relances' }),
    );
    expect(codes(withTitle)).not.toContain('TITLE_MISSING');
  });

  it('exige un plan horodaté pour la vidéo longue', () => {
    const withoutChapters = validateDraft(
      'youtube_long',
      draft('Une accroche, puis du texte, mais aucun horodatage dans ce corps.', {
        title: 'Trois mois d’automatisation',
      }),
    );
    expect(withoutChapters.ok).toBe(false);
    expect(codes(withoutChapters)).toContain('CHAPTERS_MISSING');

    const body = [
      '00:00 Accroche',
      '02:10 Chapitre 1',
      '05:40 Chapitre 2',
      '08:15 Chapitre 3',
    ].join('\n');
    const withChapters = validateDraft(
      'youtube_long',
      draft(body, { title: 'Trois mois d’automatisation' }),
    );
    expect(codes(withChapters)).not.toContain('CHAPTERS_MISSING');
    expect(withChapters.stats.chapters).toBe(4);
  });

  it('compte les chapitres et le temps de lecture d’un script', () => {
    expect(countChapters('00:00 début\npas un chapitre\n1:30 suite')).toBe(2);
    // Un script parlé se lit moins vite qu'un texte : 150 mots/minute contre 200.
    expect(readingTimeSec('mot '.repeat(150), true)).toBe(60);
    expect(readingTimeSec('mot '.repeat(200), false)).toBe(60);
  });
});

describe('validateDraft — ancrage factuel et réécriture', () => {
  it('signale une citation qui n’existe dans aucun fait', () => {
    // L'ancrage vit dans `checkGrounding`, pas dans `validateDraft` : la
    // validation juge la forme, l'ancrage juge la véracité (docs/04 §4.3).
    const report = checkGrounding(['87 % des devis sont relancés trop tard'], [FACT]);

    expect(report.ungrounded).toEqual(['87 % des devis sont relancés trop tard']);
    expect(report.matchedFactIds).toEqual([]);
  });

  it('rapproche une citation d’un fait malgré la casse et les accents', () => {
    const report = checkGrounding(
      ['J’ai automatisé la relance des devis en trois semaines'],
      [FACT],
    );

    expect(report.ungrounded).toEqual([]);
    expect(report.matchedFactIds).toEqual([FACT.id]);
  });

  it('mesure la part de texte changée par une réécriture', () => {
    expect(editRatioPercent('un texte simple', 'un texte simple')).toBe(0);
    expect(editRatioPercent('un texte simple', 'autre chose ici')).toBe(100);
  });
});
