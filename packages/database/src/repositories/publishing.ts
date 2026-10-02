import { and, asc, eq } from 'drizzle-orm';
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
  };
}
