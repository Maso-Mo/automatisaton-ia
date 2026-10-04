import { describe, expect, it } from 'vitest';
import { resolvePublishMode, type PublishRequest } from './capabilities';
import type { HttpClient, HttpOutcome } from './http-client';
import {
  PUBLISH_REACTIONS,
  SCHEDULE_BUCKET_MS,
  forbidsRemoteCall,
  publicationIdempotencyKey,
  reactionFor,
  scheduleBucketKey,
} from './idempotency';
import { resolveConnectorForAccount } from './index';
import { interpretLinkedInResponse, linkedInAuthorUrn, linkedInCommentary } from './linkedin';
import { buildAuthorizationUrl, exchangeAuthorizationCode, refreshAccessToken } from './oauth';
import { createSimulatedConnector } from './simulated';

/**
 * Les contrats **purs** de l'étape 8 : l'idempotence, la table de décision, le
 * choix du niveau, et le connecteur simulé. Rien ici n'ouvre de socket ni ne
 * touche la base — ce sont exactement les règles qu'on veut pouvoir vérifier
 * ligne par ligne, sans publier.
 */

describe('idempotence — la clé qui empêche le doublon', () => {
  it('produit la même clé pour deux appels identiques, et une autre au-delà du grain', () => {
    const base = { contentVersionId: 'v1', platformAccountId: 'a1', scheduledFor: 1_000 };
    const same = { ...base, scheduledFor: base.scheduledFor + 1_000 };
    const later = { ...base, scheduledFor: base.scheduledFor + SCHEDULE_BUCKET_MS };

    expect(publicationIdempotencyKey(base)).toBe(publicationIdempotencyKey(same));
    expect(publicationIdempotencyKey(base)).not.toBe(publicationIdempotencyKey(later));
  });

  it('range une publication immédiate dans la clé « immediate »', () => {
    expect(scheduleBucketKey(null)).toBe('immediate');
    expect(scheduleBucketKey(0)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe('idempotence — la table de décision', () => {
  it('couvre chaque issue et n’en laisse aucune sans réaction', () => {
    for (const entry of Object.values(PUBLISH_REACTIONS)) {
      expect(entry.reaction.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.userAction.length).toBeGreaterThan(0);
    }
  });

  it('ne rejoue JAMAIS une ambiguïté : elle se vérifie', () => {
    expect(reactionFor('ambiguous').reaction).toBe('verify_then_decide');
    // Un 429 reporte, un refus échoue, une auth expire — aucun ne rejoue à l’aveugle.
    expect(reactionFor('rate_limited').reaction).toBe('postpone');
    expect(reactionFor('rejected').reaction).toBe('fail_definitive');
    expect(reactionFor('auth_error').reaction).toBe('expire_account');
    expect(reactionFor('server_error').reaction).toBe('retry_transient');
  });

  it('interdit tout appel distant sur un état déjà tranché ou une décision humaine', () => {
    expect(forbidsRemoteCall('published', false)).toBe(true);
    expect(forbidsRemoteCall('manual_required', false)).toBe(true);
    expect(forbidsRemoteCall('ambiguous', false)).toBe(true);
    expect(forbidsRemoteCall('planned', true)).toBe(true);
    expect(forbidsRemoteCall('planned', false)).toBe(false);
  });
});

describe('niveau de publication — décidé avant l’appel', () => {
  it('plafonne le niveau déclaré par les capacités réelles (docs/10 §4.8)', () => {
    expect(resolvePublishMode({ level: 'A', directPublish: false, draft: true })).toBe('B');
    expect(resolvePublishMode({ level: 'A', directPublish: false, draft: false })).toBe('C');
    expect(resolvePublishMode({ level: 'A', directPublish: true })).toBe('A');
    expect(resolvePublishMode({ directPublish: true })).toBe('A');
    expect(resolvePublishMode({})).toBe('C');
  });

  it('retombe en niveau C (paquet manuel) sans connecteur d’API ni compte connecté', () => {
    const account = {
      platformAccountId: 'a1',
      platform: 'linkedin' as const,
      remoteAccountId: 'urn:li:person:1',
      label: 'LinkedIn',
      scopes: ['w_member_social'],
    };
    const connector = createSimulatedConnector({ platform: 'linkedin', level: 'A' });

    expect(
      resolveConnectorForAccount({
        platform: 'linkedin',
        account,
        capabilities: { level: 'A', directPublish: true },
        connectionState: 'connected',
        apiConnector: connector,
      }).level,
    ).toBe('A');

    expect(
      resolveConnectorForAccount({
        platform: 'linkedin',
        account,
        capabilities: { level: 'A', directPublish: true },
        connectionState: 'expired',
        apiConnector: connector,
      }).level,
    ).toBe('C');

    expect(
      resolveConnectorForAccount({
        platform: 'linkedin',
        account,
        capabilities: { level: 'A', directPublish: true },
        connectionState: 'connected',
        apiConnector: null,
      }).level,
    ).toBe('C');
  });
});

function fakeHttp(outcome: HttpOutcome): HttpClient {
  return { send: async () => outcome };
}

function okResponse(
  httpStatus: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpOutcome {
  return {
    kind: 'response',
    httpStatus,
    body,
    headers,
    requestId: 'req-1',
    retryAfterMs: null,
    attempts: 1,
  };
}

describe('LinkedIn — la table d’erreurs, ligne par ligne (docs/06 §9.1)', () => {
  const opts = { draft: false, requestSummary: {} };

  it('traduit 201 + identifiant en « published », et 201 sans identifiant en « ambiguous »', () => {
    const published = interpretLinkedInResponse(
      okResponse(201, {}, { 'x-restli-id': 'urn:li:share:1' }),
      opts,
    );
    expect(published.outcome).toBe('published');
    expect(published.remoteId).toBe('urn:li:share:1');

    // 2xx sans identifiant exploitable : publié *peut-être* — donc jamais « published ».
    expect(interpretLinkedInResponse(okResponse(201, {}), opts).outcome).toBe('ambiguous');
  });

  it('range 401/403 en auth_error, 429 en rate_limited, 5xx en server_error, 400 en rejected', () => {
    expect(interpretLinkedInResponse(okResponse(401, {}), opts).outcome).toBe('auth_error');
    expect(interpretLinkedInResponse(okResponse(403, {}), opts).outcome).toBe('auth_error');
    expect(interpretLinkedInResponse(okResponse(500, {}), opts).outcome).toBe('server_error');
    expect(
      interpretLinkedInResponse(okResponse(400, { message: 'Champ invalide' }), opts).outcome,
    ).toBe('rejected');
    expect(
      interpretLinkedInResponse(okResponse(429, {}, { 'retry-after': '60' }), opts).outcome,
    ).toBe('rate_limited');
  });

  it('un timeout après envoi est ambigu ; une erreur réseau avant envoi ne l’est pas', () => {
    expect(
      interpretLinkedInResponse(
        { kind: 'ambiguous', httpStatus: null, message: 'timeout', requestId: 'r', attempts: 1 },
        opts,
      ).outcome,
    ).toBe('ambiguous');
    expect(
      interpretLinkedInResponse(
        { kind: 'network_error', message: 'connexion', requestId: 'r', attempts: 1 },
        opts,
      ).outcome,
    ).toBe('server_error');
  });

  it('déduit l’URN d’auteur et compose le commentaire (accroche, corps, hashtags)', () => {
    expect(linkedInAuthorUrn('urn:li:person:123')).toBe('urn:li:person:123');
    expect(linkedInAuthorUrn('12345')).toBe('urn:li:person:12345');
    expect(linkedInAuthorUrn('n-a')).toBeNull();
    expect(linkedInAuthorUrn(null)).toBeNull();

    expect(
      linkedInCommentary({
        contentItemId: 'i',
        contentVersionId: 'v',
        target: 'linkedin_post',
        platform: 'linkedin',
        body: 'Corps',
        title: null,
        hook: null,
        description: null,
        hashtags: ['#a', '#b'],
        mentions: [],
        idempotencyKey: 'k',
        assets: [],
      }),
    ).toBe('Corps\n\n#a #b');
  });
});

describe('LinkedIn — OAuth, le secret ne quitte jamais le serveur', () => {
  const config = {
    clientId: 'id-public',
    clientSecret: 'secret-jamais-expose',
    redirectUri: 'https://example.test/callback',
  };
  const deterministicRandom = (length: number): Uint8Array => new Uint8Array(length).fill(7);

  it('construit une URL d’autorisation en PKCE, sans client_secret', async () => {
    const auth = await buildAuthorizationUrl({
      config,
      scopes: ['w_member_social'],
      random: deterministicRandom,
    });
    const url = new URL(auth.url);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe(auth.state);
    expect(url.searchParams.get('scope')).toBe('w_member_social');
    expect(auth.url).not.toContain('secret-jamais-expose');
  });

  it('échange le code contre un jeton, et rejette un refus d’autorisation', async () => {
    const ok = await exchangeAuthorizationCode({
      config,
      code: 'code',
      codeVerifier: 'verifier',
      http: fakeHttp(okResponse(200, { access_token: 'tok', expires_in: 3_600 })),
    });
    expect(ok.accessToken).toBe('tok');
    expect(ok.expiresInSec).toBe(3_600);

    await expect(
      exchangeAuthorizationCode({
        config,
        code: 'code',
        codeVerifier: 'verifier',
        http: fakeHttp(okResponse(400, { error: 'invalid_request' })),
      }),
    ).rejects.toThrow(/refusée/);
  });

  it('rafraîchit un jeton et rend les portées réellement accordées', async () => {
    const refreshed = await refreshAccessToken({
      config,
      refreshToken: 'refresh',
      http: fakeHttp(
        okResponse(200, { access_token: 'tok2', scope: 'w_member_social r_member_social' }),
      ),
    });
    expect(refreshed.accessToken).toBe('tok2');
    expect(refreshed.scopes).toEqual(['w_member_social', 'r_member_social']);
  });
});

describe('connecteur simulé — le banc qui compte les publications', () => {
  const request = {
    contentItemId: 'i',
    contentVersionId: 'v',
    target: 'linkedin_post',
    platform: 'linkedin',
    body: 'Texte à publier.',
    title: null,
    hook: null,
    description: null,
    hashtags: [],
    mentions: [],
    idempotencyKey: 'k',
    assets: [],
  } satisfies PublishRequest;

  it('compte un post réellement émis, et reste ambigu quand la réponse se perd', async () => {
    const ok = createSimulatedConnector({ behaviour: 'success' });
    expect((await ok.publish(request)).outcome).toBe('published');
    expect(ok.remotePosts).toHaveLength(1);

    const lost = createSimulatedConnector({ behaviour: 'timeout_after_send' });
    const outcome = await lost.publish(request);
    expect(outcome.outcome).toBe('ambiguous');
    // Le contenu est réellement parti : c’est ce qui rend le doublon possible.
    expect(lost.remotePosts).toHaveLength(1);
    expect((await lost.verifyPublished(request)).found).toBe(true);
  });
});
