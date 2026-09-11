import {
  ValidationError,
  type AudienceKnowledgeLevel,
  type PlatformId,
  type SentenceLength,
  type StyleScope,
  type StyleTone,
} from '@aia/shared';

/**
 * Profils d'audience et de style (docs/03 §6.3, §6.4 ; docs/05 §3.1).
 *
 * Ces deux tables sont remplies par l'entretien, aux phases `audience` et
 * `voice` :
 *
 * - **audience** : à qui l'utilisateur parle, et à quel niveau. Sans elle, un
 *   contenu est écrit « pour tout le monde », donc pour personne ;
 * - **style** : comment il parle réellement. Le style n'est **jamais** imité en
 *   recopiant un ancien post (docs/04 §5.4) : il est décrit ici, en clair.
 *
 * Choix d'étape, assumé et documenté : les profils sont créés par l'entretien,
 * donc validés par un acte humain comme un fait. Les colonnes non renseignées
 * prennent une valeur par défaut **explicite** plutôt qu'une valeur inventée.
 */

export interface AudienceProfile {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  painPoints: string[];
  goals: string[];
  objections: string[];
  knowledgeLevel: AudienceKnowledgeLevel;
  vocabulary: string[];
  platforms: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StyleProfile {
  id: string;
  projectId: string;
  name: string;
  scope: StyleScope;
  platform: string | null;
  tone: StyleTone | null;
  /** 1 (tu) → 5 (vouvoiement strict). */
  formality: number;
  sentenceLength: SentenceLength | null;
  humorLevel: number;
  emojiLevel: number;
  forbiddenWords: string[];
  signatureOpenings: string[];
  signatureClosings: string[];
  /** 3 à 5 exemples **réels** de l'utilisateur : jamais générés. */
  exampleParagraphs: string[];
  derivedFromTexts: number;
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

export const AUDIENCE_NAME_MAX_LENGTH = 120;
export const STYLE_NAME_MAX_LENGTH = 120;
export const PROFILE_ITEM_MAX_LENGTH = 200;
export const PROFILE_ITEMS_MAX = 20;

export interface AudienceProfileInput {
  name: string;
  description?: string | null;
  painPoints?: string[];
  goals?: string[];
  objections?: string[];
  knowledgeLevel?: AudienceKnowledgeLevel;
  vocabulary?: string[];
  platforms?: PlatformId[];
}

export interface StyleProfileInput {
  name: string;
  scope?: StyleScope;
  platform?: PlatformId | null;
  tone?: StyleTone | null;
  formality?: number;
  sentenceLength?: SentenceLength | null;
  humorLevel?: number;
  emojiLevel?: number;
  forbiddenWords?: string[];
  signatureOpenings?: string[];
  signatureClosings?: string[];
  confidence?: number;
}

function assertName(value: string, max: number, code: string): string {
  const name = value.trim();
  if (name.length === 0) {
    throw new ValidationError('Un profil doit être nommé', { code });
  }
  if (name.length > max) {
    throw new ValidationError(`Un nom de profil ne dépasse pas ${max} caractères`, {
      code: `${code}_TOO_LONG`,
      details: { length: name.length },
    });
  }
  return name;
}

function assertItems(items: string[] | undefined, label: string): string[] {
  if (!items) return [];
  const cleaned = items.map((item) => item.trim()).filter((item) => item.length > 0);
  if (cleaned.length > PROFILE_ITEMS_MAX) {
    throw new ValidationError(`Un profil accepte au plus ${PROFILE_ITEMS_MAX} ${label}`, {
      code: 'PROFILE_ITEMS_TOO_MANY',
      details: { label, count: cleaned.length },
    });
  }
  if (cleaned.some((item) => item.length > PROFILE_ITEM_MAX_LENGTH)) {
    throw new ValidationError(
      `Une entrée de ${label} dépasse ${PROFILE_ITEM_MAX_LENGTH} caractères`,
      { code: 'PROFILE_ITEM_TOO_LONG' },
    );
  }
  return cleaned;
}

function assertLevel(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} va de ${min} à ${max} (reçu : ${value})`, {
      code: 'PROFILE_LEVEL_OUT_OF_RANGE',
      details: { label, value },
    });
  }
  return value;
}

export function assertAudienceContent(input: AudienceProfileInput): string {
  return assertName(input.name, AUDIENCE_NAME_MAX_LENGTH, 'AUDIENCE_NAME_REQUIRED');
}

export function assertStyleContent(input: StyleProfileInput): string {
  return assertName(input.name, STYLE_NAME_MAX_LENGTH, 'STYLE_NAME_REQUIRED');
}

export function buildAudienceProfile(
  ports: { newId(): string; clock: { nowMs(): number } },
  projectId: string,
  input: AudienceProfileInput,
): AudienceProfile {
  const now = ports.clock.nowMs();
  return {
    id: ports.newId(),
    projectId,
    name: assertAudienceContent(input),
    description: input.description?.trim() ?? null,
    painPoints: assertItems(input.painPoints, 'points de douleur'),
    goals: assertItems(input.goals, 'objectifs'),
    objections: assertItems(input.objections, 'objections'),
    // Défaut explicite : on ne devine pas le niveau du public, on part du plus
    // prudent (débutant) et l'entretien corrige si l'utilisateur dit autre chose.
    knowledgeLevel: input.knowledgeLevel ?? 'debutant',
    vocabulary: assertItems(input.vocabulary, 'mots de vocabulaire'),
    platforms: (input.platforms ?? []).map(String),
    createdAt: now,
    updatedAt: now,
  };
}

export function buildStyleProfile(
  ports: { newId(): string; clock: { nowMs(): number } },
  projectId: string,
  input: StyleProfileInput,
): StyleProfile {
  const now = ports.clock.nowMs();
  return {
    id: ports.newId(),
    projectId,
    name: assertStyleContent(input),
    scope: input.scope ?? 'project',
    platform: input.platform ? String(input.platform) : null,
    tone: input.tone ?? null,
    formality: assertLevel(input.formality ?? 3, 1, 5, 'Le registre'),
    sentenceLength: input.sentenceLength ?? null,
    humorLevel: assertLevel(input.humorLevel ?? 2, 0, 5, 'L’humour'),
    emojiLevel: assertLevel(input.emojiLevel ?? 2, 0, 5, 'Les emojis'),
    forbiddenWords: assertItems(input.forbiddenWords, 'mots interdits'),
    signatureOpenings: assertItems(input.signatureOpenings, 'ouvertures'),
    signatureClosings: assertItems(input.signatureClosings, 'clôtures'),
    exampleParagraphs: [],
    derivedFromTexts: 0,
    confidence: assertLevel(input.confidence ?? 2, 1, 5, 'La confiance'),
    createdAt: now,
    updatedAt: now,
  };
}
