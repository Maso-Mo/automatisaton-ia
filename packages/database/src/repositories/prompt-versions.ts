import { and, desc, eq, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../client';
import { promptVersions } from '../schema';

/**
 * Index des prompts versionnés (docs/03 §14.4). Le contenu reste dans Git : la
 * base ne stocke que le chemin, l'empreinte et le commit. Corriger une faute
 * dans un prompt ne réécrit donc jamais l'historique des appels passés.
 */

export type PromptVersionRow = typeof promptVersions.$inferSelect;

export interface UpsertPromptVersionInput {
  id: string;
  agent: string;
  task: string;
  filePath: string;
  contentHash: string;
  versionLabel?: string | null;
  notes?: string | null;
  gitCommit?: string | null;
  now: number;
}

export function findByHash(
  handle: DatabaseHandle,
  agent: string,
  task: string,
  contentHash: string,
): PromptVersionRow | undefined {
  return handle.db
    .select()
    .from(promptVersions)
    .where(
      and(
        eq(promptVersions.agent, agent),
        eq(promptVersions.task, task),
        eq(promptVersions.content_hash, contentHash),
      ),
    )
    .get();
}

export function insertPromptVersion(
  handle: DatabaseHandle,
  input: UpsertPromptVersionInput,
): PromptVersionRow {
  handle.db
    .insert(promptVersions)
    .values({
      id: input.id,
      agent: input.agent,
      task: input.task,
      file_path: input.filePath,
      content_hash: input.contentHash,
      git_commit: input.gitCommit ?? null,
      version_label: input.versionLabel ?? null,
      is_active: true,
      notes: input.notes ?? null,
      created_at: input.now,
    })
    .run();
  const row = findByHash(handle, input.agent, input.task, input.contentHash);
  if (!row) throw new Error(`Prompt introuvable après insertion : ${input.filePath}`);
  return row;
}

/**
 * Une seule version active par couple `(agent, task)` : on éteint les autres
 * au lieu de les supprimer, pour que les appels historiques continuent de
 * pointer vers la version réellement utilisée.
 */
export function deactivateOtherVersions(
  handle: DatabaseHandle,
  agent: string,
  task: string,
  keepId: string,
): number {
  const result = handle.db
    .update(promptVersions)
    .set({ is_active: false })
    .where(
      and(
        eq(promptVersions.agent, agent),
        eq(promptVersions.task, task),
        eq(promptVersions.is_active, true),
        sql`${promptVersions.id} <> ${keepId}`,
      ),
    )
    .run();
  return result.changes;
}

export function listPromptVersions(
  handle: DatabaseHandle,
  filter: { activeOnly?: boolean; limit?: number } = {},
): PromptVersionRow[] {
  const base = handle.db.select().from(promptVersions).orderBy(desc(promptVersions.created_at));
  const filtered = filter.activeOnly ? base.where(eq(promptVersions.is_active, true)) : base;
  return filtered.limit(filter.limit ?? 100).all();
}

export function activePromptVersion(
  handle: DatabaseHandle,
  agent: string,
  task: string,
): PromptVersionRow | undefined {
  return handle.db
    .select()
    .from(promptVersions)
    .where(
      and(
        eq(promptVersions.agent, agent),
        eq(promptVersions.task, task),
        eq(promptVersions.is_active, true),
      ),
    )
    .orderBy(desc(promptVersions.created_at))
    .limit(1)
    .get();
}

export interface PromptSummary {
  total: number;
  active: number;
  lastSyncedAt: number | null;
}

export function promptSummary(handle: DatabaseHandle): PromptSummary {
  const row = handle.db
    .select({
      total: sql<number>`count(*)`,
      active: sql<number>`coalesce(sum(case when ${promptVersions.is_active} = 1 then 1 else 0 end), 0)`,
      lastSyncedAt: sql<number | null>`max(${promptVersions.created_at})`,
    })
    .from(promptVersions)
    .get();
  return {
    total: row?.total ?? 0,
    active: row?.active ?? 0,
    lastSyncedAt: row?.lastSyncedAt ?? null,
  };
}
