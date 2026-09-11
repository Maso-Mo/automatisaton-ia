/**
 * Client REST typé de l'écran de diagnostic **et** de la mémoire des projets.
 *
 * `apps/web` ne dépend que de `apps/api` (docs/02 §4) : aucun import de paquet
 * du domaine, aucune connaissance de la base. Le vocabulaire (catégories,
 * états, libellés) est **servi par l'API** — c'est ce qui empêche l'interface
 * d'inventer une valeur que le domaine refuse.
 */
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

// --- Mémoire des projets (étape 2) -----------------------------------------

export interface VocabularyOption {
  value: string;
  label: string;
  /** États suivants autorisés par le domaine (affichés, jamais devinés). */
  next?: string[];
}

export interface ProjectsVocabulary {
  projectStatuses: VocabularyOption[];
  factCategories: VocabularyOption[];
  factSources: VocabularyOption[];
  factVerificationStatuses: VocabularyOption[];
  knowledgeCategories: string[];
  limits: {
    factStatementMaxLength: number;
    factDetailMaxLength: number;
    recencyHalfLifeDays: number;
  };
}

export interface ProjectView {
  id: string;
  name: string;
  slug: string;
  positioning: string | null;
  status: string;
  targetGoal: string | null;
  startDate: number | null;
  language: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface ProjectFactView {
  id: string;
  projectId: string;
  category: string;
  statement: string;
  detail: string | null;
  source: string;
  verificationStatus: string;
  verificationNote: string | null;
  verifiedAt: number | null;
  importance: number;
  usedCount: number;
  supersedesFactId: string | null;
  supersededByFactId: string | null;
  supersededAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface FactSummary {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  trusted: number;
}

export interface ProjectContextView {
  projectId: string;
  projectName: string;
  generatedAt: number;
  facts: Array<{ fact: ProjectFactView; score: number }>;
  excluded: { unverified: number; inactive: number; filtered: number };
  missingCategories: string[];
}

export interface ProjectDetail {
  project: ProjectView;
  summary: FactSummary;
  context: ProjectContextView;
}

export interface ProjectInput {
  name: string;
  positioning?: string | null;
  targetGoal?: string | null;
  description?: string | null;
}

export interface FactInput {
  category: string;
  statement: string;
  detail?: string | null;
  importance?: number;
}

// --- Conversation et fiche maître (étape 3) --------------------------------

export interface ConversationView {
  id: string;
  projectId: string;
  title: string | null;
  kind: string;
  stage: string;
  missingSlots: string[];
  modelUsed: string | null;
  messageCount: number;
  lastMessageAt: number | null;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

/** Proposition d'écriture : rien n'est écrit tant qu'elle n'est pas acceptée. */
export interface PlanProposalView {
  id: string;
  status: 'pending' | 'accepted' | 'rejected';
  sourceQuote: string;
  rejectedReason: string | null;
  category?: string;
  statement?: string;
  skill?: string;
  level?: string;
  name?: string;
  positioning?: string | null;
  targetGoal?: string | null;
}

export interface EditPlanView {
  assistantMessageId: string;
  sourceMessageId: string;
  reply: string;
  suggestedNext: 'continue' | 'make_brief';
  openQuestions: string[];
  facts: PlanProposalView[];
  skills: PlanProposalView[];
  projectEdits: PlanProposalView[];
  audiences: PlanProposalView[];
  styles: PlanProposalView[];
}

export interface MessageView {
  id: string;
  conversationId: string;
  role: string;
  content: string | null;
  contentJson: { plan?: EditPlanView } | null;
  messageType: string;
  agent: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costMicroUsd: number;
  createdAt: number;
}

export interface MasterBriefView {
  id: string;
  projectId: string;
  conversationId: string;
  version: number;
  status: string;
  summary: string;
  positioning: string;
  targetAudience: string;
  contentPillars: string[];
  themes: string[];
  formats: Array<{ platform: string; formats: string[] }> | null;
  skillMap: Array<{ skill: string; level: string; isLearning: boolean }> | null;
  gaps: string[] | null;
  cadence: Array<{ platform: string; perWeek: number }> | null;
  successCriteria: string[] | null;
  validatedAt: number | null;
}

export interface ConversationDetail {
  conversation: ConversationView;
  messages: MessageView[];
  briefs: MasterBriefView[];
  nextSlot: string | null;
  slotLabels: Record<string, string>;
}

export interface TurnResponse {
  conversation: ConversationView;
  userMessage: MessageView;
  message: MessageView;
  plan: EditPlanView;
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number; model: string };
  repaired: boolean;
}

export interface BriefDetailResponse {
  brief: MasterBriefView;
  missing: string[];
  history: MasterBriefView[];
}

export interface BriefInput {
  summary?: string;
  positioning?: string;
  targetAudience?: string;
  contentPillars?: string[];
  themes?: string[];
  gaps?: string[] | null;
  successCriteria?: string[] | null;
}

async function getJson<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    const suffix = body?.error?.code ? ` (${body.error.code})` : '';
    throw new Error((body?.error?.message ?? `Requête refusée (${response.status})`) + suffix);
  }
  return (await response.json()) as T;
}

/** Sérialise un corps JSON, en retirant les valeurs `undefined`. */
function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function patchJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

function queryString(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length > 0 ? `?${rendered}` : '';
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

  // --- Mémoire des projets (étape 2) --------------------------------------
  projectsVocabulary: () => getJson<ProjectsVocabulary>('/projects/vocabulary'),
  projects: (params: { includeArchived?: boolean; status?: string } = {}) =>
    getJson<{ projects: ProjectView[] }>(`/projects${queryString(params)}`),
  project: (id: string) => getJson<ProjectDetail>('/projects/' + encodeURIComponent(id)),
  createProject: (body: ProjectInput) => postJson<{ project: ProjectView }>('/projects', body),
  updateProject: (id: string, body: Partial<ProjectInput> & { status?: string }) =>
    patchJson<{ project: ProjectView }>(`/projects/${encodeURIComponent(id)}`, body),
  archiveProject: (id: string) =>
    postJson<{ project: ProjectView }>(`/projects/${encodeURIComponent(id)}/archive`, {}),
  projectFacts: (
    id: string,
    params: {
      category?: string;
      status?: string;
      since?: number;
      until?: number;
      includeInactive?: boolean;
      limit?: number;
    } = {},
  ) =>
    getJson<{ facts: ProjectFactView[]; summary: FactSummary }>(
      `/projects/${encodeURIComponent(id)}/facts${queryString(params)}`,
    ),
  addFact: (id: string, body: FactInput) =>
    postJson<{ fact: ProjectFactView }>(`/projects/${encodeURIComponent(id)}/facts`, body),
  updateFact: (id: string, factId: string, body: Partial<FactInput>) =>
    patchJson<{ fact: ProjectFactView }>(
      `/projects/${encodeURIComponent(id)}/facts/${encodeURIComponent(factId)}`,
      body,
    ),
  setFactVerification: (
    id: string,
    factId: string,
    body: { status: string; note?: string | null },
  ) =>
    postJson<{ fact: ProjectFactView }>(
      `/projects/${encodeURIComponent(id)}/facts/${encodeURIComponent(factId)}/verification`,
      body,
    ),
  replaceFact: (id: string, factId: string, body: FactInput & { note?: string | null }) =>
    postJson<{ superseded: ProjectFactView; replacement: ProjectFactView }>(
      `/projects/${encodeURIComponent(id)}/facts/${encodeURIComponent(factId)}/replacement`,
      body,
    ),
  projectContext: (
    id: string,
    params: {
      category?: string;
      status?: string;
      includeUnverified?: boolean;
      limit?: number;
    } = {},
  ) =>
    getJson<ProjectContextView>(
      `/projects/${encodeURIComponent(id)}/context${queryString(params)}`,
    ),

  // --- Conversation et fiche maître (étape 3) -----------------------------
  conversations: (params: { projectId?: string } = {}) =>
    getJson<{ conversations: ConversationView[] }>(`/conversations${queryString(params)}`),
  createConversation: (body: { projectId: string; kind?: string }) =>
    postJson<{ conversation: ConversationView }>('/conversations', body),
  conversation: (id: string) =>
    getJson<ConversationDetail>(`/conversations/${encodeURIComponent(id)}`),
  /** Un tour complet : le message de l'assistant arrive avec son plan d'écriture. */
  sendMessage: (id: string, body: { content: string }) =>
    postJson<TurnResponse>(`/conversations/${encodeURIComponent(id)}/messages`, body),
  /** Le seul chemin d'écriture en mémoire : accepter des propositions. */
  applyProposals: (
    id: string,
    messageId: string,
    body: { accept: string[]; confirmFacts?: boolean },
  ) =>
    postJson<{ conversation: ConversationView; refused: Array<{ reason: string }> }>(
      `/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/proposals`,
      body,
    ),
  closeConversation: (id: string) =>
    postJson<{ conversation: ConversationView }>(`/conversations/${encodeURIComponent(id)}/close`, {
      closed: true,
    }),
  reopenConversation: (id: string) =>
    postJson<{ conversation: ConversationView }>(
      `/conversations/${encodeURIComponent(id)}/reopen`,
      {},
    ),
  /** Génération explicite : aucune fiche ne se produit pendant un tour. */
  generateBrief: (id: string) =>
    postJson<{ brief: MasterBriefView; missing: string[]; usage: { costMicroUsd: number } }>(
      `/conversations/${encodeURIComponent(id)}/brief`,
      {},
    ),
  brief: (briefId: string) =>
    getJson<BriefDetailResponse>(`/briefs/${encodeURIComponent(briefId)}`),
  updateBrief: (briefId: string, body: BriefInput) =>
    patchJson<{ brief: MasterBriefView; missing: string[] }>(
      `/briefs/${encodeURIComponent(briefId)}`,
      body,
    ),
  validateBrief: (briefId: string) =>
    postJson<{ brief: MasterBriefView }>(`/briefs/${encodeURIComponent(briefId)}/validation`, {}),
  projectBrief: (projectId: string) =>
    getJson<{ brief: MasterBriefView | null }>(`/projects/${encodeURIComponent(projectId)}/brief`),
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
