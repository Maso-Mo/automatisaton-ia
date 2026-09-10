/** Client REST typé de l'écran de diagnostic. */
export type CheckStatus = 'ok' | 'warn' | 'error';

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface SystemHealth {
  status: 'ok' | 'degraded' | 'blocked';
  generatedAt: number;
  uptimeMs: number;
  app: { name: string; version: string; env: string; host: string; port: number };
  checks: HealthCheck[];
  database: {
    appliedMigrations: number;
    tableCount: number;
    walEnabled: boolean;
    sqliteVersion: string;
  };
  worker: {
    active: boolean;
    lastHeartbeatAt: number | null;
    silenceMs: number | null;
    jobs: Record<string, number>;
  };
  prompts: { total: number; active: number; lastSyncedAt: number | null };
  budget: {
    todayMicroUsd: number;
    todayLimitMicroUsd: number;
    todayCalls: number;
    monthMicroUsd: number;
    monthRatio: number;
    state: 'ok' | 'vigilance' | 'economy' | 'hard_stop';
    alerts: string[];
  };
  lastCompletedJob: {
    id: string;
    type: string;
    finishedAt: number;
    durationMs: number | null;
    costMicroUsd: number;
  } | null;
}

export interface PublicJob {
  id: string;
  type: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  progress: number;
  currentStep: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  costMicroUsd: number;
  error: { message?: string; category?: string } | null;
}

export interface JobsSummary {
  counts: Record<string, number>;
  recent: Array<{
    id: string;
    type: string;
    status: string;
    createdAt: number;
    finishedAt: number | null;
    costMicroUsd: number;
  }>;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`/api${path}`, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Requête refusée (${response.status})`);
  }
  return (await response.json()) as T;
}

export const api = {
  health: () => getJson<SystemHealth>('/system/health'),
  jobsSummary: () => getJson<JobsSummary>('/system/jobs-summary'),
  jobs: (limit = 20) => getJson<{ jobs: PublicJob[] }>(`/jobs?limit=${limit}`),
  job: (id: string) =>
    getJson<{
      job: PublicJob;
      events: Array<{ sequence: number; level: string; step: string | null; message: string }>;
    }>(`/jobs/${id}`),
};

export function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(4)}`;
}

export function formatRelative(ms: number | null): string {
  if (ms === null) return 'jamais';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `il y a ${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `il y a ${minutes} min`;
  return `il y a ${Math.round(minutes / 60)} h`;
}
