import type { ContentTarget, PlatformId } from '@aia/shared';

/**
 * Le contrat `PlatformConnector`, **au-delà de l'interface** (docs/06 §3).
 *
 * Trois choses y sont posées, et chacune corrige une erreur coûteuse :
 *
 * 1. **`level`** — une plateforme déclare son niveau de publication (`A`, `B` ou
 *    `C`). Le niveau n'est pas une propriété du produit mais **de la capacité
 *    réellement acquise** : un compte LinkedIn personnel avec `w_member_social`
 *    publie (A), une chaîne YouTube non auditée ne produit qu'une vidéo privée
 *    (B), et tout le reste reste atteignable en paquet local (C). C'est ce champ
 *    qui rend le repli automatique possible (docs/10 §4.8) ;
 * 2. **`verification`** — chaque capacité affirmée porte sa **source** et sa
 *    **date de vérification**. docs/06 §2 l'exige : « ce que la plateforme permet
 *    est une donnée, pas une croyance ». Une capacité recopiée de mémoire est
 *    indistinguable d'une invention ;
 * 3. **`verifyPublished()`** — la vérification distante, distincte de
 *    `publish()`. C'est elle qui empêche un doublon après une erreur ambiguë
 *    (docs/06 §3.3, §9.2), et elle doit pouvoir répondre « je ne sais pas »
 *    (`verifiable: false`) : prétendre vérifier serait pire que ne pas vérifier.
 */

/** Niveau de publication d'un compte (docs/05 §8.1). */
export type ConnectorLevel = 'A' | 'B' | 'C';

/** Ce qu'un connecteur **affirme**, avec la preuve : une source et une date. */
export interface VerifiedFact {
  capability: string;
  statement: string;
  sourceUrl: string;
  /** `'YYYY-MM-DD'` : la date à laquelle la documentation a été lue. */
  checkedAt: string;
}

export interface VerifiedTextLimit {
  field: 'body' | 'title' | 'description';
  value: number;
  unit: 'characters' | 'utf16_runes' | 'utf8_bytes';
  /** `true` : limite prudente, non confirmée par une documentation stable. */
  advisory: boolean;
  checkedAt: string;
  sourceUrl: string;
}

export interface ConnectorCapabilities {
  directPublish: boolean;
  draft: boolean;
  schedule: boolean;
  analytics: boolean;
  videoUpload: boolean;
  imageUpload: boolean;
  maxTextLength: { value: number; advisory: boolean; checkedAt: string | null };
  maxVideoDurationSec?: number;
  textLimits: readonly VerifiedTextLimit[];
  requiresReview: boolean;
  /** Niveau **réellement acquis** par cette implémentation. */
  level: ConnectorLevel;
  /** Vérification distante possible ? `false` → toute ambiguïté est une décision humaine. */
  verifyPublished: boolean;
  /** Les faits vérifiés qui fondent ces capacités (source + date). */
  verification: readonly VerifiedFact[];
}

/**
 * Le compte sur lequel on publie. Le contrat le porte parce qu'un connecteur
 * d'API en a besoin (l'URN LinkedIn, l'identifiant de chaîne YouTube) et qu'un
 * connecteur de niveau C l'ignore : c'est la même requête dans les deux cas, et
 * c'est ce qui permet au pipeline de ne pas changer de forme selon le niveau.
 *
 * Il est **optionnel** : un appel sans compte reste valide (niveau C, tests). Le
 * connecteur qui ne peut pas travailler sans lui le dit dans `validateContent()`
 * plutôt que d'échouer au milieu d'un envoi.
 */
export interface PublishAccountRef {
  platformAccountId: string;
  platform: PlatformId;
  /** Identifiant côté plateforme : `urn:li:person:…`, identifiant de chaîne… */
  remoteAccountId: string | null;
  label: string;
  /** Portées **réellement accordées** (docs/06 §10.3) — pas celles demandées. */
  scopes: string[];
}

export interface PublishRequest {
  contentItemId: string;
  contentVersionId: string;
  target: ContentTarget;
  platform: PlatformId;
  body: string;
  title: string | null;
  hook: string | null;
  description: string | null;
  hashtags: string[];
  mentions: string[];
  /** Généré **en local** ; transmis quand la plateforme l'accepte, journalisé toujours. */
  idempotencyKey: string;
  scheduledAt?: Date;
  account?: PublishAccountRef;
  assets: Array<{ path: string; kind: string }>;
}

export interface ValidationReport {
  ok: boolean;
  issues: Array<{
    field: 'title' | 'body' | 'description' | 'hashtags' | 'media' | 'cta' | 'other';
    severity: 'blocking' | 'warning';
    /** Message écrit pour l'utilisateur, en français, avec les chiffres (docs/06 §3.2). */
    message: string;
    limit?: number;
    actual?: number;
  }>;
  warnings: string[];
}

export interface ManualPackage {
  platform: PlatformId;
  contentVersionId: string;
  body: string;
  title: string | null;
  hook: string | null;
  description: string | null;
  hashtags: string[];
  mentions: string[];
  instructions: string;
  checklist: string[];
  assets: Array<{ path: string; kind: string }>;
  expectedMedia: string | null;
  deepLink: string | null;
}

/**
 * Les issues possibles d'un appel de publication. Trois d'entre elles ne
 * figuraient pas dans la fiche docs/02 §9.2 (`rate_limited`, `auth_error`,
 * `server_error`) et sont pourtant nommées par la table d'erreurs de
 * docs/06 §9.1 : les laisser implicites obligerait le handler à deviner à partir
 * d'un message. Les nommer ici est ce qui rend la réaction **décidable** plutôt
 * qu'interprétée.
 */
export const PUBLISH_OUTCOMES = [
  'published',
  'draft_created',
  'scheduled',
  'rejected',
  'rate_limited',
  'auth_error',
  'server_error',
  'ambiguous',
  'manual_required',
] as const;
export type PublishOutcome = (typeof PUBLISH_OUTCOMES)[number];

/** Ce qui a réellement été envoyé et reçu, **sans aucun jeton** (docs/07 §9.1). */
export interface PublishDiagnostics {
  httpStatus: number | null;
  /** Identifiant de corrélation local : présent dans les journaux et la table des tentatives. */
  requestId: string;
  /** Résumé de la requête : jamais l'en-tête d'autorisation, jamais de jeton. */
  requestSummary: Record<string, unknown>;
  responseBody: unknown;
}

export interface PublishResult {
  outcome: PublishOutcome;
  remoteId?: string;
  remoteUrl?: string;
  /** Statut brut de la plateforme (`PUBLISHED`, `private`, `public`…). */
  remoteStatus?: string;
  /** Message à afficher, si l'issue doit être expliquée en une phrase. */
  message?: string;
  /** Reprise **au plus tôt** (429) : alimente directement `rate_limit_reset_at`. */
  retryAfterMs?: number;
  diagnostics?: PublishDiagnostics;
}

/**
 * Le résultat d'une vérification distante. `verifiable: false` est une réponse de
 * première classe : c'est le cas LinkedIn côté membre, où la lecture des posts
 * exige une portée réservée aux applications approuvées (docs/06 §9.2).
 */
export interface VerificationResult {
  /** Le connecteur a-t-il pu poser la question ? */
  verifiable: boolean;
  /** Le contenu est-il **retrouvé** côté plateforme ? */
  found: boolean;
  remoteId?: string;
  remoteUrl?: string;
  /** Ce qui a été cherché, et pourquoi le résultat est ce qu'il est. */
  reason: string;
  diagnostics?: PublishDiagnostics;
}

export interface PlatformConnector {
  readonly platform: PlatformId;
  capabilities(): ConnectorCapabilities;
  authenticate(accountId: string): Promise<void>;
  validateContent(req: PublishRequest): Promise<ValidationReport>;
  createDraft(req: PublishRequest): Promise<PublishResult>;
  publish(req: PublishRequest): Promise<PublishResult>;
  schedule(req: PublishRequest, at: Date): Promise<PublishResult>;
  /**
   * **La seule chose qui empêche un doublon** après une erreur ambiguë : on
   * demande à la plateforme si le contenu est déjà là, avant de conclure quoi
   * que ce soit (docs/06 §3.3).
   */
  verifyPublished(req: PublishRequest): Promise<VerificationResult>;
  fetchMetrics(remoteId: string, since: Date): Promise<Array<Record<string, unknown>>>;
  buildManualPackage(req: PublishRequest): Promise<ManualPackage>;
}

/**
 * Le niveau de publication **effectif** d'un compte, déduit de ses capacités
 * enregistrées au moment de la connexion (`platform_accounts.capabilities_json`)
 * — et jamais d'une table écrite en dur par plateforme.
 *
 * C'est l'application directe de l'interdit de docs/10 §4.8 : « pas de niveau A
 * pour une plateforme non acquise ». Si le compte ne peut pas publier
 * directement, on ne publie pas directement ; si la clé d'écriture manque, on
 * reste en C. Le repli n'est donc pas un `catch` — c'est une décision prise
 * **avant** l'appel.
 */
export function resolvePublishMode(capabilities: {
  level?: string;
  directPublish?: boolean;
  draft?: boolean;
}): ConnectorLevel {
  if (capabilities.level === 'A' || capabilities.level === 'B' || capabilities.level === 'C') {
    // Le niveau déclaré est plafonné par les capacités réelles : une déclaration
    // « A » avec `directPublish: false` retombe en B, puis en C.
    if (capabilities.level === 'A' && capabilities.directPublish === false) {
      return capabilities.draft === true ? 'B' : 'C';
    }
    if (capabilities.level === 'B' && capabilities.draft === false) return 'C';
    return capabilities.level;
  }
  if (capabilities.directPublish === true) return 'A';
  if (capabilities.draft === true) return 'B';
  return 'C';
}

export const PUBLISH_LEVEL_LABELS: Record<ConnectorLevel, string> = {
  A: 'A — publication par API officielle',
  B: 'B — brouillon distant, publication finale manuelle',
  C: 'C — paquet local à coller',
};
