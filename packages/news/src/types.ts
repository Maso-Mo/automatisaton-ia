export type NewsSourceType = 'rss' | 'atom' | 'web';
export type NewsUrgency = 'BREAKING' | 'HIGH' | 'NORMAL' | 'EVERGREEN';
export type NewsVerificationStatus = 'source_confirmed' | 'needs_review' | 'confirmed' | 'disputed';

export interface NewsSourceConfig {
  id: string;
  name: string;
  type: NewsSourceType;
  url: string;
  categories: string[];
  trustLevel: number;
  language?: string | null;
}

export interface RawNewsItem {
  externalId?: string | null;
  url: string;
  title: string;
  summary?: string | null;
  publishedAt?: number | null;
  author?: string | null;
  categories?: string[];
  language?: string | null;
}

export interface NormalizedNewsItem {
  sourceId: string;
  externalId: string | null;
  url: string;
  canonicalUrl: string;
  title: string;
  summary: string | null;
  publishedAt: number | null;
  author: string | null;
  categories: string[];
  language: string | null;
  contentHash: string;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
  checkedAt: number;
}

/** Contrat commun : le transport reste injectable et les tests ne touchent pas Internet. */
export interface NewsProvider<TPayload = unknown> {
  readonly type: NewsSourceType;
  fetchLatest(source: NewsSourceConfig, signal?: AbortSignal): Promise<TPayload>;
  normalize(payload: TPayload, source: NewsSourceConfig): NormalizedNewsItem[];
  healthCheck(source: NewsSourceConfig): Promise<ProviderHealth>;
}

export interface NewsScoreContext {
  nowMs: number;
  sourceTrustLevel: number;
  sourceCategories: string[];
  projectName: string;
  projectTerms: string[];
  audienceTerms: string[];
}

export interface NewsScore {
  relevance: number;
  freshness: number;
  trust: number;
  projectMatch: number;
  audienceMatch: number;
  final: number;
  urgency: NewsUrgency;
  explanation: string[];
}

export interface EditorialSuggestion {
  angle: string;
  platform: 'linkedin' | 'tiktok' | 'reddit' | 'youtube';
  urgency: NewsUrgency;
  projectId: string;
  reason: string;
  relevanceWindowHours: number;
  verificationRequired: boolean;
}

export interface NewsEnrichment {
  summary?: string;
  categories?: string[];
  angle?: string;
  projectReason?: string;
}

/** Extension LLM facultative : la collecte et le classement n'en dépendent jamais. */
export interface NewsEnricher {
  estimateMicroUsd(item: NormalizedNewsItem): number;
  enrich(item: NormalizedNewsItem): Promise<NewsEnrichment>;
}
