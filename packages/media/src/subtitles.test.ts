import { describe, expect, it } from 'vitest';
import {
  assTime,
  buildSubtitleCues,
  DEFAULT_MAX_CHARS_PER_LINE,
  MIN_CUE_MS,
  renderAssSubtitles,
  SUBTITLE_FILE_NAME,
  wrapText,
} from './subtitles';

/**
 * Les sous-titres d’un short (docs/10 §4.7) : découpage des répliques depuis des
 * **segments** (jamais des mots), horodatage ASS, et neutralisation des balises.
 *
 * Ce que ces tests protègent, précisément :
 *
 * - un segment hors de l’extrait n’apparaît **jamais** dans le fichier ;
 * - les bornes écrites sont **relatives au début de l’extrait**, ce que FFmpeg
 *   attend quand il brûle les sous-titres d’un flux déjà découpé ;
 * - aucune réplique ne dure moins de `MIN_CUE_MS` : plus court, ça clignote ;
 * - aucune accolade ne parvient au fichier ASS (elles déplacent un sous-titre).
 */

describe('découpage du texte en lignes', () => {
  it('coupe aux espaces, sans dépasser la largeur demandée', () => {
    expect(wrapText('automatiser la facturation avec n8n', 20)).toEqual([
      'automatiser la',
      'facturation avec n8n',
    ]);
    expect(wrapText('   ', 20)).toEqual([]);
    expect(wrapText('motbeaucoupplustreslongquedix', 10)).toEqual([
      'motbeaucoupplustreslongquedix',
    ]);
  });

  it('normalise les espaces et **retire les accolades** (balises ASS)', () => {
    expect(wrapText('  {\\an8}Salut   tout   le monde  ', DEFAULT_MAX_CHARS_PER_LINE)).toEqual([
      '\\an8Salut tout le monde',
    ]);
  });
});

describe('répliques d’un extrait : bornes relatives au début de l’extrait', () => {
  const segments = [
    { startMs: 0, endMs: 3_000, text: 'Segment avant le début de l’extrait' },
    { startMs: 9_000, endMs: 15_000, text: 'Bonjour, voici le montage complet' },
    { startMs: 14_000, endMs: 26_000, text: 'de cette automatisation de facturation.' },
    { startMs: 30_000, endMs: 40_000, text: 'Segment après la fin de l’extrait' },
  ];

  it('ne retient que les segments qui recoupent la fenêtre', () => {
    const cues = buildSubtitleCues({ segments, clipStartMs: 10_000, clipEndMs: 25_000 });
    const text = cues.flatMap((cue) => cue.lines).join(' ');
    expect(text).not.toContain('avant le début');
    expect(text).not.toContain('après la fin');
    expect(text).toContain('Bonjour');
    expect(text).toContain('facturation');
  });

  it('ramène les bornes à zéro et coupe le segment à la fenêtre', () => {
    const cues = buildSubtitleCues({ segments, clipStartMs: 10_000, clipEndMs: 25_000 });
    // Le premier segment retenu commence avant l’extrait : sa réplique commence à 0.
    expect(cues[0]?.startMs).toBe(0);
    // La dernière réplique s’arrête au plus tard à la fin de l’extrait.
    const last = cues[cues.length - 1];
    expect(last?.endMs).toBeLessThanOrEqual(15_000);
    // Rien n’est négatif : un sous-titre avant l’extrait n’existe pas.
    expect(cues.every((cue) => cue.startMs >= 0)).toBe(true);
  });

  it('répartit la durée au prorata des caractères, sans réplique plus courte que le minimum', () => {
    const text = ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20)].join(' ');
    const cues = buildSubtitleCues({
      segments: [{ startMs: 0, endMs: 4_000, text }],
      clipStartMs: 0,
      clipEndMs: 4_000,
      maxCharsPerLine: 20,
    });
    // Trois lignes de 20 caractères, deux lignes par réplique : la première est
    // plus longue que la seconde, et sa durée doit le refléter.
    expect(cues).toHaveLength(2);
    expect(cues[0]?.endMs).toBeGreaterThan(2_000);
    expect(cues[0]?.endMs).toBeGreaterThanOrEqual(MIN_CUE_MS);
    expect(cues[1]?.endMs).toBe(4_000);
    // Les deux répliques se suivent sans trou : une seconde de silence noir au
    // milieu du segment serait un défaut visible.
    expect(cues[1]?.startMs).toBe(cues[0]?.endMs);
  });

  it('ignore un segment vide et n’invente rien quand rien ne recoupe', () => {
    expect(
      buildSubtitleCues({
        segments: [{ startMs: 0, endMs: 1_000, text: '   ' }],
        clipStartMs: 0,
        clipEndMs: 5_000,
      }),
    ).toEqual([]);
    expect(buildSubtitleCues({ segments, clipStartMs: 26_000, clipEndMs: 29_000 })).toEqual([]);
  });
});

describe('fichier ASS : reproductible, et sans balise venue du texte', () => {
  it('écrit PlayRes à la taille de sortie : la police est en pixels réels', () => {
    const ass = renderAssSubtitles([{ startMs: 0, endMs: 1_500, lines: ['Bonjour'] }], {
      width: 1080,
      height: 1920,
    });
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass.endsWith('\n')).toBe(true);
  });

  it('horodate en centièmes et joint deux lignes par \\N', () => {
    const ass = renderAssSubtitles(
      [{ startMs: 1_500, endMs: 4_250, lines: ['Première ligne', 'Deuxième ligne'] }],
      { width: 1080, height: 1920 },
    );
    expect(ass).toContain(
      'Dialogue: 0,0:00:01.50,0:00:04.25,Short,,0,0,0,,Première ligne\\NDeuxième ligne',
    );
  });

  it('ne laisse aucune accolade dans le fichier : un texte ne déplace pas un sous-titre', () => {
    const cues = buildSubtitleCues({
      segments: [{ startMs: 0, endMs: 2_000, text: '{\\an8}Salut {\\c&HFF0000&}tout le monde' }],
      clipStartMs: 0,
      clipEndMs: 2_000,
    });
    const ass = renderAssSubtitles(cues, { width: 1080, height: 1920 });
    const dialogues = ass.split('\n').filter((line) => line.startsWith('Dialogue:'));
    // Les accolades de la seule partie `Style:` sont légitimes : le texte, lui,
    // n’en contient plus aucune.
    expect(dialogues.join('')).not.toContain('{');
    expect(dialogues.join('')).not.toContain('}');
    expect(ass).toContain('Salut');
  });

  it('convertit les millisecondes en horodatage ASS, borné à zéro', () => {
    expect(assTime(0)).toBe('0:00:00.00');
    expect(assTime(3_723_456)).toBe('1:02:03.45');
    expect(assTime(-500)).toBe('0:00:00.00');
  });

  it('nomme toujours le fichier de la même façon : un nom relatif, jamais un chemin', () => {
    expect(SUBTITLE_FILE_NAME).toBe('subtitles.ass');
    expect(SUBTITLE_FILE_NAME).not.toContain('/');
  });
});
