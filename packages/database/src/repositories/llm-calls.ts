import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { DatabaseHandle } from '../client';
import { llmCalls } from '../schema';

/**
 * `llm_calls` : **chaque** appel à un modèle, sans exception (docs/03 §14.3).
 * Un appel non journalisé est un bug. Le coût est écrit même en cas d'erreur
 * partielle : un appel qui timeout après 40 000 jetons a bel et bien coûté.
 */

export type LlmCallRow = typeof llmCalls.$inferSelect;

export interface InsertLlmCallInput {
  id: string;
  jobId?: string | null;
  projectId?: string | null;
  conversationId?: string | null;
  contentItemId?: string | null;
  agent: string | null;
  task: string;
  provider: string;
  model: string;
  promptVersionId?: string | null;
  contextFingerprint?: string | null;
  requestJson: string;
  responseJson?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  totalTokens?: number | null;
  costMicroUsd: number;
  latencyMs?: number | null;
  ttftMs?: number | null;
  status: LlmCallRow['status'];
  errorCode?: string | null;
  finishReason?: string | null;
  temperatureX100?: number | null;
  now: number;
}

export function insertLlmCall(handle: DatabaseHandle, input: InsertLlmCallInput): void {
  handle.db
    .insert(llmCalls)
    .values({
      id: input.id,
      job_id: input.jobId ?? null,
      project_id: input.projectId ?? null,
      conversation_id: input.conversationId ?? null,
      content_item_id: input.contentItemId ?? null,
      agent: input.agent,
      task: input.task,
      provider: input.provider,
      model: input.model,
      prompt_version_id: input.promptVersionId ?? null,
      context_fingerprint: input.contextFingerprint ?? null,
      request_json: input.requestJson,
      response_json: input.responseJson ?? null,
      prompt_tokens: input.promptTokens ?? null,
      completion_tokens: input.completionTokens ?? null,
      cached_tokens: input.cachedTokens ?? null,
      total_tokens: input.totalTokens ?? null,
      cost_micro_usd: input.costMicroUsd,
      latency_ms: input.latencyMs ?? null,
      ttft_ms: input.ttftMs ?? null,
      status: input.status,
      error_code: input.errorCode ?? null,
      finish_reason: input.finishReason ?? null,
      temperature_x100: input.temperatureX100 ?? null,
      created_at: input.now,
    })
    .run();
}

export interface SpendFilter {
  task?: string;
  projectId?: string;
  jobId?: string;
  /** Exclut les appels en erreur : utile pour ne mesurer que le coût utile. */
  onlySuccess?: boolean;
}

/** Somme des coûts depuis une borne — la seule requête de suivi de budget (docs/08 §8.1). */
export function spendMicroUsdSince(
  handle: DatabaseHandle,
  sinceMs: number,
  filter: SpendFilter = {},
): number {
  const row = handle.db
    .select({ spent: sql<number>`coalesce(sum(${llmCalls.cost_micro_usd}), 0)` })
    .from(llmCalls)
    .where(and(gte(llmCalls.created_at, sinceMs), ...filterConditions(filter)))
    .get();
  return row?.spent ?? 0;
}

export interface TokenTotals {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export function tokenTotalsSince(handle: DatabaseHandle, sinceMs: number): TokenTotals {
  const row = handle.db
    .select({
      promptTokens: sql<number>`coalesce(sum(${llmCalls.prompt_tokens}), 0)`,
      completionTokens: sql<number>`coalesce(sum(${llmCalls.completion_tokens}), 0)`,
      cachedTokens: sql<number>`coalesce(sum(${llmCalls.cached_tokens}), 0)`,
      totalTokens: sql<number>`coalesce(sum(${llmCalls.total_tokens}), 0)`,
    })
    .from(llmCalls)
    .where(gte(llmCalls.created_at, sinceMs))
    .get();
  return {
    promptTokens: row?.promptTokens ?? 0,
    completionTokens: row?.completionTokens ?? 0,
    cachedTokens: row?.cachedTokens ?? 0,
    totalTokens: row?.totalTokens ?? 0,
  };
}

export function countLlmCallsSince(handle: DatabaseHandle, sinceMs: number): number {
  const row = handle.db
    .select({ total: sql<number>`count(*)` })
    .from(llmCalls)
    .where(gte(llmCalls.created_at, sinceMs))
    .get();
  return row?.total ?? 0;
}

export function listRecentLlmCalls(handle: DatabaseHandle, limit = 20): LlmCallRow[] {
  return handle.db.select().from(llmCalls).orderBy(desc(llmCalls.created_at)).limit(limit).all();
}

function filterConditions(filter: SpendFilter) {
  const conditions = [];
  if (filter.task) conditions.push(eq(llmCalls.task, filter.task));
  if (filter.projectId) conditions.push(eq(llmCalls.project_id, filter.projectId));
  if (filter.jobId) conditions.push(eq(llmCalls.job_id, filter.jobId));
  if (filter.onlySuccess) conditions.push(eq(llmCalls.status, 'success'));
  return conditions;
}
