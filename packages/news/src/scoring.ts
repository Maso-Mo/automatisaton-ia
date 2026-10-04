import { normalizeNewsText } from './normalize';
import type {
  EditorialSuggestion,
  NewsEnrichment,
  NewsEnricher,
  NewsScore,
  NewsScoreContext,
  NewsUrgency,
  NormalizedNewsItem,
} from './types';

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function matchScore(
  haystack: string,
  terms: readonly string[],
): { score: number; matches: string[] } {
  const normalized = normalizeNewsText(haystack);
  const unique = [...new Set(terms.map(normalizeNewsText).filter((term) => term.length > 1))];
  const matches = unique.filter((term) => normalized.includes(term));
  return {
    score: unique.length === 0 ? 0 : clamp((matches.length / Math.min(unique.length, 5)) * 100),
    matches,
  };
}

export function classifyUrgency(input: {
  finalScore: number;
  freshnessScore: number;
  categories: readonly string[];
}): NewsUrgency {
  if (input.categories.some((category) => normalizeNewsText(category).includes('evergreen')))
    return 'EVERGREEN';
  if (input.finalScore >= 85 && input.freshnessScore >= 90) return 'BREAKING';
  if (input.finalScore >= 70 && input.freshnessScore >= 70) return 'HIGH';
  if (input.freshnessScore <= 25) return 'EVERGREEN';
  return 'NORMAL';
}

export function scoreNews(item: NormalizedNewsItem, context: NewsScoreContext): NewsScore {
  const body = `${item.title} ${item.summary ?? ''} ${item.categories.join(' ')}`;
  const topical = matchScore(body, context.sourceCategories);
  const project = matchScore(body, [context.projectName, ...context.projectTerms]);
  const audience = matchScore(body, context.audienceTerms);
  const relevance = clamp(Math.max(topical.score, project.score * 0.8));
  const ageHours =
    item.publishedAt === null ? 24 : Math.max(0, (context.nowMs - item.publishedAt) / 3_600_000);
  const freshness =
    ageHours <= 6 ? 100 : ageHours <= 24 ? 85 : ageHours <= 72 ? 65 : ageHours <= 168 ? 40 : 15;
  const trust = clamp(context.sourceTrustLevel * 20);
  const projectMatch = project.score;
  const audienceMatch = audience.score;
  const final = clamp(
    relevance * 0.3 + freshness * 0.2 + trust * 0.2 + projectMatch * 0.2 + audienceMatch * 0.1,
  );
  const urgency = classifyUrgency({
    finalScore: final,
    freshnessScore: freshness,
    categories: item.categories,
  });
  const explanation = [
    `Pertinence ${relevance}/100${topical.matches.length ? ` (${topical.matches.join(', ')})` : ''}.`,
    `Fraîcheur ${freshness}/100 (${Math.round(ageHours)} h).`,
    `Confiance source ${trust}/100 (niveau ${context.sourceTrustLevel}/5).`,
    `Correspondance projet ${projectMatch}/100${project.matches.length ? ` (${project.matches.join(', ')})` : ''}.`,
    `Correspondance audience ${audienceMatch}/100${audience.matches.length ? ` (${audience.matches.join(', ')})` : ''}.`,
  ];
  return {
    relevance,
    freshness,
    trust,
    projectMatch,
    audienceMatch,
    final,
    urgency,
    explanation,
  };
}

export function extractClaims(item: NormalizedNewsItem): string[] {
  const source = item.summary ?? item.title;
  return source
    .split(/(?<=[.!?])\s+/)
    .map((claim) => claim.trim())
    .filter((claim) => claim.length >= 12)
    .slice(0, 3);
}

export function createEditorialSuggestion(input: {
  item: NormalizedNewsItem;
  score: NewsScore;
  projectId: string;
}): EditorialSuggestion {
  const joined = normalizeNewsText(`${input.item.title} ${input.item.categories.join(' ')}`);
  const platform = joined.includes('reddit')
    ? 'reddit'
    : joined.includes('video') || joined.includes('tiktok')
      ? 'tiktok'
      : joined.includes('youtube')
        ? 'youtube'
        : 'linkedin';
  const relevanceWindowHours =
    input.score.urgency === 'BREAKING'
      ? 6
      : input.score.urgency === 'HIGH'
        ? 24
        : input.score.urgency === 'NORMAL'
          ? 96
          : 720;
  return {
    angle: `Ce que « ${input.item.title} » change concrètement pour nos projets`,
    platform,
    urgency: input.score.urgency,
    projectId: input.projectId,
    reason: input.score.explanation.join(' '),
    relevanceWindowHours,
    verificationRequired: true,
  };
}

export async function enrichWithinBudget(input: {
  items: NormalizedNewsItem[];
  enricher: NewsEnricher;
  remainingMicroUsd: number;
}): Promise<{
  enriched: Array<{ item: NormalizedNewsItem; enrichment: NewsEnrichment }>;
  held: NormalizedNewsItem[];
  spentMicroUsd: number;
}> {
  const enriched: Array<{ item: NormalizedNewsItem; enrichment: NewsEnrichment }> = [];
  const held: NormalizedNewsItem[] = [];
  let spentMicroUsd = 0;
  for (const item of input.items) {
    const estimated = input.enricher.estimateMicroUsd(item);
    if (spentMicroUsd + estimated > input.remainingMicroUsd) {
      held.push(item);
      continue;
    }
    enriched.push({ item, enrichment: await input.enricher.enrich(item) });
    spentMicroUsd += estimated;
  }
  return { enriched, held, spentMicroUsd };
}
