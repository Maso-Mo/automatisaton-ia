import { createHash } from 'node:crypto';
import { insertLlmCall, type DatabaseHandle } from '@aia/database';
import { uuidv7, type Clock } from '@aia/shared';
import type { LlmCallStatus } from './provider';

/**
 * Enregistrement des appels : « Chaque appel est **enregistré** dans `llm_calls`
 * avec son `agent`, sa `task` et son coût. Un appel non journalisé est un bug »
 * (docs/02 §9.1).
 *
 * Le port est défini ici, l'implémentation utilise `@aia/database` : le domaine
 * n'en sait rien, et un enregistreur en mémoire suffit pour un test.
 */

export interface LlmCallRecord {
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
  request: unknown;
  response?: unknown;
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  totalTokens?: number | null;
  costMicroUsd: number;
  latencyMs?: number | null;
  ttftMs?: number | null;
  status: LlmCallStatus;
  errorCode?: string | null;
  finishReason?: string | null;
  temperature?: number | null;
}

export interface LlmCallRecorder {
  /** Enregistre l'appel et rend son identifiant : la trace est utilisable. */
  record(entry: LlmCallRecord): string;
}

/** Sérialisation stable : deux contextes identiques donnent la même empreinte. */
export function fingerprintContext(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

export function createLlmCallRecorder(handle: DatabaseHandle, clock: Clock): LlmCallRecorder {
  return {
    record(entry) {
      const id = uuidv7(clock.nowMs());
      insertLlmCall(handle, {
        id,
        jobId: entry.jobId ?? null,
        projectId: entry.projectId ?? null,
        conversationId: entry.conversationId ?? null,
        contentItemId: entry.contentItemId ?? null,
        agent: entry.agent,
        task: entry.task,
        provider: entry.provider,
        model: entry.model,
        promptVersionId: entry.promptVersionId ?? null,
        contextFingerprint: entry.contextFingerprint ?? null,
        requestJson: JSON.stringify(entry.request ?? {}),
        responseJson: entry.response === undefined ? null : JSON.stringify(entry.response),
        promptTokens: entry.promptTokens ?? null,
        completionTokens: entry.completionTokens ?? null,
        cachedTokens: entry.cachedTokens ?? null,
        totalTokens: totalTokensFor(entry),
        costMicroUsd: entry.costMicroUsd,
        latencyMs: entry.latencyMs ?? null,
        ttftMs: entry.ttftMs ?? null,
        status: entry.status,
        errorCode: entry.errorCode ?? null,
        finishReason: entry.finishReason ?? null,
        temperatureX100:
          entry.temperature === null || entry.temperature === undefined
            ? null
            : Math.round(entry.temperature * 100),
        now: clock.nowMs(),
      });
      return id;
    },
  };
}

function totalTokensFor(entry: LlmCallRecord): number | null {
  if (entry.totalTokens !== undefined && entry.totalTokens !== null) return entry.totalTokens;
  const sum = (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0);
  return sum === 0 ? null : sum;
}

export function createInMemoryLlmCallRecorder(): LlmCallRecorder & {
  readonly entries: LlmCallRecord[];
} {
  const entries: LlmCallRecord[] = [];
  return {
    entries,
    record(entry) {
      entries.push(entry);
      return `call-${entries.length}`;
    },
  };
}
