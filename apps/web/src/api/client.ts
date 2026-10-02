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
  inputMode: string | null;
  audioAssetId: string | null;
  transcriptStatus: string | null;
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

export interface MediaAssetView {
  id: string;
  projectId: string | null;
  mimeType: string;
  sizeBytes: number;
  durationMs: number | null;
}

export interface TranscriptView {
  id: string;
  mediaAssetId: string;
  engine: string;
  model: string | null;
  language: string | null;
  text: string;
  editedBody: string | null;
  durationMs: number | null;
  processingMs: number | null;
}

export interface VoiceCapabilities {
  transcription: { available: boolean; engine: string; model: string; detail?: string };
  maxUploadBytes: number;
  maxDurationMs: number;
  acceptedMimeTypes: string[];
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
  await ensureOk(response);
  return (await response.json()) as T;
}

/**
 * Vérifie la réponse et lève **le message de l'API**, qui est la seule source de
 * vérité du refus : catégorie, code et détail viennent du serveur, jamais d'une
 * traduction locale (docs/10 §4).
 */
async function ensureOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string; code?: string };
  } | null;
  const suffix = body?.error?.code ? ` (${body.error.code})` : '';
  throw new Error((body?.error?.message ?? `Requête refusée (${response.status})`) + suffix);
}

/**
 * Suppression sans corps de réponse (`204`) : `request` lit toujours du JSON, et
 * un `204` n'en contient pas — d'où cette variante plutôt qu'un `.catch()`.
 */
async function deleteVoid(path: string): Promise<void> {
  const response = await fetch(`/api${path}`, {
    method: 'DELETE',
    headers: { accept: 'application/json' },
  });
  await ensureOk(response);
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

// --- Revue éditoriale (étape 5) -------------------------------------------
//
// Ces vues décrivent **ce que l'API rend**, pas le domaine : `apps/web` n'importe
// aucun paquet du domaine. Les chaînes (`state`, `generation`, `target`…) sont
// volontairement laissées en `string` : l'écran les affiche via les libellés reçus
// du vocabulaire, jamais par une table recopiée ici.

/** Une cible de génération et ses limites de forme (docs/06 §5, §7). */
export interface EditorialTargetSpec {
  key: string;
  label: string;
  /** En-tête de section de l'écran : « YouTube Short » et « YouTube long » sont deux sections. */
  sectionLabel: string;
  platform: string;
  format: string;
  bodyMaxChars: number;
  bodyTargetChars: number;
  titleMaxChars: number;
  hookMaxChars: number;
  hashtagsMin: number;
  hashtagsMax: number;
  segmentsRequired: boolean;
  shape: string;
  promptFile: string;
}

export interface EditorialVocabulary {
  targets: EditorialTargetSpec[];
  /** `next` est la liste des états autorisés : l'écran explique un refus avant l'appel. */
  contentStates: Array<{ value: string; label: string; next: string[] }>;
  generations: Array<{ value: string; label: string }>;
  noteTypes: Array<{ value: string; label: string }>;
  noteSeverities: Array<{ value: string; label: string }>;
  /**
   * Libellés des sujets et des angles : le plan éditorial les affiche tels quels,
   * sans traduire un code du domaine côté écran.
   */
  subjectStatuses: Array<{ value: string; label: string }>;
  skillCoverages: Array<{ value: string; label: string }>;
  angleTypes: Array<{ value: string; label: string }>;
  limits: { maxRegenerationsPerItem: number };
}

export interface AngleView {
  id: string;
  subjectId: string;
  platform: string;
  hook: string;
  angleType: string;
  structure: string[];
  evidence: string[];
  rationale: string | null;
  score: number | null;
  selected: boolean;
  rejectionReason: string | null;
  createdAt: number;
}

export interface SubjectView {
  id: string;
  projectId: string;
  masterBriefId: string | null;
  conversationId: string | null;
  title: string;
  thesis: string;
  pillar: string | null;
  origin: string;
  status: string;
  skillCoverage: string | null;
  evidence: string[];
  priorityScore: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

export interface SubjectWithAngles {
  subject: SubjectView;
  angles: AngleView[];
}

export interface EditorialPlanResponse {
  subjects: SubjectView[];
  angles: AngleView[];
  accepted: number;
  rejected: Array<{ title?: string; reason: string }>;
  droppedAngles: Array<{ hook?: string; reason: string }>;
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number; model: string };
  repaired: boolean;
}

export interface ContentNoteView {
  id: string;
  contentItemId: string;
  contentVersionId: string | null;
  author: string;
  noteType: string;
  severity: string;
  message: string;
  anchorText: string | null;
  resolved: boolean;
  createdAt: number;
}

export interface ContentClaimView {
  id: string;
  contentVersionId: string;
  claim: string;
  claimType: string;
  verifiability: string;
  evidence: string | null;
  evidenceSource: string;
  risk: string;
  status: string;
  userConfirmedAt: number | null;
  createdAt: number;
}

export interface ContentVersionView {
  id: string;
  contentItemId: string;
  versionNumber: number;
  body: string;
  title: string | null;
  hook: string | null;
  hashtags: string[];
  mentions: string[];
  linkUrl: string | null;
  charCount: number | null;
  wordCount: number | null;
  readingTimeSec: number | null;
  generation: string;
  modelUsed: string | null;
  qualityScore: number | null;
  approvedAt: number | null;
  approvedBy: string | null;
  createdAt: number;
}

export interface ContentItemView {
  id: string;
  projectId: string;
  subjectId: string | null;
  angleId: string | null;
  platform: string;
  target: string;
  format: string;
  title: string | null;
  state: string;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  contentHash: string | null;
  aiGenerated: boolean;
  humanEdited: boolean;
  /** Part du texte changée à la main (0..1) : `null` tant qu'aucune édition n'a eu lieu. */
  editRatio: number | null;
  regeneratedCount: number;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  scheduledFor: number | null;
  publishedAt: number | null;
  archivedAt: number | null;
}

export interface ContentBundleView {
  item: ContentItemView;
  version: ContentVersionView | null;
  notes: ContentNoteView[];
  claims: ContentClaimView[];
}

export interface PlatformAccountView {
  id: string;
  projectId: string;
  platform: string;
  accountLabel: string;
  remoteAccountId: string | null;
  connectionState: string;
  capabilities: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ManualPackageView {
  id: string;
  contentItemId: string;
  contentVersionId: string;
  platform: string;
  body: string;
  title: string | null;
  copyBlocks: Record<string, unknown>;
  assetPaths: string[];
  instructions: string | null;
  deepLink: string | null;
  markedPublishedAt: number | null;
  createdAt: number;
}

export interface ContentHistoryView {
  item: ContentItemView;
  versions: ContentVersionView[];
  currentVersionId: string | null;
  approvedVersionId: string | null;
}

export interface DraftIssueView {
  code: string;
  severity: 'blocking' | 'warning';
  field: string;
  message: string;
}

export interface DraftValidationView {
  target: string;
  ok: boolean;
  blocking: DraftIssueView[];
  warnings: DraftIssueView[];
  stats: {
    charCount: number;
    wordCount: number;
    readingTimeSec: number;
    hashtags: number;
    chapters: number;
  };
}

export interface ContentDetailView {
  content: ContentBundleView;
  history: ContentHistoryView;
  validation: DraftValidationView | null;
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
  voiceCapabilities: () => getJson<VoiceCapabilities>('/media/capabilities'),
  uploadVoice: (id: string, audio: Blob) =>
    request<{ asset: MediaAssetView; jobId: string }>(
      `/conversations/${encodeURIComponent(id)}/voice`,
      {
        method: 'POST',
        body: audio,
        headers: { 'content-type': audio.type || 'application/octet-stream' },
      },
    ),
  voiceTranscript: (id: string, assetId: string) =>
    getJson<{ asset: MediaAssetView; transcript: TranscriptView | null }>(
      `/conversations/${encodeURIComponent(id)}/voice/${encodeURIComponent(assetId)}/transcript`,
    ),
  /**
   * Annuler un enregistrement **non envoyé**. L'API refuse (`409`) un audio déjà
   * rattaché à un message : la preuve de ce qui a été envoyé ne se supprime pas
   * depuis l'écran.
   */
  cancelVoice: (id: string, assetId: string) =>
    deleteVoid(`/conversations/${encodeURIComponent(id)}/voice/${encodeURIComponent(assetId)}`),
  sendVoiceTranscript: (id: string, assetId: string, content: string) =>
    postJson<TurnResponse & { transcript: TranscriptView }>(
      `/conversations/${encodeURIComponent(id)}/voice/${encodeURIComponent(assetId)}/send`,
      { content },
    ),
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

  // --- Revue éditoriale (étape 5) ----------------------------------------
  /**
   * Le vocabulaire de l'écran de revue est **servi par l'API** : cibles et leurs
   * limites, états et transitions autorisées, libellés de version et de remarque,
   * plafond de régénérations. L'interface ne recopie donc jamais une valeur du
   * domaine, et un texte refusé par le serveur peut toujours être expliqué avant
   * l'appel (`canApprove`, `approvalBlockedReason` dans `features/editorial/state`).
   */
  editorialVocabulary: () => getJson<EditorialVocabulary>('/editorial/vocabulary'),
  editorialPlan: (projectId: string) =>
    postJson<EditorialPlanResponse>(`/projects/${encodeURIComponent(projectId)}/plan`, {}),
  projectSubjects: (projectId: string, params: { status?: string; limit?: number } = {}) =>
    getJson<{ subjects: SubjectWithAngles[] }>(
      `/projects/${encodeURIComponent(projectId)}/subjects${queryString(params)}`,
    ),
  selectAngle: (angleId: string, note?: string) =>
    postJson<{ angle: AngleView; subject: SubjectView; angles: AngleView[] }>(
      `/angles/${encodeURIComponent(angleId)}/select`,
      note ? { note } : {},
    ),
  rejectAngle: (angleId: string, reason: string) =>
    postJson<{ angle: AngleView; angles: AngleView[] }>(
      `/angles/${encodeURIComponent(angleId)}/reject`,
      { reason },
    ),
  projectContent: (projectId: string, params: { state?: string; limit?: number } = {}) =>
    getJson<{ content: ContentBundleView[]; targets: string[] }>(
      `/projects/${encodeURIComponent(projectId)}/content${queryString(params)}`,
    ),
  generateContent: (projectId: string, body: { angleId: string; targets: string[] }) =>
    postJson<{ content: ContentBundleView[]; jobId: string }>(
      `/projects/${encodeURIComponent(projectId)}/content`,
      body,
    ),
  /** Régénérer **un** contenu : la cible est celle du contenu, jamais celle du corps. */
  regenerateContent: (contentId: string, instruction?: string) =>
    postJson<{ content: ContentBundleView; jobId: string }>(
      `/content/${encodeURIComponent(contentId)}/regenerate`,
      instruction ? { instruction } : {},
    ),
  contentDetail: (contentId: string) =>
    getJson<ContentDetailView>(`/content/${encodeURIComponent(contentId)}`),
  /** Ouvrir la relecture : c'est cet appel qui autorise l'approbation ensuite. */
  markContentInReview: (contentId: string) =>
    postJson<{ content: ContentBundleView }>(
      `/content/${encodeURIComponent(contentId)}/review`,
      {},
    ),
  editContent: (
    contentId: string,
    body: {
      body: string;
      title?: string | null;
      hook?: string | null;
      hashtags?: string[];
      mentions?: string[];
      author?: string;
    },
  ) => patchJson<{ content: ContentBundleView }>(`/content/${encodeURIComponent(contentId)}`, body),
  approveContent: (contentId: string, approvedBy?: string) =>
    postJson<{ content: ContentBundleView }>(
      `/content/${encodeURIComponent(contentId)}/approve`,
      approvedBy ? { approvedBy } : {},
    ),
  rejectContent: (contentId: string, reason: string, author?: string) =>
    postJson<{ content: ContentBundleView }>(
      `/content/${encodeURIComponent(contentId)}/reject`,
      author ? { reason, author } : { reason },
    ),
  platformAccounts: (projectId: string) =>
    getJson<{ accounts: PlatformAccountView[] }>(
      `/projects/${encodeURIComponent(projectId)}/platform-accounts`,
    ),
  createPlatformAccount: (
    projectId: string,
    body: {
      platform: 'linkedin' | 'reddit' | 'tiktok' | 'youtube';
      accountLabel: string;
      remoteAccountId?: string | null;
      accessToken?: string | null;
      refreshToken?: string | null;
    },
  ) =>
    postJson<{ account: PlatformAccountView }>(
      `/projects/${encodeURIComponent(projectId)}/platform-accounts`,
      body,
    ),
  createManualPackage: (contentId: string) =>
    postJson<{ manualPackage: ManualPackageView }>(
      `/content/${encodeURIComponent(contentId)}/manual-package`,
      {},
    ),
  markManualPackagePublished: (packageId: string, platformAccountId: string) =>
    postJson<{
      publication: {
        publicationId: string;
        status: string;
        publishedAt: number;
        contentVersionId: string;
        exactText: string;
      };
    }>(`/manual-packages/${encodeURIComponent(packageId)}/published`, { platformAccountId }),
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
