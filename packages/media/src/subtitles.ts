/**
 * Sous-titres d'un short vertical — **le seul endroit** où un texte horodaté
 * devient un fichier de sous-titres (docs/10 §4.7, docs/05 §6.4).
 *
 * Trois décisions, toutes prises pour la même raison : ne jamais inventer une
 * précision qui n'existe pas.
 *
 * 1. **La granularité est celle de la transcription.** Nos transcripts portent des
 *    timestamps de **segment** (`has_word_timestamps = false`, docs/03 §10.2). On
 *    ne fabrique donc pas d'horodatage mot à mot : quand un segment est découpé
 *    en plusieurs répliques (parce qu'il est trop long à lire), le temps est
 *    réparti **au prorata du nombre de caractères**. C'est approximatif, c'est
 *    dit dans l'interface, et c'est reproductible.
 * 2. **Le format est ASS, écrit par nous.** Le SRT converti par FFmpeg laisse la
 *    taille de police dépendre des réglages internes de `libass` ; un ASS dont
 *    `PlayResX/PlayResY` valent la taille de sortie donne une taille de police en
 *    **pixels réels** — donc un rendu reproductible d'une machine à l'autre.
 * 3. **Aucun chemin utilisateur n'entre dans un filtre FFmpeg.** Le fichier de
 *    sous-titres s'appelle toujours `subtitles.ass`, il est écrit dans le
 *    répertoire de travail temporaire du rendu, et c'est ce **nom relatif** qui
 *    est passé au filtre `subtitles=`.
 */

export interface SubtitleCue {
  /** Bornes **relatives au début de l'extrait**, en millisecondes. */
  startMs: number;
  endMs: number;
  /** Les lignes à afficher (une ou deux) : le retour à la ligne est décidé ici. */
  lines: string[];
}

export interface SubtitleInput {
  segments: readonly { startMs: number; endMs: number; text: string }[];
  /** Fenêtre de l'extrait, dans le temps de la vidéo source. */
  clipStartMs: number;
  clipEndMs: number;
  /** Caractères par ligne : au-delà, le texte est coupé aux espaces. */
  maxCharsPerLine?: number;
  /** Lignes par réplique : deux au maximum, comme un short. */
  maxLinesPerCue?: number;
}

export const DEFAULT_MAX_CHARS_PER_LINE = 38;
export const DEFAULT_MAX_LINES_PER_CUE = 2;
/** Réplique minimale : un affichage plus court que ça clignote au lieu de se lire. */
export const MIN_CUE_MS = 400;

/**
 * Neutralise ce que `libass` interprète comme une balise : les accolades
 * délimitent les blocs de style (`{\an8}`, `{\c&HFF0000&}`…). Une transcription
 * qui en contient — parce que quelqu’un l’a dit, ou l’a écrit dans la correction
 * — ne doit pas pouvoir déplacer ni repeindre un sous-titre. Les accolades sont
 * donc **retirées**, jamais interprétées.
 */
function normalizeText(value: string): string {
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

/** Découpe un texte en lignes de `maxChars` au maximum, aux espaces. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current.length > 0) lines.push(current);
    current = word;
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Regroupe des lignes en répliques d'au plus `maxLines` lignes. */
function groupLines(lines: readonly string[], maxLines: number): string[][] {
  const groups: string[][] = [];
  for (let index = 0; index < lines.length; index += maxLines) {
    groups.push([...lines.slice(index, index + maxLines)]);
  }
  return groups;
}

/**
 * Construit les répliques d'un extrait.
 *
 * Règles, dans l'ordre — et elles suffisent à reconstruire un sous-titre à partir
 * de son entrée :
 *
 * 1. seuls les segments qui **recoupent** la fenêtre sont retenus ;
 * 2. leurs bornes sont ramenées au début de l'extrait et **coupées** à la
 *    fenêtre : un segment à cheval ne déborde pas dans le plan suivant ;
 * 3. le texte est replié en lignes de `maxCharsPerLine`, puis groupé par
 *    `maxLinesPerCue` ; le temps du segment est réparti entre les groupes **au
 *    prorata de leur longueur en caractères** — la seule répartition qui ne mente
 *    pas sur ce qu'on sait ;
 * 4. chaque réplique dure au moins `MIN_CUE_MS`, sans jamais sortir du segment.
 */
export function buildSubtitleCues(input: SubtitleInput): SubtitleCue[] {
  const maxCharsPerLine = input.maxCharsPerLine ?? DEFAULT_MAX_CHARS_PER_LINE;
  const maxLinesPerCue = input.maxLinesPerCue ?? DEFAULT_MAX_LINES_PER_CUE;
  const cues: SubtitleCue[] = [];

  for (const segment of input.segments) {
    const startMs = Math.max(segment.startMs, input.clipStartMs);
    const endMs = Math.min(segment.endMs, input.clipEndMs);
    if (endMs <= startMs) continue;

    const text = normalizeText(segment.text);
    if (text.length === 0) continue;

    const groups = groupLines(wrapText(text, maxCharsPerLine), maxLinesPerCue);
    const totalChars = groups.reduce(
      (sum, lines) => sum + lines.join(' ').length + (lines.length - 1),
      0,
    );
    const segmentDuration = endMs - startMs;
    let cursor = startMs;

    groups.forEach((lines, index) => {
      const chars = lines.join(' ').length + (lines.length - 1);
      const isLast = index === groups.length - 1;
      const proportional =
        totalChars === 0 ? segmentDuration / groups.length : (chars / totalChars) * segmentDuration;
      const groupEnd = isLast ? endMs : Math.min(endMs, cursor + Math.round(proportional));
      const groupStart = Math.round(cursor);
      const finalEnd = Math.max(groupEnd, Math.min(endMs, groupStart + MIN_CUE_MS));

      cues.push({
        startMs: groupStart - input.clipStartMs,
        endMs: finalEnd - input.clipStartMs,
        lines,
      });
      cursor = groupEnd;
    });
  }

  return cues;
}

/** Horodatage ASS : `H:MM:SS.cc` (centièmes), pas des millisecondes. */
export function assTime(milliseconds: number): string {
  const clamped = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1_000);
  const centis = Math.floor((clamped % 1_000) / 10);
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
    centis,
  ).padStart(2, '0')}`;
}

export interface AssSubtitleOptions {
  width: number;
  height: number;
  /** Taille de police **en pixels de sortie** (PlayRes = taille de la vidéo). */
  fontSize?: number;
  /** Marge basse en pixels : au-dessus de l'interface des plateformes. */
  marginBottom?: number;
  fontName?: string;
}

/**
 * Rend les répliques en ASS. Le fichier est écrit **par le worker**, jamais par
 * l'utilisateur, et son nom est toujours relatif (`subtitles.ass`) : c'est ce qui
 * rend impossible l'injection d'un chemin dans le filtre FFmpeg.
 */
export function renderAssSubtitles(
  cues: readonly SubtitleCue[],
  options: AssSubtitleOptions,
): string {
  const fontSize = options.fontSize ?? 58;
  const marginBottom = options.marginBottom ?? 170;
  const fontName = options.fontName ?? 'DejaVu Sans';

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${options.width}`,
    `PlayResY: ${options.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // 1 = boîte de contour, 3 px : lisible sur fond clair comme sur fond sombre.
    `Style: Short,${fontName},${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,${marginBottom},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events = cues.map(
    (cue) =>
      `Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Short,,0,0,0,,${cue.lines.join(
        '\\N',
      )}`,
  );

  return `${[...header, ...events].join('\n')}\n`;
}

/** Nom du fichier de sous-titres **dans le répertoire de travail** du rendu. */
export const SUBTITLE_FILE_NAME = 'subtitles.ass';
