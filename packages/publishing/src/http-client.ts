import { redact } from '@aia/config';

/**
 * Le **client HTTP partagé** des connecteurs (docs/06 §3.3). Aucun connecteur ne
 * parle au réseau directement : tout passe par ici, parce que les six services
 * de ce client sont exactement les six choses qu'un connecteur oublierait.
 *
 * 1. **rédaction des secrets** — appliquée à la sortie, pas par l'appelant : un
 *    appelant peut oublier, un point de passage unique ne peut pas (docs/07 §9.1) ;
 * 2. **délais explicites** — 30 s pour un POST de publication, 10 s pour un GET ;
 * 3. **reprise contrôlée** — 5xx et erreurs réseau seulement, avec jitter, et
 *    **jamais** sur un POST sans clé d'idempotence ;
 * 4. **`Retry-After`** lu et rendu en millisecondes : il alimente directement
 *    `platform_accounts.rate_limit_reset_at` ;
 * 5. **détection d'ambiguïté** — un timeout ou une réponse illisible **après**
 *    envoi rend `ambiguous`, jamais une exception ;
 * 6. **corrélation** — un `request_id` local par appel, présent dans les
 *    diagnostics et dans `publication_attempts`.
 *
 * Le client est **injectable** : `fetch`, l'horloge, l'aléa et le sommeil sont
 * fournis par l'appelant. C'est ce qui permet aux tests d'exercer le chemin réel
 * (statuts, délais, `Retry-After`, ambiguïté) **sans ouvrir un socket**.
 */

export interface HttpClientLogger {
  debug(payload: Record<string, unknown>, message: string): void;
}

export interface HttpClientOptions {
  fetch?: typeof globalThis.fetch;
  /** Appliquée à tout ce qui sort du client : jamais un jeton dans un journal. */
  redact?: (value: unknown) => unknown;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: HttpClientLogger;
  /** POST de publication : 30 s (docs/06 §3.3). */
  postTimeoutMs?: number;
  /** GET : 10 s (docs/06 §3.3). */
  getTimeoutMs?: number;
  /** Nombre total de tentatives pour un appel réessayable. */
  maxAttempts?: number;
  /** Jitter ±20 % (docs/08 §4.1 : sans jitter, trois jobs reviennent ensemble). */
  jitterRatio?: number;
}

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  /**
   * La présence d'une clé d'idempotence rend le POST réessayable. Sans elle, un
   * POST n'est **jamais** rejoué : c'est « on ne réessaie que ce qui est sûr »
   * (docs/08 §4.1).
   */
  idempotencyKey?: string | null;
  timeoutMs?: number;
}

export type HttpOutcome =
  | {
      kind: 'response';
      httpStatus: number;
      body: unknown;
      /** En-têtes **sélectionnés** par le client, rédigés (jamais de jeton en réponse). */
      headers: Record<string, string>;
      requestId: string;
      retryAfterMs: number | null;
      attempts: number;
    }
  | {
      kind: 'ambiguous';
      httpStatus: number | null;
      message: string;
      requestId: string;
      attempts: number;
    }
  | { kind: 'network_error'; message: string; requestId: string; attempts: number };

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpOutcome>;
}

/** Lecture de `Retry-After` : secondes ou date HTTP, jamais devinée. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

const RETRYABLE_STATUSES = new Set([500, 502, 503, 504, 522, 524]);

/**
 * Les en-têtes utiles au connecteur, et **eux seuls**.
 *
 * C'est un choix de sécurité : la réponse d'une plateforme contient parfois
 * `set-cookie` ou des rappels d'autorisation, et un en-tête recopié dans
 * `publication_attempts` serait une fuite silencieuse. On ne garde donc que ce
 * dont un connecteur a besoin pour décider : l'identifiant distant de LinkedIn
 * (`x-restli-id`), le type de contenu, et la date (`etag`/`x-restli-...`).
 */
const KEPT_RESPONSE_HEADERS = [
  'x-restli-id',
  'x-restli-protocol-version',
  'content-type',
  'etag',
  'location',
] as const;

function collectHeaders(response: Response): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) kept[name] = value;
  }
  return kept;
}

function isRetryableNetworkCode(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: string } | null)?.code;
  return (
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_SOCKET' ||
    code === 'ETIMEDOUT'
  );
}

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const redactValue = options.redact ?? redact;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const postTimeoutMs = options.postTimeoutMs ?? 30_000;
  const getTimeoutMs = options.getTimeoutMs ?? 10_000;
  const maxAttempts = options.maxAttempts ?? 3;
  const jitterRatio = options.jitterRatio ?? 0.2;

  const backoffMs = (attempt: number): number => {
    const base = 30_000 * 4 ** (attempt - 1);
    const jitter = 1 + (random() * 2 - 1) * jitterRatio;
    return Math.round(base * jitter);
  };

  const requestSummary = (request: HttpRequest, requestId: string): Record<string, unknown> => {
    const summary: Record<string, unknown> = {
      requestId,
      method: request.method,
      url: request.url,
      idempotencyKey: request.idempotencyKey ?? null,
    };
    if (request.json !== undefined) {
      const serialized = JSON.stringify(request.json);
      summary.bodyBytes = serialized.length;
      // Le corps d'une publication est **public** : le montrer aide à comprendre
      // un refus. Il reste borné, et la rédaction s'applique juste après.
      summary.bodyPreview = serialized.slice(0, 500);
    }
    return redactValue(summary) as Record<string, unknown>;
  };

  return {
    async send(request: HttpRequest): Promise<HttpOutcome> {
      const requestId = `req_${now().toString(36)}_${Math.floor(random() * 1e6).toString(36)}`;
      const timeoutMs =
        request.timeoutMs ?? (request.method === 'GET' ? getTimeoutMs : postTimeoutMs);
      const retryable = request.method === 'GET' || Boolean(request.idempotencyKey);
      let attempt = 0;

      for (;;) {
        attempt += 1;
        const controller = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

        try {
          const response = await doFetch(request.url, {
            method: request.method,
            headers: {
              accept: 'application/json',
              ...(request.json === undefined ? {} : { 'content-type': 'application/json' }),
              ...(request.headers ?? {}),
            },
            ...(request.json === undefined ? {} : { body: JSON.stringify(request.json) }),
            signal: controller.signal,
          });
          clearTimeout(timer);

          const raw = await response.text().catch(() => '');
          let body: unknown = null;
          let readable = true;
          if (raw.trim().length > 0) {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              readable = false;
              body = { unparsed: raw.slice(0, 500) };
            }
          }

          options.logger?.debug(
            {
              ...requestSummary(request, requestId),
              httpStatus: response.status,
              attempts: attempt,
            },
            'appel plateforme',
          );

          if (RETRYABLE_STATUSES.has(response.status)) {
            if (retryable && attempt < maxAttempts) {
              await sleep(backoffMs(attempt));
              continue;
            }
            // Un POST **sans** clé d'idempotence qui reçoit un 5xx a peut-être
            // été accepté : on ne le rejoue pas et on refuse de conclure.
            return retryable
              ? {
                  kind: 'ambiguous',
                  httpStatus: response.status,
                  message: `La plateforme a répondu ${response.status} après ${attempt} tentative(s) : l'issue n'est pas déterminée.`,
                  requestId,
                  attempts: attempt,
                }
              : {
                  kind: 'network_error',
                  message: `La plateforme a répondu ${response.status} (aucune reprise sans clé d'idempotence).`,
                  requestId,
                  attempts: attempt,
                };
          }

          if (!readable && response.ok) {
            // Une réponse 2xx illisible est le cas d'école de l'ambiguïté : le
            // contenu est probablement parti, on ne sait simplement pas où.
            return {
              kind: 'ambiguous',
              httpStatus: response.status,
              message: `Réponse ${response.status} illisible : impossible de confirmer la publication.`,
              requestId,
              attempts: attempt,
            };
          }

          return {
            kind: 'response',
            httpStatus: response.status,
            body: redactValue(body),
            headers: collectHeaders(response),
            requestId,
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now()),
            attempts: attempt,
          };
        } catch (error) {
          clearTimeout(timer);
          const message = timedOut
            ? `Délai de ${timeoutMs} ms dépassé.`
            : error instanceof Error
              ? error.message
              : String(error);

          options.logger?.debug(
            { ...requestSummary(request, requestId), attempts: attempt, error: message },
            'appel plateforme en échec',
          );

          if (timedOut) {
            if (retryable && attempt < maxAttempts) {
              await sleep(backoffMs(attempt));
              continue;
            }
            // « Timeout avant envoi = 1 tentative ; timeout après envoi =
            // ambiguous » (docs/06 §9.1). Un POST a été remis au transport avant
            // l'expiration du délai : on ne peut donc pas prouver que rien n'est
            // parti — et c'est ce doute qui interdit de conclure.
            return {
              kind: 'ambiguous',
              httpStatus: null,
              message: `${message} L'envoi a peut-être abouti : aucune conclusion n'est possible.`,
              requestId,
              attempts: attempt,
            };
          }

          if (retryable && isRetryableNetworkCode(error) && attempt < maxAttempts) {
            await sleep(backoffMs(attempt));
            continue;
          }

          return { kind: 'network_error', message, requestId, attempts: attempt };
        }
      }
    },
  };
}
