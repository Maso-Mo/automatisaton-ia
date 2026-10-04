import { MissingCredentialError } from '@aia/shared';
import { createHttpClient, type HttpClient } from './http-client';

/**
 * **OAuth 2.0 à code d'autorisation** pour LinkedIn (docs/07 §6.1).
 *
 * Ce que cette documentation a confirmé, et qui structure le code :
 *
 * - l'échange du code se fait sur `/oauth/v2/accessToken` — l'URL du point
 *   d'autorisation (`/oauth/v2/authorization`) suit la même convention ;
 * - **PKCE est accepté** : l'erreur `invalid_redirect_uri` mentionne un
 *   `code_verifier`, ce qui n'a de sens qu'avec PKCE. On l'utilise donc
 *   systématiquement, parce qu'une application locale ne peut pas garder un
 *   `client_secret` secret (docs/07 §6.3) ;
 * - **l'URL de redirection doit être en HTTPS** dans la configuration de
 *   l'application LinkedIn. C'est une contrainte **réelle** que docs/07 §3.2
 *   n'anticipait pas (elle décrit une redirection locale en `http://127.0.0.1`) :
 *   elle est notée comme point ouvert, pas contournée.
 *
 * Les cinq protections obligatoires de docs/07 §6.2 sont ici : `state` aléatoire
 * et à usage unique (vérifié par l'appelant qui le conserve), PKCE, redirection
 * exacte, aucune journalisation du code ni du jeton, et expiration courte du
 * `state`.
 */

export const LINKEDIN_AUTHORIZATION_ENDPOINT = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_TOKEN_ENDPOINT = 'https://www.linkedin.com/oauth/v2/accessToken';

/** Durée de vie de l'état anti-CSRF : cinq minutes suffisent à un aller-retour. */
export const OAUTH_STATE_TTL_MS = 5 * 60 * 1_000;

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
  /** Doit correspondre **au caractère près** à l'URL enregistrée chez LinkedIn. */
  redirectUri: string;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * PKCE S256. `random` est injecté : un test peut produire un `state` et un
 * vérificateur déterministes sans affaiblir la production (qui utilise
 * `crypto.getRandomValues`).
 */
export async function createPkcePair(
  random: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): Promise<PkcePair> {
  const codeVerifier = base64Url(random(32));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return { codeVerifier, codeChallenge: base64Url(new Uint8Array(digest)) };
}

export function createOAuthState(
  random: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): string {
  return base64Url(random(24));
}

export interface AuthorizationRequest {
  url: string;
  state: string;
  pkce: PkcePair;
}

/**
 * L'URL vers laquelle **le navigateur** est envoyé. Le `client_secret` n'y
 * apparaît jamais (docs/07 §6.3) : c'est tout l'objet de PKCE.
 */
export async function buildAuthorizationUrl(input: {
  config: OAuthClientConfig;
  scopes: readonly string[];
  state?: string;
  random?: (length: number) => Uint8Array;
}): Promise<AuthorizationRequest> {
  const state = input.state ?? createOAuthState(input.random);
  const pkce = await createPkcePair(input.random);
  const url = new URL(LINKEDIN_AUTHORIZATION_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.config.clientId);
  url.searchParams.set('redirect_uri', input.config.redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', input.scopes.join(' '));
  url.searchParams.set('code_challenge', pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, pkce };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  /**
   * Durée annoncée par la plateforme, **reprise telle quelle**. `null` quand la
   * réponse ne la donne pas : la durée de vie d'un jeton n'est pas devinée, elle
   * est lue — et un jeton sans durée annoncée est considéré comme à rafraîchir.
   */
  expiresInSec: number | null;
  /** Portées **réellement accordées**, quand la réponse les fournit. */
  scopes: string[] | null;
}

function interpretTokenResponse(httpStatus: number, body: unknown, flow: string): TokenResponse {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const accessToken = typeof record.access_token === 'string' ? record.access_token : null;
  if (httpStatus >= 400 || !accessToken) {
    const error = typeof record.error === 'string' ? record.error : `HTTP ${httpStatus}`;
    const description =
      typeof record.error_description === 'string' ? ` — ${record.error_description}` : '';
    // Catégorie `auth` : ce n'est ni une panne ni une ambiguïté, c'est une
    // configuration à refaire par l'utilisateur (docs/08 §4.2). Aucune reprise
    // automatique : réessayer un refus d'autorisation le rendrait plus long à
    // diagnostiquer, jamais plus probable.
    throw new MissingCredentialError(
      `Autorisation LinkedIn refusée (${flow}) : ${error}${description}. Reconnectez le compte.`,
      { code: 'LINKEDIN_OAUTH_REFUSED', details: { flow } },
    );
  }
  const expiresIn =
    typeof record.expires_in === 'number'
      ? record.expires_in
      : typeof record.expires_in === 'string' && Number.isFinite(Number(record.expires_in))
        ? Number(record.expires_in)
        : null;
  const scope =
    typeof record.scope === 'string' ? record.scope.split(/[\s,]+/).filter(Boolean) : null;
  return {
    accessToken,
    refreshToken: typeof record.refresh_token === 'string' ? record.refresh_token : null,
    expiresInSec: expiresIn,
    scopes: scope,
  };
}

/**
 * Échange le code contre un jeton. Le code et le jeton ne sont **jamais**
 * journalisés : le client HTTP rédige déjà tout ce qui sort (docs/07 §9.1), et
 * l'appelant ne doit rien en écrire non plus.
 */
export async function exchangeAuthorizationCode(input: {
  config: OAuthClientConfig;
  code: string;
  codeVerifier: string;
  http?: HttpClient;
}): Promise<TokenResponse> {
  const http = input.http ?? createHttpClient({ maxAttempts: 2 });
  const outcome = await http.send({
    method: 'POST',
    url: LINKEDIN_TOKEN_ENDPOINT,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    json: {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.config.redirectUri,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      code_verifier: input.codeVerifier,
    },
    idempotencyKey: null,
  });
  if (outcome.kind !== 'response') {
    throw new MissingCredentialError(
      `L’échange du code OAuth LinkedIn n’a pas abouti : ${outcome.message}. Réessayez la connexion.`,
      { code: 'LINKEDIN_OAUTH_EXCHANGE_FAILED' },
    );
  }
  return interpretTokenResponse(outcome.httpStatus, outcome.body, 'échange du code');
}

/**
 * Rafraîchit un jeton **avant** son expiration (docs/06 §4.3 : « on rafraîchit
 * avant l'expiration, pas après l'échec »). L'appelant est responsable de la
 * sérialisation par compte (`createAccountLocks`) : deux rafraîchissements
 * concurrents avec un `refresh_token` rotatif invalident le compte.
 */
export async function refreshAccessToken(input: {
  config: OAuthClientConfig;
  refreshToken: string;
  http?: HttpClient;
}): Promise<TokenResponse> {
  const http = input.http ?? createHttpClient({ maxAttempts: 2 });
  const outcome = await http.send({
    method: 'POST',
    url: LINKEDIN_TOKEN_ENDPOINT,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    json: {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
    },
    idempotencyKey: null,
  });
  if (outcome.kind !== 'response') {
    throw new MissingCredentialError(
      `Le rafraîchissement du jeton LinkedIn a échoué (${outcome.message}) : reconnectez le compte — aucune reprise en boucle n’est tentée.`,
      { code: 'LINKEDIN_REFRESH_FAILED' },
    );
  }
  return interpretTokenResponse(outcome.httpStatus, outcome.body, 'rafraîchissement');
}
