import type { PlatformId } from '@aia/shared';
import {
  resolvePublishMode,
  type ConnectorLevel,
  type PlatformConnector,
  type PublishAccountRef,
} from './capabilities';
import type { AccountCredentials } from './credentials';
import { createLinkedInConnector } from './linkedin';
import { manualConnectorFor, manualConnectors } from './manual';

/**
 * `@aia/publishing` — les connecteurs de publication.
 *
 * Ce paquet est de l'**infrastructure** : il ne connaît pas le domaine et ne
 * décide de rien. Il expose :
 *
 * - le contrat `PlatformConnector` et ses capacités vérifiées (`capabilities.ts`) ;
 * - l'idempotence et la table de décision (`idempotency.ts`) ;
 * - le client HTTP partagé (`http-client.ts`) ;
 * - les jetons vus du connecteur (`credentials.ts`) et le parcours OAuth
 *   (`oauth.ts`) ;
 * - les connecteurs : niveau C pour **toutes** les plateformes (`manual.ts`),
 *   niveau A/B là où une API est acquise (`linkedin.ts`), et un connecteur
 *   simulé pour les tests (`simulated.ts`).
 *
 * **Le repli n'est pas un `catch`** : `resolveConnectorForAccount()` choisit le
 * niveau **avant** l'appel, à partir des capacités enregistrées au moment de la
 * connexion (`platform_accounts.capabilities_json`). Une plateforme non acquise
 * n'a pas de niveau A — elle a un niveau C, disponible et utile (docs/10 §4.8).
 */

export * from './capabilities';
export * from './credentials';
export * from './http-client';
export * from './idempotency';
export * from './linkedin';
export * from './manual';
export * from './oauth';
export * from './simulated';

/**
 * Le **niveau C** d'une plateforme : conservé sous ce nom parce que c'est celui
 * qu'utilisent les routes de l'étape 5 (paquet manuel, comptes) et les tests
 * existants. Il ne publie rien par API — par construction.
 */
export function connectorFor(platform: PlatformId): PlatformConnector | null {
  return manualConnectorFor(platform);
}

/** Les plateformes pour lesquelles une API de publication est **implémentée**. */
export const API_CONNECTOR_PLATFORMS: readonly PlatformId[] = ['linkedin'];

export interface ApiConnectorOptions {
  /**
   * Version d'API, par plateforme, lue dans la configuration
   * (`LINKEDIN_API_VERSION`). Aucun connecteur n'écrit de version en dur :
   * LinkedIn déprécie ses versions, et une constante figée serait périmée à une
   * date connue (docs/06 §4).
   */
  apiVersions?: Partial<Record<PlatformId, string | null>>;
  /** Rend un jeton **déjà déchiffré** pour ce compte (jamais persisté ici). */
  credentialsFor: (account: PublishAccountRef) => Promise<AccountCredentials>;
  http?: Parameters<typeof createLinkedInConnector>[0]['http'];
  now?: () => number;
}

/**
 * Le connecteur d'API d'une plateforme, s'il en existe un. `null` est une
 * réponse normale : c'est ce qui fait retomber le compte en niveau C.
 */
export function createApiConnector(
  platform: PlatformId,
  options: ApiConnectorOptions,
): PlatformConnector | null {
  switch (platform) {
    case 'linkedin':
      return createLinkedInConnector({
        apiVersion: options.apiVersions?.linkedin ?? null,
        credentialsFor: options.credentialsFor,
        ...(options.http ? { http: options.http } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    // YouTube (niveau B) et Reddit/TikTok (niveau C assumé en V1) ne sont pas
    // implémentés : docs/10 §4.8 interdit de livrer un niveau A pour une
    // plateforme non acquise, et un connecteur non vérifié serait pire qu'absent.
    default:
      return null;
  }
}

export interface ResolvedConnector {
  /** Le niveau réellement retenu : A, B ou C. */
  level: ConnectorLevel;
  connector: PlatformConnector;
  /** Ce qui a été décidé, en une phrase — utile au diagnostic et aux tests. */
  reason: string;
}

/**
 * **La décision de niveau, prise avant l'appel.** Trois conditions pour publier
 * par API, et chacune manque souvent :
 *
 * 1. la plateforme a une implémentation (`createApiConnector`) ;
 * 2. le compte est `connected` — un compte `expired` ou `revoked` ne publie pas :
 *    l'appel échouerait en 401, ce qui coûterait un aller-retour et une entrée
 *    d'erreur pour rien ;
 * 3. ses capacités enregistrées autorisent `directPublish` (A) ou `draft` (B).
 *
 * Sinon : **niveau C**, avec le paquet manuel. Jamais une erreur, jamais un
 * silence.
 */
export function resolveConnectorForAccount(input: {
  platform: PlatformId;
  account: PublishAccountRef;
  capabilities: { level?: string; directPublish?: boolean; draft?: boolean } | null;
  connectionState?: string;
  apiConnector?: PlatformConnector | null;
}): ResolvedConnector {
  const manual = manualConnectorFor(input.platform) ?? manualConnectors.linkedin;
  const declared = input.capabilities;
  const mode = declared ? resolvePublishMode(declared) : 'C';

  if (mode === 'C') {
    return {
      level: 'C',
      connector: manual,
      reason: 'Les capacités enregistrées du compte ne permettent pas d’écrire par API.',
    };
  }
  if (!input.apiConnector) {
    return {
      level: 'C',
      connector: manual,
      reason: 'Aucun connecteur d’API n’est implémenté pour cette plateforme.',
    };
  }
  if (input.connectionState !== undefined && input.connectionState !== 'connected') {
    return {
      level: 'C',
      connector: manual,
      reason: `Le compte est « ${input.connectionState} » : la publication par API est bloquée (docs/06 §10.1).`,
    };
  }
  return {
    level: mode,
    connector: input.apiConnector,
    reason:
      mode === 'A'
        ? 'Publication par API officielle (niveau A).'
        : 'Brouillon distant (niveau B) : la publication finale reste manuelle.',
  };
}
