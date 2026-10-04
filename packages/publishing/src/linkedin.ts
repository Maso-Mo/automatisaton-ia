import { CapabilityError, MissingCredentialError, contentTargetSpec } from '@aia/shared';
import type {
  ConnectorCapabilities,
  PlatformConnector,
  PublishAccountRef,
  PublishRequest,
  PublishResult,
  VerificationResult,
  VerifiedFact,
} from './capabilities';
import type { AccountCredentials } from './credentials';
import { createHttpClient, type HttpClient, type HttpOutcome } from './http-client';
import { manualConnectors } from './manual';

/**
 * Le connecteur **LinkedIn**, niveau A avec repli B (docs/06 §4).
 *
 * Tout ce qui est affirmé ici a été vérifié dans la documentation officielle le
 * 2 octobre 2026, et chaque affirmation porte sa source (`verification`). Trois
 * constats de cette lecture changent la conception, et aucun n'était devinable :
 *
 * 1. **`POST /rest/posts` rend `201` avec l'identifiant dans l'en-tête
 *    `x-restli-id`** — pas dans le corps. Un connecteur qui ne lirait que le corps
 *    conclurait « 2xx sans identifiant exploitable », donc `ambiguous`, sur une
 *    publication parfaitement réussie ;
 * 2. **`Linkedin-Version` (format `AAAAMM`) est obligatoire sur tous les appels**,
 *    et la version `202510` est annoncée **dépréciée au 15 octobre 2026**. Le
 *    connecteur refuse donc de publier sans version explicitement configurée :
 *    écrire une version en dur serait périmé à une date connue ;
 * 3. **`lifecycleState: 'DRAFT'` existe** : le niveau B (brouillon distant) est
 *    réellement atteignable, et `r_member_social` — la portée qui permettrait de
 *    relire ses propres posts — est **réservée aux applications approuvées**. La
 *    vérification après échec est donc **impossible** en V1 pour un compte
 *    personnel : une ambiguïté y est une décision humaine (docs/05 §8.3).
 *
 * Ce qui n'est **pas** dans ce connecteur, et pourquoi : le téléversement de
 * médias passe par `initializeUpload`, que cette lecture n'a pas documenté. Un
 * contenu avec média est donc refusé **avant l'envoi**, avec une phrase
 * explicite, plutôt que publié en texte seul — invisiblement amputé.
 */

const POSTS_ENDPOINT = 'https://api.linkedin.com/rest/posts';
const POSTS_API_DOC =
  'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api';
const OAUTH_DOC =
  'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow';
const CHECKED_AT = '2026-10-02';

/** Portée d'écriture pour publier **au nom d'un membre** (docs/06 §4.3). */
export const LINKEDIN_MEMBER_WRITE_SCOPE = 'w_member_social';
/** Portée de lecture des posts d'un membre : **réservée aux applications approuvées**. */
export const LINKEDIN_MEMBER_READ_SCOPE = 'r_member_social';
/** Portée d'écriture pour publier au nom d'une organisation. */
export const LINKEDIN_ORG_WRITE_SCOPE = 'w_organization_social';

const LINKEDIN_VERIFICATION: readonly VerifiedFact[] = [
  {
    capability: 'publication de texte',
    statement:
      'POST https://api.linkedin.com/rest/posts crée un post organique. La réponse est un 201 dont l’en-tête x-restli-id porte l’URN du post (urn:li:share:…).',
    sourceUrl: POSTS_API_DOC,
    checkedAt: CHECKED_AT,
  },
  {
    capability: 'en-têtes obligatoires',
    statement:
      'Tous les appels exigent « Linkedin-Version: AAAA MM » et « X-Restli-Protocol-Version: 2.0.0 ».',
    sourceUrl: POSTS_API_DOC,
    checkedAt: CHECKED_AT,
  },
  {
    capability: 'brouillon distant',
    statement:
      'Le champ lifecycleState accepte DRAFT en plus de PUBLISHED : le niveau B (brouillon distant) est donc réalisable.',
    sourceUrl: POSTS_API_DOC,
    checkedAt: CHECKED_AT,
  },
  {
    capability: 'portées OAuth',
    statement:
      'w_member_social permet de publier au nom d’un membre ; r_member_social (lecture de ses propres posts) est réservé aux applications approuvées — la vérification distante est donc impossible en V1 pour un compte personnel.',
    sourceUrl: POSTS_API_DOC,
    checkedAt: CHECKED_AT,
  },
  {
    capability: 'clé d’idempotence',
    statement:
      'Aucune clé d’idempotence n’est documentée : la clé locale n’est pas transmise, elle sert à la vérification et au journal (docs/03 §11.2). LinkedIn documente un 409 CONFLICT à réessayer.',
    sourceUrl: POSTS_API_DOC,
    checkedAt: CHECKED_AT,
  },
  {
    capability: 'version d’API',
    statement:
      'La version 202510 est annoncée dépréciée au 15 octobre 2026 : le connecteur exige donc une version configurée plutôt que d’en figer une.',
    sourceUrl: POSTS_API_DOC,
    checkedAt: CHECKED_AT,
  },
  {
    capability: 'erreurs structurées',
    statement:
      '400 (MISSING_FIELD, INVALID_VALUE_FOR_FIELD, FIELD_LENGTH_TOO_LONG), 401 EMPTY_ACCESS_TOKEN, 403 ACCESS_DENIED, 404 NOT_FOUND, 409 CONFLICT, 422, 429 TOO_MANY_REQUESTS, 500, 503.',
    sourceUrl: POSTS_API_DOC,
    checkedAt: CHECKED_AT,
  },
  {
    capability: 'cycle de vie du jeton',
    statement:
      'Parcours OAuth 2.0 à code d’autorisation ; l’échange se fait sur /oauth/v2/accessToken et l’erreur invalid_redirect_uri mentionne un code_verifier, donc PKCE est accepté.',
    sourceUrl: OAUTH_DOC,
    checkedAt: CHECKED_AT,
  },
];

export const LINKEDIN_CAPABILITIES: ConnectorCapabilities = {
  directPublish: true,
  draft: true,
  // La programmation côté plateforme n'est pas documentée pour les posts
  // organiques d'un membre : le produit planifie **en local** et déclenche
  // (docs/06 §12 refuse « la publication programmée côté plateforme comme
  // mécanisme principal »).
  schedule: false,
  // `r_member_social` est réservée aux applications approuvées : sans elle, il
  // n'y a pas d'analytics exploitables côté membre (docs/06 §2).
  analytics: false,
  videoUpload: false,
  imageUpload: false,
  maxTextLength: { value: 3_000, advisory: true, checkedAt: CHECKED_AT },
  textLimits: [
    {
      field: 'body',
      value: 3_000,
      unit: 'characters',
      advisory: true,
      checkedAt: CHECKED_AT,
      sourceUrl: POSTS_API_DOC,
    },
  ],
  requiresReview: false,
  level: 'A',
  verifyPublished: false,
  verification: LINKEDIN_VERIFICATION,
};

export interface LinkedInConnectorOptions {
  /**
   * Version d'API `AAAAMM`. Sa provenance est `LINKEDIN_API_VERSION` : elle est
   * **exigée à l'exécution**, jamais devinée (voir la note de dépréciation).
   */
  apiVersion?: string | null;
  /** Rend un jeton **déjà déchiffré**, pour ce compte, à l'instant de l'appel. */
  credentialsFor: (account: PublishAccountRef) => Promise<AccountCredentials>;
  /** Client HTTP injectable : les tests n'ouvrent aucun socket. */
  http?: HttpClient;
  now?: () => number;
}

/** L'URN d'auteur : celui du compte, ou celui d'une page d'organisation. */
export function linkedInAuthorUrn(remoteAccountId: string | null): string | null {
  if (!remoteAccountId) return null;
  if (remoteAccountId.startsWith('urn:li:')) return remoteAccountId;
  if (/^\d+$/.test(remoteAccountId)) return `urn:li:person:${remoteAccountId}`;
  return null;
}

/** Le commentaire publié : accroche, corps, hashtags — dans cet ordre, jamais autrement. */
export function linkedInCommentary(req: PublishRequest): string {
  const parts = [req.body.trim()];
  if (req.hashtags.length > 0) parts.push(req.hashtags.join(' '));
  return parts.filter((part) => part.length > 0).join('\n\n');
}

/**
 * Traduction de la réponse HTTP en issue métier (docs/06 §9.1). C'est une
 * fonction **pure** : elle reçoit l'issue du client HTTP et rend un
 * `PublishResult`. C'est ce qui rend la table d'erreurs testable ligne par ligne,
 * sans publier.
 */
export function interpretLinkedInResponse(
  outcome: HttpOutcome,
  options: { draft: boolean; requestSummary: Record<string, unknown> },
): PublishResult {
  if (outcome.kind === 'ambiguous') {
    return {
      outcome: 'ambiguous',
      message: outcome.message,
      diagnostics: {
        httpStatus: outcome.httpStatus,
        requestId: outcome.requestId,
        requestSummary: options.requestSummary,
        responseBody: null,
      },
    };
  }
  if (outcome.kind === 'network_error') {
    // Rien n'a été envoyé (le client ne rend `network_error` que lorsqu'il peut
    // l'affirmer) : c'est une erreur transitoire, pas une ambiguïté.
    return {
      outcome: 'server_error',
      message: outcome.message,
      diagnostics: {
        httpStatus: null,
        requestId: outcome.requestId,
        requestSummary: options.requestSummary,
        responseBody: null,
      },
    };
  }

  const diagnostics = {
    httpStatus: outcome.httpStatus,
    requestId: outcome.requestId,
    requestSummary: options.requestSummary,
    responseBody: outcome.body,
  };
  const remoteId = outcome.headers['x-restli-id'] ?? null;

  if (outcome.httpStatus === 201) {
    if (!remoteId) {
      // 2xx **sans identifiant exploitable** : la publication est probablement en
      // ligne, mais on ne peut pas le prouver — donc `ambiguous`, jamais
      // `published` (docs/05 §8.2).
      return {
        outcome: 'ambiguous',
        message:
          'LinkedIn a répondu 201 sans identifiant de post : le contenu est peut-être en ligne.',
        diagnostics,
      };
    }
    return {
      outcome: options.draft ? 'draft_created' : 'published',
      remoteId,
      remoteUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(remoteId)}/`,
      remoteStatus: options.draft ? 'DRAFT' : 'PUBLISHED',
      ...(options.draft
        ? { message: 'Brouillon LinkedIn créé : la publication finale reste manuelle.' }
        : {}),
      diagnostics,
    };
  }

  const errorMessage =
    extractLinkedInError(outcome.body) ?? `LinkedIn a répondu ${outcome.httpStatus}.`;

  if (outcome.httpStatus === 429) {
    return {
      outcome: 'rate_limited',
      message: `${errorMessage} La publication est reportée, pas annulée.`,
      ...(outcome.retryAfterMs === null ? {} : { retryAfterMs: outcome.retryAfterMs }),
      diagnostics,
    };
  }
  if (outcome.httpStatus === 401 || outcome.httpStatus === 403) {
    return {
      outcome: 'auth_error',
      message: `${errorMessage} Reconnectez le compte LinkedIn, puis relancez la publication.`,
      diagnostics,
    };
  }
  if (outcome.httpStatus === 409 || outcome.httpStatus >= 500) {
    // 409 CONFLICT est documenté comme « Retry the request », et un 5xx est une
    // erreur de la plateforme : les deux sont transitoires (docs/06 §9.1).
    return { outcome: 'server_error', message: errorMessage, diagnostics };
  }
  return { outcome: 'rejected', message: errorMessage, diagnostics };
}

function extractLinkedInError(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  const parts = ['message', 'error', 'error_description', 'serviceErrorCode']
    .map((key) => record[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  return parts.length > 0 ? parts.join(' — ') : null;
}

/**
 * Le connecteur LinkedIn. Il **ne stocke aucun jeton** : `credentialsFor` est
 * appelé à chaque usage, et la valeur rendue ne survit pas à l'appel
 * (docs/06 §10.2, règle 1).
 */
export function createLinkedInConnector(options: LinkedInConnectorOptions): PlatformConnector {
  const http =
    options.http ??
    createHttpClient({ ...(options.now ? { now: options.now } : {}), maxAttempts: 3 });

  const requireVersion = (): string => {
    const version = options.apiVersion?.trim();
    if (!version || !/^\d{6}$/.test(version)) {
      throw new CapabilityError(
        'LINKEDIN_API_VERSION doit contenir une version d’API au format AAAAMM (par exemple 202601) : ' +
          'LinkedIn déprécie ses versions, et la 202510 annoncée finit le 15 octobre 2026. ' +
          'Aucune version n’est écrite en dur pour cette raison.',
        { code: 'LINKEDIN_API_VERSION_MISSING' },
      );
    }
    return version;
  };

  const buildRequest = async (
    req: PublishRequest,
    lifecycleState: 'PUBLISHED' | 'DRAFT',
  ): Promise<{
    url: string;
    headers: Record<string, string>;
    json: unknown;
    summary: Record<string, unknown>;
  }> => {
    const account = req.account;
    if (!account) {
      throw new MissingCredentialError(
        'Aucun compte LinkedIn n’est associé à cette publication : impossible de publier par API.',
        { code: 'LINKEDIN_ACCOUNT_REQUIRED' },
      );
    }
    const author = linkedInAuthorUrn(account.remoteAccountId);
    if (!author) {
      throw new MissingCredentialError(
        `Le compte « ${account.label} » n’a pas d’identifiant LinkedIn exploitable : reconnectez-le (URN urn:li:person:… ou identifiant numérique attendu).`,
        { code: 'LINKEDIN_AUTHOR_MISSING', details: { accountId: account.platformAccountId } },
      );
    }
    const credentials = await options.credentialsFor(account);
    const commentary = linkedInCommentary(req);
    const json = {
      author,
      commentary,
      visibility: 'PUBLIC',
      distribution: {
        feedDistribution: 'MAIN_FEED',
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState,
      isReshareDisabledByAuthor: false,
    };
    return {
      url: POSTS_ENDPOINT,
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        // Obligatoires sur **tous** les appels de l'API Marketing (vérifié).
        'linkedin-version': requireVersion(),
        'x-restli-protocol-version': '2.0.0',
      },
      json,
      summary: {
        endpoint: POSTS_ENDPOINT,
        author,
        lifecycleState,
        commentaryChars: commentary.length,
        // La clé d'idempotence est **locale** : LinkedIn ne documente aucune clé
        // transmise, elle n'apparaît donc que dans le journal (docs/03 §11.2).
        idempotencyKey: req.idempotencyKey,
        accountId: account.platformAccountId,
      },
    };
  };

  const send = async (
    req: PublishRequest,
    lifecycleState: 'PUBLISHED' | 'DRAFT',
  ): Promise<PublishResult> => {
    const built = await buildRequest(req, lifecycleState);
    const outcome = await http.send({
      method: 'POST',
      url: built.url,
      headers: built.headers,
      json: built.json,
      // **Décision explicite** : aucun `idempotencyKey` n'est passé au client HTTP,
      // parce que LinkedIn n'en accepte pas. Le client traite donc ce POST comme
      // non rejouable, et toute incertitude devient `ambiguous` — c'est la règle
      // « on ne rejoue pas un effet de bord non confirmé » (docs/08 §4.1).
      idempotencyKey: null,
    });
    return interpretLinkedInResponse(outcome, {
      draft: lifecycleState === 'DRAFT',
      requestSummary: built.summary,
    });
  };

  return {
    platform: 'linkedin',
    capabilities: () => LINKEDIN_CAPABILITIES,

    /**
     * Le test de connexion doit vérifier les **portées**, pas seulement échanger
     * un code (docs/06 §10.3). La documentation consultée ne nomme pas
     * d'endpoint de profil : le contrôle effectif est donc fait au moment de
     * l'autorisation (`oauth.ts`), qui lit les portées réellement accordées.
     */
    async authenticate(): Promise<void> {
      requireVersion();
    },

    async validateContent(req: PublishRequest) {
      const spec = contentTargetSpec(req.target);
      const issues: Array<{
        field: 'title' | 'body' | 'description' | 'hashtags' | 'media' | 'cta' | 'other';
        severity: 'blocking' | 'warning';
        message: string;
        limit?: number;
        actual?: number;
      }> = [];

      if (req.platform !== 'linkedin' || spec.platform !== 'linkedin') {
        issues.push({
          field: 'other',
          severity: 'blocking',
          message: 'La cible ne correspond pas au connecteur LinkedIn.',
        });
      }
      if (!req.account || !linkedInAuthorUrn(req.account.remoteAccountId)) {
        issues.push({
          field: 'other',
          severity: 'blocking',
          message:
            'Ce compte LinkedIn n’a pas d’identifiant distant : reconnectez-le avant de publier par API.',
        });
      }
      if (
        !req.account?.scopes.includes(LINKEDIN_MEMBER_WRITE_SCOPE) &&
        !req.account?.scopes.includes(LINKEDIN_ORG_WRITE_SCOPE)
      ) {
        issues.push({
          field: 'other',
          severity: 'blocking',
          message:
            'La portée w_member_social (ou w_organization_social) n’a pas été accordée : reconnectez le compte en acceptant la publication.',
        });
      }
      // Le média n'est pas téléversable sans `initializeUpload` vérifié : on
      // refuse **avant l'envoi** plutôt que de publier un texte amputé.
      if (req.assets.length > 0) {
        issues.push({
          field: 'media',
          severity: 'blocking',
          message: `${req.assets.length} média(s) à joindre : le téléversement LinkedIn (initializeUpload) n’a pas été vérifié — publiez ce contenu en niveau C.`,
        });
      }
      const body = linkedInCommentary(req);
      const limit = LINKEDIN_CAPABILITIES.maxTextLength;
      if (body.length > limit.value) {
        issues.push({
          field: 'body',
          severity: limit.advisory ? 'warning' : 'blocking',
          message: `Le commentaire fait ${body.length} caractères ; la limite retenue est ${limit.value} et reste prudente tant qu’elle n’a pas été revérifiée.`,
          limit: limit.value,
          actual: body.length,
        });
      }
      return {
        ok: !issues.some((issue) => issue.severity === 'blocking'),
        issues,
        warnings: issues
          .filter((issue) => issue.severity === 'warning')
          .map((issue) => issue.message),
      };
    },

    createDraft: (req: PublishRequest) => send(req, 'DRAFT'),
    publish: (req: PublishRequest) => send(req, 'PUBLISHED'),

    async schedule(): Promise<PublishResult> {
      throw new CapabilityError(
        'LinkedIn n’expose pas de programmation pour les posts organiques d’un membre : le produit planifie en local et déclenche à l’échéance (docs/06 §12).',
        { code: 'LINKEDIN_SCHEDULE_UNSUPPORTED' },
      );
    },

    /**
     * **Impossible en V1, et c'est documenté.** Relire les posts d'un membre exige
     * `r_member_social`, portée réservée aux applications approuvées. Prétendre
     * vérifier serait pire que ne pas vérifier : une ambiguïté devient donc une
     * décision humaine (docs/05 §8.3, docs/06 §9.2).
     */
    async verifyPublished(): Promise<VerificationResult> {
      return {
        verifiable: false,
        found: false,
        reason:
          'La lecture des posts d’un membre exige la portée r_member_social, réservée aux applications approuvées : en V1, une ambiguïté LinkedIn est tranchée par un humain (docs/06 §9.2).',
      };
    },

    async fetchMetrics(): Promise<Array<Record<string, unknown>>> {
      throw new CapabilityError(
        'Les statistiques LinkedIn d’un compte personnel exigent une portée réservée : la saisie manuelle (`metric_snapshots`, source = manual) est la voie prévue en V1 (docs/03 §12.1).',
        { code: 'LINKEDIN_METRICS_UNAVAILABLE' },
      );
    },

    // Le paquet manuel reste disponible **même en niveau A** (docs/06 §8.4) :
    // panne de plateforme, correction à la main, publication depuis le téléphone.
    buildManualPackage: (req: PublishRequest) => manualConnectors.linkedin.buildManualPackage(req),
  };
}
