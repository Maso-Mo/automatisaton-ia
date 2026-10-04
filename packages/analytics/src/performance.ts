export type PerformanceClass = 'UNDERPERFORMING' | 'NORMAL' | 'STRONG' | 'BREAKOUT' | 'VIRAL';

export interface MetricValues {
  impressions?: number | null;
  reach?: number | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  clicks?: number | null;
  watchTimeSec?: number | null;
  averageWatchTimeSec?: number | null;
  completionRateX100?: number | null;
  followersAtPublish?: number | null;
}

export interface DerivedMetrics {
  engagementRateX10000: number | null;
  shareRateX10000: number | null;
  saveRateX10000: number | null;
  commentRateX10000: number | null;
  ctrX10000: number | null;
  viewVelocityX100: number | null;
  relativePerformanceX100: number | null;
  percentileX100: number | null;
  denominator: 'impressions' | 'reach' | 'views' | null;
}

function rate(numerator: number | null | undefined, denominator: number | null): number | null {
  if (numerator === null || numerator === undefined || denominator === null || denominator <= 0)
    return null;
  return Math.round((numerator / denominator) * 10_000);
}

function denominatorOf(metrics: MetricValues): {
  value: number | null;
  kind: DerivedMetrics['denominator'];
} {
  if (metrics.impressions !== null && metrics.impressions !== undefined)
    return { value: metrics.impressions, kind: 'impressions' };
  if (metrics.reach !== null && metrics.reach !== undefined)
    return { value: metrics.reach, kind: 'reach' };
  if (metrics.views !== null && metrics.views !== undefined)
    return { value: metrics.views, kind: 'views' };
  return { value: null, kind: null };
}

export function percentileOf(value: number | null, baseline: readonly number[]): number | null {
  if (value === null || baseline.length === 0) return null;
  const below = baseline.filter((candidate) => candidate < value).length;
  const equal = baseline.filter((candidate) => candidate === value).length;
  return Math.round(((below + equal / 2) / baseline.length) * 10_000);
}

/** Dérivés explicables. Une valeur absente reste `null`, jamais zéro. */
export function deriveMetrics(input: {
  metrics: MetricValues;
  capturedAt: number;
  publishedAt: number;
  previous?: { views: number | null; capturedAt: number } | null;
  baselineValues?: readonly number[];
  baselineMedian?: number | null;
}): DerivedMetrics {
  const denominator = denominatorOf(input.metrics);
  const interactions = [
    input.metrics.likes,
    input.metrics.comments,
    input.metrics.shares,
    input.metrics.saves,
  ];
  const engagementNumerator = interactions.every((value) => value === null || value === undefined)
    ? null
    : interactions.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const hours = input.previous
    ? (input.capturedAt - input.previous.capturedAt) / 3_600_000
    : (input.capturedAt - input.publishedAt) / 3_600_000;
  const previousViews = input.previous?.views ?? 0;
  const viewVelocity =
    input.metrics.views === null ||
    input.metrics.views === undefined ||
    hours <= 0 ||
    input.metrics.views < previousViews
      ? null
      : Math.round(((input.metrics.views - previousViews) / hours) * 100);
  const normalizedPerformance =
    input.metrics.followersAtPublish && input.metrics.followersAtPublish > 0
      ? (input.metrics.views ?? denominator.value ?? 0) / input.metrics.followersAtPublish
      : rate(engagementNumerator, denominator.value) === null
        ? (input.metrics.views ?? null)
        : rate(engagementNumerator, denominator.value)! / 10_000;
  const relative =
    normalizedPerformance === null || !input.baselineMedian || input.baselineMedian <= 0
      ? null
      : Math.round((normalizedPerformance / input.baselineMedian) * 100);
  return {
    engagementRateX10000: rate(engagementNumerator, denominator.value),
    shareRateX10000: rate(input.metrics.shares, denominator.value),
    saveRateX10000: rate(input.metrics.saves, denominator.value),
    commentRateX10000: rate(input.metrics.comments, denominator.value),
    ctrX10000: rate(input.metrics.clicks, denominator.value),
    viewVelocityX100: viewVelocity,
    relativePerformanceX100: relative,
    percentileX100: percentileOf(normalizedPerformance, input.baselineValues ?? []),
    denominator: denominator.kind,
  };
}

export function classifyPerformance(
  relativePerformanceX100: number | null,
  comparableSampleSize: number,
): { classification: PerformanceClass; reason: string } {
  if (relativePerformanceX100 === null || comparableSampleSize < 3) {
    return {
      classification: 'NORMAL',
      reason: `Référence insuffisante (${comparableSampleSize} contenu(s) comparable(s)) : aucune anomalie affirmée.`,
    };
  }
  if (relativePerformanceX100 < 70)
    return {
      classification: 'UNDERPERFORMING',
      reason: `${relativePerformanceX100}% de la médiane comparable.`,
    };
  if (relativePerformanceX100 < 130)
    return { classification: 'NORMAL', reason: 'Dans la plage 70–129 % de la médiane comparable.' };
  if (relativePerformanceX100 < 250)
    return {
      classification: 'STRONG',
      reason: `${relativePerformanceX100}% de la médiane comparable.`,
    };
  if (relativePerformanceX100 < 500 || comparableSampleSize < 50)
    return {
      classification: 'BREAKOUT',
      reason: `${relativePerformanceX100}% de la médiane ; VIRAL exige au moins 50 références.`,
    };
  return {
    classification: 'VIRAL',
    reason: `${relativePerformanceX100}% de la médiane sur ${comparableSampleSize} références.`,
  };
}
