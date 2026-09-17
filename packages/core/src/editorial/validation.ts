import { contentTargetSpec, type ContentTarget, type TargetDraft } from '@aia/shared';
import type { ProjectFact } from '../projects/types';

/**
 * Vérification **locale** des brouillons : longueurs, forme, ancrage factuel.
 *
 * Pourquoi ici et pas dans un prompt : un modèle ne compte pas les caractères de
 * façon fiable, et « respecte la limite LinkedIn » n'est pas une instruction
 * vérifiable. Le contrôle est donc du code, déterministe, testable sans réseau —
 * et le résultat sert **deux fois** : il décide de régénérer une cible, et il est
 * montré à l'utilisateur (« 3 180 caractères, limite 3 000, régénération
 * demandée »).
 *
 * La distinction qui structure ce fichier (docs/04 §4.3) :
 *
 * - **bloquant** : la plateforme refuserait le contenu, ou le contenu est vide de
 *   sens (titre manquant là où il est obligatoire, chapitres absents d'une vidéo
 *   longue, marqueur de gabarit resté dans le texte). Une régénération ciblée est
 *   déclenchée ;
 * - **avertissement** : le contenu passera, mais il est moins bon que le budget
 *   éditorial visé. On le signale, on ne bloque pas, on ne paie pas un appel.
 */

export interface DraftIssue {
  code: string;
  severity: 'blocking' | 'warning';
  field: 'title' | 'hook' | 'body' | 'hashtags' | 'notes' | 'segments';
  message: string;
}

export interface DraftStats {
  charCount: number;
  wordCount: number;
  readingTimeSec: number;
  hashtagCount: number;
  chapters: number;
}

export interface DraftValidation {
  target: ContentTarget;
  ok: boolean;
  blocking: DraftIssue[];
  warnings: DraftIssue[];
  stats: DraftStats;
}

/** Débit de lecture : 200 mots/minute pour un texte lu, 150 pour un texte dit (docs/06). */
const TEXT_WORDS_PER_MINUTE = 200;
const SPOKEN_WORDS_PER_MINUTE = 150;

/** En dessous, un corps n'est pas un contenu publiable. */
const MIN_BODY_CHARS = 40;

/** Un chapitre de vidéo longue : « 00:42 », « 12:07 » (docs/06 §7.2). */
const CHAPTER_LINE = /^\s*\d{1,2}:\d{2}\b/gm;

/** Marqueurs de gabarit laissés dans le texte : le signe d'une sortie bâclée. */
const TEMPLATE_MARKERS = ['lorem ipsum', '[inserer', 'todo', 'a completer', '{{', '<insert'];

/** Attentes **non bloquantes** propres à une cible (docs/06 §5.2, §7.2). */
const NOTE_EXPECTATIONS: Partial<Record<ContentTarget, string>> = {
  reddit_post:
    'le subreddit et le flair restent à choisir par l’utilisateur : le brouillon doit le rappeler dans ses notes',
  youtube_long:
    'description, chapitres et miniature se renseignent à la main : le brouillon doit le rappeler dans ses notes',
};

export function countWords(body: string): number {
  return body.trim().split(/\s+/).filter(Boolean).length;
}

export function countChapters(body: string): number {
  return (body.match(CHAPTER_LINE) ?? []).length;
}

export function readingTimeSec(body: string, spoken: boolean): number {
  const words = countWords(body);
  const perMinute = spoken ? SPOKEN_WORDS_PER_MINUTE : TEXT_WORDS_PER_MINUTE;
  return Math.max(1, Math.round((words / perMinute) * 60));
}

/** Normalisation d'une citation avant comparaison : casse, accents, ponctuation. */
export function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Recouvrement de deux textes, en jetons de plus de deux lettres (0 à 1).
 *
 * Le seuil `EVIDENCE_MATCH_THRESHOLD` est volontairement indulgent : le modèle
 * reformule légèrement un fait, et refuser une reformulation fidèle serait une
 * fausse alerte coûteuse (elle ferait régénérer un plan correct). En dessous de
 * 0,5, il ne reste plus assez du fait d'origine pour parler d'ancrage.
 */
export function tokenOverlap(a: string, b: string): number {
  const left = new Set(
    normalizeForMatch(a)
      .split(' ')
      .filter((token) => token.length > 2),
  );
  const right = new Set(
    normalizeForMatch(b)
      .split(' ')
      .filter((token) => token.length > 2),
  );
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const token of left) {
    if (right.has(token)) common += 1;
  }
  return common / new Set([...left, ...right]).size;
}

export const EVIDENCE_MATCH_THRESHOLD = 0.5;

export interface GroundingReport {
  /** Citations qui ne reposent sur aucun fait : elles doivent faire échouer le plan. */
  ungrounded: string[];
  /** Identifiants des faits cités, dans l'ordre des citations. */
  matchedFactIds: string[];
}

/**
 * **L'ancrage factuel** (docs/04 §4.2, garde-fou « chaque sujet et chaque angle
 * cite au moins un fait du projet »).
 *
 * Le paquet de mémoire affiche les faits en texte : on demande donc au modèle des
 * **extraits**, jamais des identifiants — demander un identifiant ferait inventer
 * des identifiants. C'est ici que l'extrait est confronté aux faits réellement
 * fournis, ce qui rend la garde vérifiable au lieu d'être déclarative.
 */
export function checkGrounding(
  quotes: readonly string[],
  facts: readonly ProjectFact[],
): GroundingReport {
  const ungrounded: string[] = [];
  const matchedFactIds: string[] = [];

  for (const quote of quotes) {
    const fact = facts.find((candidate) => {
      const corpus = [candidate.statement, candidate.detail ?? ''];
      return corpus.some(
        (text) =>
          normalizeForMatch(text).includes(normalizeForMatch(quote)) ||
          tokenOverlap(quote, text) >= EVIDENCE_MATCH_THRESHOLD,
      );
    });
    if (!fact) {
      ungrounded.push(quote);
      continue;
    }
    if (!matchedFactIds.includes(fact.id)) matchedFactIds.push(fact.id);
  }

  return { ungrounded, matchedFactIds };
}

/** Marqueur de gabarit laissé dans un texte. */
export function templateMarker(body: string): string | null {
  const haystack = normalizeForMatch(body);
  return (
    TEMPLATE_MARKERS.find((marker) => {
      const needle = normalizeForMatch(marker);
      // Un marqueur purement symbolique (« {{ ») ne survit pas à la
      // normalisation : cherché normalisé, il vaudrait la chaîne vide et
      // matcherait **tous** les brouillons. On le cherche donc tel quel.
      return needle.length === 0 ? body.includes(marker) : haystack.includes(needle);
    }) ?? null
  );
}

/**
 * Vérifie un brouillon contre la spécification de sa cible.
 *
 * L'ordre des contrôles suit celui des dégâts : d'abord ce qui rend le contenu
 * inutilisable (vide, bâclé, hors limite), ensuite ce qui le rend moins bon.
 */
export function validateDraft(target: ContentTarget, draft: TargetDraft): DraftValidation {
  const spec = contentTargetSpec(target);
  const blocking: DraftIssue[] = [];
  const warnings: DraftIssue[] = [];

  const body = draft.body ?? '';
  const title = (draft.title ?? '').trim();
  const hook = (draft.hook ?? '').trim();
  const hashtags = draft.hashtags ?? [];
  const notes = draft.notes ?? [];
  const spoken = spec.format !== 'post_texte';

  const charCount = body.length;
  const chapters = countChapters(body);
  const stats: DraftStats = {
    charCount,
    wordCount: countWords(body),
    readingTimeSec: readingTimeSec(body, spoken),
    hashtagCount: hashtags.length,
    chapters,
  };

  // 1. Le contenu existe-t-il ?
  if (charCount < MIN_BODY_CHARS) {
    blocking.push({
      code: 'BODY_TOO_SHORT',
      severity: 'blocking',
      field: 'body',
      message: `Corps trop court (${charCount} caractères) : il n’y a pas de contenu à publier.`,
    });
  }
  const marker = templateMarker(body);
  if (marker) {
    blocking.push({
      code: 'BODY_TEMPLATE_MARKER',
      severity: 'blocking',
      field: 'body',
      message: `Marqueur de gabarit laissé dans le texte (« ${marker} ») : le texte n’est pas rédigé.`,
    });
  }

  // 2. Les limites dures de la plateforme (⚠️ docs/06, à revérifier).
  if (charCount > spec.bodyMaxChars) {
    blocking.push({
      code: 'BODY_TOO_LONG',
      severity: 'blocking',
      field: 'body',
      message: `${charCount} caractères pour une limite de ${spec.bodyMaxChars} sur ${spec.label}.`,
    });
  }
  if (spec.titleMaxChars !== null) {
    if (title.length === 0) {
      blocking.push({
        code: 'TITLE_MISSING',
        severity: 'blocking',
        field: 'title',
        message: `${spec.label} exige un titre (${spec.titleMaxChars} caractères au plus).`,
      });
    } else if (title.length > spec.titleMaxChars) {
      blocking.push({
        code: 'TITLE_TOO_LONG',
        severity: 'blocking',
        field: 'title',
        message: `Titre de ${title.length} caractères pour une limite de ${spec.titleMaxChars}.`,
      });
    }
  }
  if (hashtags.length > spec.hashtagsMax) {
    blocking.push({
      code: 'HASHTAGS_TOO_MANY',
      severity: 'blocking',
      field: 'hashtags',
      message: `${hashtags.length} hashtags pour un maximum de ${spec.hashtagsMax} sur ${spec.label}.`,
    });
  }

  // 3. La forme attendue de la cible.
  if (spec.segmentsRequired && chapters < 4) {
    blocking.push({
      code: 'CHAPTERS_MISSING',
      severity: 'blocking',
      field: 'segments',
      message: `Plan horodaté incomplet : ${chapters} chapitre(s) détecté(s), 4 au minimum (lignes « mm:ss »).`,
    });
  }

  // 4. Les budgets éditoriaux : avertissements, jamais blocages.
  if (charCount > spec.bodyTargetChars && charCount <= spec.bodyMaxChars) {
    warnings.push({
      code: 'BODY_OVER_TARGET',
      severity: 'warning',
      field: 'body',
      message: `${charCount} caractères pour un budget visé de ${spec.bodyTargetChars} : dense pour ${spec.label}.`,
    });
  }
  if (charCount < spec.bodyTargetChars / 2) {
    warnings.push({
      code: 'BODY_UNDER_TARGET',
      severity: 'warning',
      field: 'body',
      message: `${charCount} caractères pour un budget visé de ${spec.bodyTargetChars} : le sujet est peut-être traité trop vite.`,
    });
  }
  if (hook.length > spec.hookMaxChars) {
    warnings.push({
      code: 'HOOK_TOO_LONG',
      severity: 'warning',
      field: 'hook',
      message: `Accroche de ${hook.length} caractères : au-delà de ${spec.hookMaxChars}, partiellement masquée.`,
    });
  }
  if (
    hook.length > 0 &&
    body.length > 0 &&
    !normalizeForMatch(body).includes(normalizeForMatch(hook))
  ) {
    warnings.push({
      code: 'HOOK_NOT_IN_BODY',
      severity: 'warning',
      field: 'hook',
      message:
        'L’accroche n’apparaît pas telle quelle dans le corps : à recopier au moment de publier.',
    });
  }
  if (hashtags.length < spec.hashtagsMin) {
    warnings.push({
      code: 'HASHTAGS_MISSING',
      severity: 'warning',
      field: 'hashtags',
      message: `${hashtags.length} hashtag(s) pour un minimum de ${spec.hashtagsMin} sur ${spec.label}.`,
    });
  }
  if (chapters > 8) {
    warnings.push({
      code: 'CHAPTERS_TOO_MANY',
      severity: 'warning',
      field: 'segments',
      message: `${chapters} chapitres : au-delà de 8, la vidéo n’est plus lisible.`,
    });
  }
  const expectedNote = NOTE_EXPECTATIONS[target];
  if (expectedNote && notes.length === 0) {
    warnings.push({
      code: 'NOTES_MISSING',
      severity: 'warning',
      field: 'notes',
      message: `Note attendue : ${expectedNote}.`,
    });
  }

  return { target, ok: blocking.length === 0, blocking, warnings, stats };
}

/** Le message court qui accompagne une régénération ciblée. */
export function describeIssues(validation: DraftValidation): string {
  return validation.blocking.map((issue) => `${issue.field} — ${issue.message}`).join(' · ');
}

/**
 * Comparaison **avant / après** d'une édition humaine : le pourcentage du texte
 * qui a changé (`content_items.edit_ratio`, docs/03 §9.1).
 *
 * Pourquoi une mesure plutôt qu'un booléen : `humanEdited` dit seulement qu'une
 * main est passée ; `edit_ratio` dit **combien**. C'est le proxy d'utilité réelle
 * du produit — un ratio proche de 100 % signifie que le modèle n'a servi à rien
 * sur ce contenu, et c'est exactement le signal que l'étape 11 exploitera.
 *
 * La mesure est volontairement grossière (recouvrement de jetons, insensible à la
 * casse et aux accents) : elle doit être déterministe, testable sans réseau et
 * jamais dépendre d'un modèle.
 */
export function editRatioPercent(before: string, after: string): number {
  const beforeTokens = normalizeForMatch(before).split(' ').filter(Boolean);
  const afterTokens = normalizeForMatch(after).split(' ').filter(Boolean);
  if (beforeTokens.length === 0 && afterTokens.length === 0) return 0;
  if (beforeTokens.length === 0 || afterTokens.length === 0) return 100;

  const remaining = new Map<string, number>();
  for (const token of beforeTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1);

  let kept = 0;
  for (const token of afterTokens) {
    const left = remaining.get(token) ?? 0;
    if (left > 0) {
      remaining.set(token, left - 1);
      kept += 1;
    }
  }

  const similarity = (2 * kept) / (beforeTokens.length + afterTokens.length);
  return Math.max(0, Math.min(100, Math.round((1 - similarity) * 100)));
}
