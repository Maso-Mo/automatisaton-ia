import { CONTENT_TARGETS, type ContentFormat, type ContentTarget, type PlatformId } from './enums';

/**
 * Spécifications des **cibles de génération** (docs/06 §4 à §8, docs/03 §9.1).
 *
 * Une cible est un couple (plateforme, format) : « YouTube Shorts » et « YouTube
 * long » sont la même plateforme et deux pipelines différents (docs/06 §7.2).
 * C'est cette table — et rien d'autre — qui décide :
 *
 * 1. de la **forme** attendue d'un brouillon (lue par le prompt de la
 *    plateforme et affichée dans l'écran de validation) ;
 * 2. des **limites de longueur** vérifiées en code après génération : un
 *    dépassement déclenche une régénération ciblée de la seule plateforme
 *    concernée (docs/04 §4.3) ;
 * 3. du **nom du prompt** de la plateforme (`prompts/platform_writer/*.md`).
 *
 * ⚠️ **Les nombres sont à revérifier** avant la mise en service et à chaque
 * changement de règle de plateforme : docs/06 l'annonce en tête de chaque
 * chapitre (« tout ce chapitre doit être revérifié ») et docs/10 §4.4 en fait un
 * point de vigilance. `bodyMaxChars` est la limite **dure** de la plateforme :
 * la dépasser bloque le contenu. `bodyTargetChars` et `hookMaxChars` sont des
 * **budgets éditoriaux** : les dépasser produit un avertissement, jamais un
 * blocage — c'est la différence entre « la plateforme refuse » et « ce texte
 * sera moins bon ».
 */
export interface ContentTargetSpec {
  /** Clé de la cible : clé de sortie du `platform_writer`, et `content_items.format` avec `platform`. */
  readonly key: ContentTarget;
  /** Libellé humain, affiché tel quel dans l'interface. */
  readonly label: string;
  readonly platform: PlatformId;
  readonly format: ContentFormat;
  /** Limite **dure** du corps (caractères). Un dépassement bloque (docs/06 §4.1). */
  readonly bodyMaxChars: number;
  /** Budget éditorial visé : au-delà, avertissement seulement. */
  readonly bodyTargetChars: number;
  /** Limite de titre (Shorts, vidéo longue, Reddit). `null` : pas de titre. */
  readonly titleMaxChars: number | null;
  /** Longueur maximale de l'accroche : au-delà, elle est coupée par la plateforme. */
  readonly hookMaxChars: number;
  readonly hashtagsMin: number;
  readonly hashtagsMax: number;
  /** Un plan horodaté est exigé (vidéo longue) : un corps sans chapitre est incomplet. */
  readonly segmentsRequired: boolean;
  /** Ce que le brouillon doit être, en une phrase — lue par le prompt et par l'interface. */
  readonly shape: string;
  /** Fichier de prompt de la plateforme, relatif à `prompts/`. */
  readonly promptFile: string;
}

export const CONTENT_TARGET_SPECS: Record<ContentTarget, ContentTargetSpec> = {
  linkedin_post: {
    key: 'linkedin_post',
    label: 'Post LinkedIn',
    platform: 'linkedin',
    format: 'post_texte',
    // ⚠️ docs/06 §4.1 : « de l'ordre de 3 000 caractères », à revérifier.
    bodyMaxChars: 3_000,
    bodyTargetChars: 1_800,
    titleMaxChars: null,
    hookMaxChars: 210,
    hashtagsMin: 3,
    hashtagsMax: 5,
    segmentsRequired: false,
    shape:
      'Post texte : une accroche qui tient seule avant « voir plus », un corps aéré, 3 à 5 hashtags en fin — jamais en début — et un CTA non commercial (docs/06 §4.1).',
    promptFile: 'platform_writer/linkedin.md',
  },
  reddit_post: {
    key: 'reddit_post',
    label: 'Post Reddit',
    platform: 'reddit',
    format: 'post_texte',
    // ⚠️ La limite d'un self-post est très large : ce qui bloque un post Reddit
    // est la règle du subreddit, pas la taille (docs/06 §5.1).
    bodyMaxChars: 40_000,
    bodyTargetChars: 3_000,
    titleMaxChars: 300,
    hookMaxChars: 300,
    hashtagsMin: 0,
    hashtagsMax: 0,
    segmentsRequired: false,
    shape:
      'Titre non promotionnel (question ou affirmation factuelle) et corps utile, transparent sur le fait que l’auteur travaille sur le sujet. Le subreddit et le flair restent à choisir par l’utilisateur (docs/06 §5.2).',
    promptFile: 'platform_writer/reddit.md',
  },
  tiktok_short: {
    key: 'tiktok_short',
    label: 'Script TikTok',
    platform: 'tiktok',
    format: 'video_courte',
    // ⚠️ La limite de légende TikTok est de l'ordre de 2 200 caractères ; le corps
    // est ici le **script à dire**, la légende se dérive du hook (docs/06 §6.2).
    bodyMaxChars: 2_200,
    bodyTargetChars: 900,
    titleMaxChars: null,
    hookMaxChars: 100,
    hashtagsMin: 3,
    hashtagsMax: 5,
    segmentsRequired: false,
    shape:
      'Script vertical de 30 à 60 secondes : les 3 premières secondes accrochent, 4 à 6 plans numérotés disent quoi montrer et quoi dire, la voix reste celle de l’utilisateur (docs/06 §6.1).',
    promptFile: 'platform_writer/tiktok.md',
  },
  youtube_short: {
    key: 'youtube_short',
    label: 'Short YouTube',
    platform: 'youtube',
    format: 'video_courte',
    bodyMaxChars: 1_800,
    bodyTargetChars: 900,
    titleMaxChars: 100,
    hookMaxChars: 120,
    hashtagsMin: 2,
    hashtagsMax: 5,
    segmentsRequired: false,
    shape:
      'Script de 45 à 60 secondes, titre de 100 caractères au plus, une promesse tenue dans la vidéo et une accroche qui donne la raison de rester (docs/06 §7.2).',
    promptFile: 'platform_writer/youtube_short.md',
  },
  youtube_long: {
    key: 'youtube_long',
    label: 'Vidéo longue YouTube',
    platform: 'youtube',
    format: 'video_longue',
    bodyMaxChars: 8_000,
    bodyTargetChars: 5_000,
    titleMaxChars: 100,
    hookMaxChars: 300,
    hashtagsMin: 3,
    hashtagsMax: 8,
    segmentsRequired: true,
    shape:
      'Plan horodaté d’une vidéo longue : titre de 100 caractères au plus, accroche des 30 premières secondes, puis 4 à 8 chapitres dont la première ligne commence par mm:ss (docs/06 §7.2).',
    promptFile: 'platform_writer/youtube_long.md',
  },
};

/** Cibles dans l'ordre de génération (LinkedIn → Reddit → TikTok → Shorts → long). */
export const CONTENT_TARGET_KEYS: readonly ContentTarget[] = CONTENT_TARGETS;

/** Toutes les cibles de ce lot : le projet n'a pas encore de `project_platforms` (étape 5). */
export function allContentTargets(): ContentTarget[] {
  return [...CONTENT_TARGETS];
}

export function contentTargetSpec(target: ContentTarget): ContentTargetSpec {
  return CONTENT_TARGET_SPECS[target];
}

export function isContentTargetKey(value: string): value is ContentTarget {
  return (CONTENT_TARGETS as readonly string[]).includes(value);
}

/** Ordre stable : les cibles sont toujours traitées dans le même ordre, tests compris. */
export function sortContentTargets(targets: readonly ContentTarget[]): ContentTarget[] {
  const requested = new Set(targets);
  return CONTENT_TARGETS.filter((target) => requested.has(target));
}

/**
 * L'**inverse** de `contentTargetSpec` : la cible d'un couple (plateforme,
 * format). En base, un contenu stocke `platform` + `format` — pas la cible — et
 * c'est pourtant la cible qu'il faut au domaine pour valider un texte, choisir
 * son prompt et calculer son empreinte.
 *
 * Le retour `null` est délibéré : une ligne inconnue ne doit pas être devinée
 * (« youtube + post_texte » n'existe pas), elle doit être ignorée en le disant.
 */
export function contentTargetForPlatformFormat(
  platform: string,
  format: string,
): ContentTarget | null {
  return (
    CONTENT_TARGETS.find((target) => {
      const spec = CONTENT_TARGET_SPECS[target];
      return spec.platform === platform && spec.format === format;
    }) ?? null
  );
}
