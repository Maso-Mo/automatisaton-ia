import { FEATURE_DIMENSIONS, type ContentFeatures } from './features';

export type PatternStatus = 'EXPERIMENTAL' | 'LIKELY' | 'SUPPORTED' | 'REJECTED';

export interface PerformanceObservation {
  id: string;
  projectId: string;
  platform: string;
  niche: string | null;
  contentType: string;
  origin: 'personal' | 'external';
  features: ContentFeatures;
  relativePerformanceX100: number;
  qualityX100: number;
  observedAt: number;
}

export interface DetectedPattern {
  platform: string;
  niche: string | null;
  contentType: string;
  dimension: (typeof FEATURE_DIMENSIONS)[number][0];
  feature: string;
  observedEffectPercent: number;
  sampleSize: number;
  positiveSampleSize: number;
  baselineSampleSize: number;
  confidenceX100: number;
  firstObservedAt: number;
  lastObservedAt: number;
  evidenceIds: string[];
  personalEvidence: number;
  status: PatternStatus;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

function stableConfidence(input: {
  sampleSize: number;
  quality: number;
  effect: number;
  values: readonly number[];
}): number {
  const spread =
    input.values.length < 2 ? 100 : Math.max(...input.values) - Math.min(...input.values);
  const size = Math.min(45, input.sampleSize * 1.2);
  const effect = Math.min(30, Math.abs(input.effect) * 0.5);
  const quality = input.quality * 0.25;
  const variancePenalty = Math.min(25, spread / 20);
  return Math.max(0, Math.min(100, Math.round(size + effect + quality - variancePenalty)));
}

function statusOf(sampleSize: number, confidence: number, effect: number): PatternStatus {
  if (Math.abs(effect) < 10) return 'REJECTED';
  if (sampleSize >= 50 && confidence >= 70) return 'SUPPORTED';
  if (sampleSize >= 20 && confidence >= 50) return 'LIKELY';
  return 'EXPERIMENTAL';
}

/** Corrélations locales avec baseline ; aucun texte tiers n'est conservé ni reproduit. */
export class ViralPatternEngine {
  analyze(observations: readonly PerformanceObservation[]): DetectedPattern[] {
    const results: DetectedPattern[] = [];
    const buckets = new Map<string, PerformanceObservation[]>();
    for (const observation of observations) {
      for (const [dimension, key] of FEATURE_DIMENSIONS) {
        const raw = observation.features[key];
        if (raw === null || raw === 'unknown') continue;
        const value = String(raw);
        const bucket = `${observation.platform}\u0000${observation.niche ?? ''}\u0000${observation.contentType}\u0000${dimension}\u0000${value}`;
        const rows = buckets.get(bucket) ?? [];
        rows.push(observation);
        buckets.set(bucket, rows);
      }
    }
    for (const [bucket, positive] of buckets) {
      if (positive.length < 5) continue;
      const [platform, niche, contentType, dimension, feature] = bucket.split('\u0000') as [
        string,
        string,
        string,
        DetectedPattern['dimension'],
        string,
      ];
      const positiveIds = new Set(positive.map((item) => item.id));
      const baseline = observations.filter(
        (item) =>
          item.platform === platform &&
          (item.niche ?? '') === niche &&
          item.contentType === contentType &&
          !positiveIds.has(item.id),
      );
      if (baseline.length < 5) continue;
      // Nos propres résultats valent trois observations ; le public sert au cold start.
      const weighted = (rows: readonly PerformanceObservation[]) =>
        rows.flatMap((row) =>
          Array.from(
            { length: row.origin === 'personal' ? 3 : 1 },
            () => row.relativePerformanceX100,
          ),
        );
      const positiveValues = weighted(positive);
      const baselineValues = weighted(baseline);
      const baselineMedian = median(baselineValues);
      const effect =
        baselineMedian === 0
          ? 0
          : Math.round(((median(positiveValues) - baselineMedian) / baselineMedian) * 100);
      const quality = Math.round(
        positive.reduce((sum, row) => sum + row.qualityX100, 0) / positive.length,
      );
      const totalSampleSize = positive.length + baseline.length;
      const confidence = stableConfidence({
        sampleSize: totalSampleSize,
        quality,
        effect,
        values: positiveValues,
      });
      results.push({
        platform,
        niche: niche || null,
        contentType,
        dimension,
        feature,
        observedEffectPercent: effect,
        sampleSize: totalSampleSize,
        positiveSampleSize: positive.length,
        baselineSampleSize: baseline.length,
        confidenceX100: confidence,
        firstObservedAt: Math.min(...positive.map((item) => item.observedAt)),
        lastObservedAt: Math.max(...positive.map((item) => item.observedAt)),
        evidenceIds: positive.map((item) => item.id),
        personalEvidence: positive.filter((item) => item.origin === 'personal').length,
        status: statusOf(totalSampleSize, confidence, effect),
      });
    }
    return results.sort(
      (left, right) =>
        right.confidenceX100 - left.confidenceX100 || right.sampleSize - left.sampleSize,
    );
  }
}
