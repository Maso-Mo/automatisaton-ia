import { and, asc, count, desc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import { encodeJson, parseJsonUnknown, uuidv7, type PlatformId } from '@aia/shared';
import type { DatabaseHandle } from '../client';
import {
  manualPackages,
  platformAccounts,
  projectPlatforms,
  publicationAttempts,
  publications,
} from '../schema';

export interface PlatformAccountRecord {
  id: string;
  projectId: string;
  platform: PlatformId;
  accountLabel: string;
  remoteAccountId: string | null;
  connectionState: string;
  capabilities: unknown;
  /**
   * **Les jetons chiffrés ne sortent d'ici que pour le connecteur** (étape 8).
   * Ils sont rendus sous leur forme d'enveloppe `enc:v1:…` : le déchiffrement
   * appartient à `@aia/config`, au dernier moment, et nulle part ailleurs — un
   * dépôt qui rendrait un jeton en clair ferait fuiter un secret dans chaque
   * `console.log` d'un objet de ligne.
   */
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenKeyVersion: number;
  tokenExpiresAt: number | null;
  scopes: string[];
  lastError: string | null;
  rateLimitResetAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ManualPackageRecord {
  id: string;
  contentItemId: string;
  contentVersionId: string;
  platform: PlatformId;
  body: string;
  title: string | null;
  copyBlocks: Record<string, unknown>;
  assetPaths: string[];
  instructions: string | null;
  deepLink: string | null;
  markedPublishedAt: number | null;
  createdAt: number;
}

function decode(raw: string | null, fallback: unknown): unknown {
  if (!raw) return fallback;
  const parsed = parseJsonUnknown(raw);
  return parsed.ok ? parsed.value : fallback;
}

/** Statuts d'une publication : la machine à états de docs/03 §11.2, sans exception. */
export const PUBLICATION_STATUSES = [
  'planned',
  'queued',
  'publishing',
  'published',
  'failed',
  'ambiguous',
  'manual_required',
  'cancelled',
] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/** Résultat d'une tentative : les neuf issues de docs/03 §11.3. */
export const ATTEMPT_OUTCOMES = [
  'success',
  'rate_limited',
  'auth_error',
  'validation_error',
  'server_error',
  'timeout',
  'network_error',
  'ambiguous',
  'rejected_by_platform',
] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export interface PublicationRecord {
  id: string;
  projectId: string;
  contentItemId: string;
  contentVersionId: string;
  platformAccountId: string;
  platform: PlatformId;
  status: PublicationStatus;
  scheduledFor: number | null;
  /** Généré **en local** : il sert à la vérification après échec quand la plateforme ne l'accepte pas. */
  idempotencyKey: string;
  remoteId: string | null;
  remoteUrl: string | null;
  remoteStatus: string | null;
  manualPackageId: string | null;
  firstAttemptAt: number | null;
  publishedAt: number | null;
  lastAttemptAt: number | null;
  attemptCount: number;
  needsHumanDecision: boolean;
  decisionNote: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PublicationAttemptRecord {
  id: string;
  publicationId: string;
  attemptNumber: number;
  startedAt: number;
  finishedAt: number | null;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  request: unknown;
  response: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number | null;
}

function toPublication(row: typeof publications.$inferSelect): PublicationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    contentItemId: row.content_item_id,
    contentVersionId: row.content_version_id,
    platformAccountId: row.platform_account_id,
    platform: row.platform as PlatformId,
    status: row.status as PublicationStatus,
    scheduledFor: row.scheduled_for,
    idempotencyKey: row.idempotency_key,
    remoteId: row.remote_id,
    remoteUrl: row.remote_url,
    remoteStatus: row.remote_status,
    manualPackageId: row.manual_package_id,
    firstAttemptAt: row.first_attempt_at,
    publishedAt: row.published_at,
    lastAttemptAt: row.last_attempt_at,
    attemptCount: row.attempt_count,
    needsHumanDecision: row.needs_human_decision,
    decisionNote: row.decision_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAttempt(row: typeof publicationAttempts.$inferSelect): PublicationAttemptRecord {
  return {
    id: row.id,
    publicationId: row.publication_id,
    attemptNumber: row.attempt_number,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as AttemptOutcome,
    httpStatus: row.http_status,
    request: decode(row.request_json, null),
    response: decode(row.response_json, null),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    durationMs: row.duration_ms,
  };
}

export function createPublishingStore(handle: DatabaseHandle, nowMs: () => number) {
  const newId = (): string => uuidv7(nowMs());
  const toAccount = (row: typeof platformAccounts.$inferSelect): PlatformAccountRecord => ({
    id: row.id,
    projectId: row.project_id,
    platform: row.platform as PlatformId,
    accountLabel: row.account_label,
    remoteAccountId: row.remote_account_id,
    connectionState: row.connection_state,
    capabilities: decode(row.capabilities_json, {}),
    accessTokenEncrypted: row.access_token_encrypted,
    refreshTokenEncrypted: row.refresh_token_encrypted,
    tokenKeyVersion: row.token_key_version,
    tokenExpiresAt: row.token_expires_at,
    scopes: decode(row.scopes_json, []) as string[],
    lastError: row.last_error,
    rateLimitResetAt: row.rate_limit_reset_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  const toPackage = (row: typeof manualPackages.$inferSelect): ManualPackageRecord => ({
    id: row.id,
    contentItemId: row.content_item_id,
    contentVersionId: row.content_version_id,
    platform: row.platform as PlatformId,
    body: row.body_text,
    title: row.title_text,
    copyBlocks: decode(row.copy_blocks_json, {}) as Record<string, unknown>,
    assetPaths: decode(row.asset_paths_json, []) as string[],
    instructions: row.instructions,
    deepLink: row.deep_link,
    markedPublishedAt: row.marked_published_at,
    createdAt: row.created_at,
  });

  return {
    listAccounts(projectId: string): PlatformAccountRecord[] {
      return handle.db
        .select()
        .from(platformAccounts)
        .where(eq(platformAccounts.project_id, projectId))
        .orderBy(asc(platformAccounts.created_at))
        .all()
        .map(toAccount);
    },
    getAccount(id: string): PlatformAccountRecord | null {
      const row = handle.db
        .select()
        .from(platformAccounts)
        .where(eq(platformAccounts.id, id))
        .get();
      return row ? toAccount(row) : null;
    },
    /** Le compte d'un projet pour une plateforme : sert de repli quand l'appelant n'en désigne aucun. */
    listProjectAccounts(projectId: string, platform: PlatformId): PlatformAccountRecord[] {
      return handle.db
        .select()
        .from(platformAccounts)
        .where(
          and(eq(platformAccounts.project_id, projectId), eq(platformAccounts.platform, platform)),
        )
        .orderBy(asc(platformAccounts.created_at))
        .all()
        .map(toAccount);
    },
    /**
     * Écrit le résultat d'un parcours OAuth : jetons **chiffrés**, portées
     * réellement accordées, expiration telle que la plateforme l'annonce.
     *
     * Rien de tout cela n'est deviné : `expiresAt` vient de `expires_in` de la
     * réponse, et les portées viennent de la réponse quand elle les fournit —
     * demander une portée n'est pas l'obtenir, et c'est la différence qui explique
     * un 403 trois semaines plus tard (docs/06 §10.3).
     */
    saveAccountAuthorization(input: {
      accountId: string;
      accessTokenEncrypted: string;
      refreshTokenEncrypted: string | null;
      tokenExpiresAt: number | null;
      scopes: string[];
      remoteAccountId: string | null;
      capabilities: unknown;
    }): PlatformAccountRecord {
      const now = nowMs();
      handle.db
        .update(platformAccounts)
        .set({
          access_token_encrypted: input.accessTokenEncrypted,
          refresh_token_encrypted: input.refreshTokenEncrypted,
          token_expires_at: input.tokenExpiresAt,
          scopes_json: encodeJson(input.scopes),
          remote_account_id: input.remoteAccountId,
          capabilities_json: encodeJson(input.capabilities),
          connection_state: 'connected',
          last_ok_at: now,
          last_error: null,
          updated_at: now,
        })
        .where(eq(platformAccounts.id, input.accountId))
        .run();
      return this.getAccount(input.accountId)!;
    },
    /** `rate_limited` **reporte**, il n'annule pas : la date de reprise est conservée (docs/06 §10.1). */
    setAccountState(input: {
      accountId: string;
      state: 'connected' | 'expired' | 'revoked' | 'disconnected' | 'rate_limited';
      error?: string | null;
      rateLimitResetAt?: number | null;
    }): PlatformAccountRecord {
      const now = nowMs();
      const patch: Record<string, unknown> = {
        connection_state: input.state,
        last_error: input.error ?? null,
        updated_at: now,
      };
      if (input.state === 'connected') patch.last_ok_at = now;
      if (input.rateLimitResetAt !== undefined) {
        patch.rate_limit_reset_at = input.rateLimitResetAt;
        patch.last_rate_limit_at = now;
      }
      handle.db
        .update(platformAccounts)
        .set(patch)
        .where(eq(platformAccounts.id, input.accountId))
        .run();
      return this.getAccount(input.accountId)!;
    },
    createAccount(input: {
      projectId: string;
      platform: PlatformId;
      accountLabel: string;
      remoteAccountId: string | null;
      accessTokenEncrypted: string | null;
      refreshTokenEncrypted: string | null;
      capabilities: unknown;
    }): PlatformAccountRecord {
      const id = newId();
      const now = nowMs();
      handle.db
        .insert(platformAccounts)
        .values({
          id,
          project_id: input.projectId,
          platform: input.platform,
          account_label: input.accountLabel,
          remote_account_id: input.remoteAccountId,
          access_token_encrypted: input.accessTokenEncrypted,
          refresh_token_encrypted: input.refreshTokenEncrypted,
          token_key_version: 1,
          scopes_json: encodeJson([]),
          capabilities_json: encodeJson(input.capabilities),
          connection_state: 'disconnected',
          created_at: now,
          updated_at: now,
        })
        .run();
      handle.db
        .insert(projectPlatforms)
        .values({
          id: newId(),
          project_id: input.projectId,
          platform: input.platform,
          enabled: true,
          priority: 0,
          purposes_json: encodeJson([]),
          cadence_per_week: null,
          default_account_id: id,
          created_at: now,
        })
        .onConflictDoUpdate({
          target: [projectPlatforms.project_id, projectPlatforms.platform],
          set: { enabled: true, default_account_id: id },
        })
        .run();
      return this.getAccount(id)!;
    },
    getManualPackage(id: string): ManualPackageRecord | null {
      const row = handle.db.select().from(manualPackages).where(eq(manualPackages.id, id)).get();
      return row ? toPackage(row) : null;
    },
    upsertManualPackage(input: {
      contentItemId: string;
      contentVersionId: string;
      platform: PlatformId;
      body: string;
      title: string | null;
      copyBlocks: Record<string, unknown>;
      assetPaths: string[];
      instructions: string;
      deepLink: string | null;
    }): ManualPackageRecord {
      const existing = handle.db
        .select()
        .from(manualPackages)
        .where(
          and(
            eq(manualPackages.content_version_id, input.contentVersionId),
            eq(manualPackages.platform, input.platform),
          ),
        )
        .get();
      if (existing) return toPackage(existing);
      const id = newId();
      handle.db
        .insert(manualPackages)
        .values({
          id,
          content_item_id: input.contentItemId,
          content_version_id: input.contentVersionId,
          platform: input.platform,
          body_text: input.body,
          title_text: input.title,
          copy_blocks_json: encodeJson(input.copyBlocks),
          asset_paths_json: encodeJson(input.assetPaths),
          instructions: input.instructions,
          deep_link: input.deepLink,
          created_at: nowMs(),
        })
        .run();
      return this.getManualPackage(id)!;
    },
    markPublished(input: {
      packageId: string;
      projectId: string;
      contentItemId: string;
      contentVersionId: string;
      platform: PlatformId;
      platformAccountId: string;
      idempotencyKey: string;
      exactRequest: Record<string, unknown>;
    }): { publicationId: string; publishedAt: number } {
      const existing = handle.db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.content_version_id, input.contentVersionId),
            eq(publications.platform_account_id, input.platformAccountId),
          ),
        )
        .get();
      if (existing?.published_at)
        return { publicationId: existing.id, publishedAt: existing.published_at };
      const now = nowMs();
      const publicationId = existing?.id ?? newId();
      handle.sqlite.transaction(() => {
        if (!existing) {
          handle.db
            .insert(publications)
            .values({
              id: publicationId,
              project_id: input.projectId,
              content_item_id: input.contentItemId,
              content_version_id: input.contentVersionId,
              platform_account_id: input.platformAccountId,
              platform: input.platform,
              status: 'published',
              idempotency_key: input.idempotencyKey,
              remote_status: 'manual_confirmed',
              manual_package_id: input.packageId,
              first_attempt_at: now,
              published_at: now,
              last_attempt_at: now,
              attempt_count: 1,
              created_at: now,
              updated_at: now,
            })
            .run();
        }
        handle.db
          .insert(publicationAttempts)
          .values({
            id: newId(),
            publication_id: publicationId,
            attempt_number: 1,
            started_at: now,
            finished_at: now,
            outcome: 'success',
            request_json: encodeJson(input.exactRequest),
            response_json: encodeJson({ confirmedByUser: true }),
            duration_ms: 0,
            created_at: now,
          })
          .run();
        handle.db
          .update(manualPackages)
          .set({ marked_published_at: now })
          .where(eq(manualPackages.id, input.packageId))
          .run();
      })();
      return { publicationId, publishedAt: now };
    },

    // --- Cycle de vie des publications (étape 8) ----------------------------

    getPublication(id: string): PublicationRecord | null {
      const row = handle.db.select().from(publications).where(eq(publications.id, id)).get();
      return row ? toPublication(row) : null;
    },
    /** `uq_publication_version_account` : c'est **la** contrainte qui rend un doublon impossible. */
    getPublicationForVersionAccount(
      contentVersionId: string,
      platformAccountId: string,
    ): PublicationRecord | null {
      const row = handle.db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.content_version_id, contentVersionId),
            eq(publications.platform_account_id, platformAccountId),
          ),
        )
        .get();
      return row ? toPublication(row) : null;
    },
    listByContentItem(contentItemId: string): PublicationRecord[] {
      return handle.db
        .select()
        .from(publications)
        .where(eq(publications.content_item_id, contentItemId))
        .orderBy(asc(publications.created_at))
        .all()
        .map(toPublication);
    },
    listByProject(projectId: string): PublicationRecord[] {
      return handle.db
        .select()
        .from(publications)
        .where(eq(publications.project_id, projectId))
        .orderBy(desc(publications.created_at))
        .all()
        .map(toPublication);
    },
    /**
     * Les publications **échues et publiables** : c'est la requête n° 3 de
     * docs/03 §15.3, servie par `idx_publications_schedule`.
     *
     * `needs_human_decision = 0` **est dans la requête**, pas dans un `if` après
     * coup : une publication ambiguë ne doit pas pouvoir être ramassée par un
     * ramasseur qui aurait oublié de filtrer (docs/03 §15.1).
     */
    listDue(now: number): PublicationRecord[] {
      return handle.db
        .select()
        .from(publications)
        .where(
          and(
            eq(publications.status, 'planned'),
            eq(publications.needs_human_decision, false),
            or(isNull(publications.scheduled_for), lte(publications.scheduled_for, now)),
          ),
        )
        .orderBy(asc(publications.scheduled_for))
        .all()
        .map(toPublication);
    },
    /**
     * Crée la ligne, ou **rend celle qui existe déjà** : deux clics sur
     * « publier » ne créent pas deux publications du même (version, compte).
     */
    ensurePublication(input: {
      projectId: string;
      contentItemId: string;
      contentVersionId: string;
      platformAccountId: string;
      platform: PlatformId;
      idempotencyKey: string;
      scheduledFor?: number | null;
      status?: PublicationStatus;
    }): { publication: PublicationRecord; created: boolean } {
      const existing = this.getPublicationForVersionAccount(
        input.contentVersionId,
        input.platformAccountId,
      );
      if (existing) return { publication: existing, created: false };
      const now = nowMs();
      const id = newId();
      handle.db
        .insert(publications)
        .values({
          id,
          project_id: input.projectId,
          content_item_id: input.contentItemId,
          content_version_id: input.contentVersionId,
          platform_account_id: input.platformAccountId,
          platform: input.platform,
          status: input.status ?? 'planned',
          scheduled_for: input.scheduledFor ?? null,
          idempotency_key: input.idempotencyKey,
          created_at: now,
          updated_at: now,
        })
        .run();
      return { publication: this.getPublication(id)!, created: true };
    },
    /**
     * **Le verrou de publication.** Un seul appelant peut passer de
     * `planned`/`queued` à `publishing` : le `UPDATE … WHERE status IN (…)` est
     * conditionnel, donc deux jobs concurrents ne peuvent pas tous les deux
     * obtenir le droit de publier. C'est la seconde barrière — la première étant
     * `uq_publication_version_account` — et elle est **atomique**, pas
     * applicative.
     *
     * Un statut `publishing` **n'est pas repris ici** : si le processus est mort
     * après l'envoi, on ne sait pas si le contenu est parti. Le handler traite ce
     * cas comme une ambiguïté (`verifyPublished()` puis décision humaine), jamais
     * comme une reprise.
     */
    claimForPublish(
      id: string,
      options: { allowRetryOfFailed?: boolean } = {},
    ): { claimed: boolean; publication: PublicationRecord | null } {
      const now = nowMs();
      const claimable: PublicationStatus[] = options.allowRetryOfFailed
        ? ['planned', 'queued', 'failed']
        : ['planned', 'queued'];
      const result = handle.db
        .update(publications)
        .set({
          status: 'publishing',
          attempt_count: sql`${publications.attempt_count} + 1`,
          first_attempt_at: sql`coalesce(${publications.first_attempt_at}, ${now})`,
          last_attempt_at: now,
          updated_at: now,
        })
        .where(
          and(
            eq(publications.id, id),
            inArray(publications.status, claimable),
            eq(publications.needs_human_decision, false),
          ),
        )
        .run();
      return { claimed: result.changes > 0, publication: this.getPublication(id) };
    },
    /** Écrit l'état **distant** d'une publication : c'est la table qui le porte (docs/03 §11.2). */
    settlePublication(
      id: string,
      patch: {
        status: PublicationStatus;
        remoteId?: string | null;
        remoteUrl?: string | null;
        remoteStatus?: string | null;
        needsHumanDecision?: boolean;
        decisionNote?: string | null;
        publishedAt?: number | null;
        scheduledFor?: number | null;
      },
    ): PublicationRecord {
      const now = nowMs();
      const update: Record<string, unknown> = { status: patch.status, updated_at: now };
      if (patch.remoteId !== undefined) update.remote_id = patch.remoteId;
      if (patch.remoteUrl !== undefined) update.remote_url = patch.remoteUrl;
      if (patch.remoteStatus !== undefined) update.remote_status = patch.remoteStatus;
      if (patch.needsHumanDecision !== undefined) {
        update.needs_human_decision = patch.needsHumanDecision;
      }
      if (patch.decisionNote !== undefined) update.decision_note = patch.decisionNote;
      if (patch.scheduledFor !== undefined) update.scheduled_for = patch.scheduledFor;
      if (patch.publishedAt !== undefined) update.published_at = patch.publishedAt;
      handle.db.update(publications).set(update).where(eq(publications.id, id)).run();
      return this.getPublication(id)!;
    },
    /** Une tentative = une ligne, numérotée dans l'ordre, jamais réécrite (docs/03 §11.3). */
    recordAttempt(input: {
      publicationId: string;
      outcome: AttemptOutcome;
      startedAt: number;
      httpStatus?: number | null;
      request?: unknown;
      response?: unknown;
      errorCode?: string | null;
      errorMessage?: string | null;
      durationMs?: number | null;
    }): PublicationAttemptRecord {
      const now = nowMs();
      const total = handle.db
        .select({ value: count() })
        .from(publicationAttempts)
        .where(eq(publicationAttempts.publication_id, input.publicationId))
        .get();
      const id = newId();
      handle.db
        .insert(publicationAttempts)
        .values({
          id,
          publication_id: input.publicationId,
          attempt_number: (total?.value ?? 0) + 1,
          started_at: input.startedAt,
          finished_at: now,
          outcome: input.outcome,
          http_status: input.httpStatus ?? null,
          request_json: input.request === undefined ? null : encodeJson(input.request),
          response_json: input.response === undefined ? null : encodeJson(input.response),
          error_code: input.errorCode ?? null,
          error_message: input.errorMessage ?? null,
          duration_ms: input.durationMs ?? null,
          created_at: now,
        })
        .run();
      const row = handle.db
        .select()
        .from(publicationAttempts)
        .where(eq(publicationAttempts.id, id))
        .get();
      return toAttempt(row!);
    },
    listAttempts(publicationId: string): PublicationAttemptRecord[] {
      return handle.db
        .select()
        .from(publicationAttempts)
        .where(eq(publicationAttempts.publication_id, publicationId))
        .orderBy(asc(publicationAttempts.attempt_number))
        .all()
        .map(toAttempt);
    },
    /** Reste-t-il une publication non réglée pour ce contenu ? (état du contenu, étape 8) */
    countUnsettledByItem(contentItemId: string): number {
      const row = handle.db
        .select({ value: count() })
        .from(publications)
        .where(
          and(
            eq(publications.content_item_id, contentItemId),
            notInArray(publications.status, ['published', 'manual_required', 'cancelled']),
          ),
        )
        .get();
      return row?.value ?? 0;
    },
  };
}
