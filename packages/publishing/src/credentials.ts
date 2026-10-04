import { MissingCredentialError } from '@aia/shared';

/**
 * Les jetons, **du point de vue du connecteur** (docs/06 §10).
 *
 * Quatre règles, et elles ne sont pas des conseils :
 *
 * 1. **le connecteur ne stocke rien** — il reçoit un jeton déchiffré, l'utilise,
 *    le rend. Aucune copie dans un cache ni dans une closure persistante ;
 * 2. **le jeton n'entre jamais dans un journal**, même en debug : c'est le client
 *    HTTP qui rédige, pas l'appelant (docs/07 §9.1) ;
 * 3. **le jeton n'est jamais envoyé à un LLM** ;
 * 4. **un rafraîchissement est sérialisé par compte** — deux rafraîchissements
 *    simultanés avec un `refresh_token` rotatif invalident le compte.
 *
 * Le déchiffrement est **injecté** (`decrypt`) : `@aia/publishing` ne dépend pas
 * des clés de `@aia/config`, et un test peut fournir un déchiffreur scripté. Le
 * point d'appel — API ou worker — passe `decryptToken` de `@aia/config`.
 */

export type TokenDecryptor = (envelope: string, keyVersion: number) => string;

export interface AccountCredentials {
  accessToken: string;
  refreshToken: string | null;
  /** Déjà déchiffrés. Jamais journalisés, jamais rendus au-delà du connecteur. */
  expiresAt: number | null;
}

export interface CredentialSource {
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenKeyVersion: number;
  tokenExpiresAt: number | null;
}

/**
 * **On rafraîchit avant l'expiration, jamais en réaction à une erreur 401**
 * (docs/06 §4.3). Rafraîchir au premier 401 signifie que la publication en cours
 * échoue — souvent au pire moment — et produit un `ambiguous` si la requête était
 * un POST. La fenêtre est de 24 h : assez large pour qu'un job long ne la rate
 * pas, assez courte pour ne pas rafraîchir à chaque appel.
 */
export const REFRESH_WINDOW_MS = 24 * 60 * 60 * 1_000;

export interface CredentialResolution {
  credentials: AccountCredentials;
  /** `true` si le jeton expire dans la fenêtre : il **doit** être rafraîchi avant usage. */
  needsRefresh: boolean;
}

export function resolveCredentials(input: {
  account: CredentialSource;
  decrypt: TokenDecryptor;
  nowMs: number;
}): CredentialResolution {
  const { account } = input;
  if (!account.accessTokenEncrypted) {
    throw new MissingCredentialError(
      'Ce compte n’a pas de jeton : reconnectez-le avant de publier par API.',
      { code: 'PLATFORM_TOKEN_MISSING' },
    );
  }
  const accessToken = input.decrypt(account.accessTokenEncrypted, account.tokenKeyVersion);
  const refreshToken = account.refreshTokenEncrypted
    ? input.decrypt(account.refreshTokenEncrypted, account.tokenKeyVersion)
    : null;
  const needsRefresh =
    account.tokenExpiresAt !== null && input.nowMs + REFRESH_WINDOW_MS >= account.tokenExpiresAt;
  return {
    credentials: { accessToken, refreshToken, expiresAt: account.tokenExpiresAt },
    needsRefresh,
  };
}

/**
 * Un verrou **par compte** : deux rafraîchissements concurrents sur le même
 * compte avec un `refresh_token` rotatif révoquent le compte (docs/06 §10.2,
 * règle 4). Un simple verrou en mémoire suffit à l'échelle d'un processus unique
 * — et il est préférable à un verrou en base pour une opération de quelques
 * centaines de millisecondes.
 */
export function createAccountLocks() {
  const locks = new Map<string, Promise<unknown>>();
  return {
    async run<T>(accountId: string, task: () => Promise<T>): Promise<T> {
      const previous = locks.get(accountId) ?? Promise.resolve();
      const next = previous.then(task, task);
      locks.set(
        accountId,
        next.catch(() => undefined),
      );
      try {
        return await next;
      } finally {
        if (locks.get(accountId) === next) locks.delete(accountId);
      }
    },
    size(): number {
      return locks.size;
    },
  };
}

export type AccountLock = ReturnType<typeof createAccountLocks>;
