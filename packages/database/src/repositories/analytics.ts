import { and, asc, desc, eq, gte } from 'drizzle-orm';
import {
  budgetPeriodSchema,
  encodeJson,
  parseJsonUnknown,
  uuidv7,
  type BudgetPeriod,
} from '@aia/shared';
import { z } from 'zod';
import type { DatabaseHandle } from '../client';
import { budgetLimits, learnings, metricSnapshots, performancePatterns } from '../schema';

/**
 * Les quatre tables de l'étape 8 (docs/10 §4.8), vues depuis la persistance.
 *
 * Ce que ce dépôt expose est **exactement** ce que l'étape 8 utilise :
 *
 * - `budget_limits` : **le seul** des quatre domaines réellement branché (le veto
 *   de budget de `packages/analytics` le lit avant chaque appel payant) ;
 * - `metric_snapshots`, `learnings`, `performance_patterns` : des fonctions
 *   d'écriture et de lecture **sans pipeline**. Elles existent parce que le
 *   schéma doit être exerçable par ses tests, et parce qu'une contrainte ne vaut
 *   que si quelqu'un essaie de la casser. Aucun job, aucune route ne les appelle :
 *   la collecte et le calcul appartiennent à l'étape 11 (docs/10 §1.3).
 */

// --- Plafonds --------------------------------------------------------------

export interface BudgetLimitRecord {
  id: string;
  scope: 'global' | 'project' | 'task';
  /** `''` pour le plafond global : jamais `NULL` (contrainte `chk_budget_scope_ref`). */
  scopeRef: string;
  period: BudgetPeriod;
  limitMicroUsd: number;
  hardStop: boolean;
  createdAt: number;
  updatedAt: number;
}

const budgetScopeSchema = z.enum(['global', 'project', 'task']);

function toBudgetLimit(row: typeof budgetLimits.$inferSelect): BudgetLimitRecord {
  return {
    id: row.id,
    scope: budgetScopeSchema.parse(row.scope),
    scopeRef: row.scope_ref,
    period: budgetPeriodSchema.parse(row.period),
    limitMicroUsd: row.limit_micro_usd,
    hardStop: row.hard_stop,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface BudgetLimitInput {
  scope: 'global' | 'project' | 'task';
  scopeRef: string;
  period: BudgetPeriod;
  limitMicroUsd: number;
  hardStop?: boolean;
}

export function createBudgetLimitStore(handle: DatabaseHandle, nowMs: () => number) {
  return {
    list(): BudgetLimitRecord[] {
      return handle.db
        .select()
        .from(budgetLimits)
        .orderBy(asc(budgetLimits.scope), asc(budgetLimits.scope_ref), asc(budgetLimits.period))
        .all()
        .map(toBudgetLimit);
    },
    /** Un seul plafond par `(scope, scope_ref, period)` : réécrire remplace, il n'empile pas. */
    upsert(input: BudgetLimitInput): BudgetLimitRecord {
      const now = nowMs();
      const existing = handle.db
        .select()
        .from(budgetLimits)
        .where(
          and(
            eq(budgetLimits.scope, input.scope),
            eq(budgetLimits.scope_ref, input.scopeRef),
            eq(budgetLimits.period, input.period),
          ),
        )
        .get();
      if (existing) {
        handle.db
          .update(budgetLimits)
          .set({
            limit_micro_usd: input.limitMicroUsd,
            hard_stop: input.hardStop ?? true,
            updated_at: now,
          })
          .where(eq(budgetLimits.id, existing.id))
          .run();
      } else {
        handle.db
          .insert(budgetLimits)
          .values({
            id: uuidv7(now),
            scope: input.scope,
            scope_ref: input.scopeRef,
            period: input.period,
            limit_micro_usd: input.limitMicroUsd,
            hard_stop: input.hardStop ?? true,
            created_at: now,
            updated_at: now,
          })
          .run();
      }
      const row = handle.db
        .select()
        .from(budgetLimits)
        .where(
          and(
            eq(budgetLimits.scope, input.scope),
            eq(budgetLimits.scope_ref, input.scopeRef),
            eq(budgetLimits.period, input.period),
          ),
        )
        .get();
      return toBudgetLimit(row!);
    },
    remove(id: string): number {
      return handle.db.delete(budgetLimits).where(eq(budgetLimits.id, id)).run().changes;
    },
  };
}

// --- Mesures (schéma seul, étape 8) ----------------------------------------

export type MetricSnapshotRow = typeof metricSnapshots.$inferSelect;

export interface MetricSnapshotMetrics {
  impressions?: number | null;
  reach?: number | null;
  views?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  saves?: number | null;
  clicks?: number | null;
  followsGained?: number | null;
  watchTimeSec?: number | null;
  avgViewDurationSec?: number | null;
  completionRateX100?: number | null;
  engagementRateX100?: number | null;
  profileVisits?: number | null;
}

export interface MetricSnapshotInput {
  publicationId: string;
  projectId: string;
  platform: string;
  capturedAt: number;
  /** `'YYYY-MM-DD'` dans le fuseau de l'utilisateur : c'est lui qui décide de l'unicité du jour. */
  capturedDate: string;
  source: 'api' | 'manual' | 'estimated';
  metrics: MetricSnapshotMetrics;
  raw?: unknown;
}

/** Traduction `camelCase` → colonnes : la table est la seule source de vérité des noms. */
const METRIC_COLUMNS: Readonly<
  Record<keyof MetricSnapshotMetrics, keyof typeof metricSnapshots.$inferInsert>
> = {
  impressions: 'impressions',
  reach: 'reach',
  views: 'views',
  likes: 'likes',
  comments: 'comments',
  shares: 'shares',
  saves: 'saves',
  clicks: 'clicks',
  followsGained: 'follows_gained',
  watchTimeSec: 'watch_time_sec',
  avgViewDurationSec: 'avg_view_duration_sec',
  completionRateX100: 'completion_rate_x100',
  engagementRateX100: 'engagement_rate_x100',
  profileVisits: 'profile_visits',
};

export function createMetricsStore(handle: DatabaseHandle, nowMs: () => number) {
  const key = (input: { publicationId: string; capturedDate: string; source: string }) =>
    and(
      eq(metricSnapshots.publication_id, input.publicationId),
      eq(metricSnapshots.captured_date, input.capturedDate),
      eq(metricSnapshots.source, input.source),
    );

  return {
    /**
     * **Idempotent par construction** : `uq_metric_day` fait qu'une seconde mesure
     * du même jour et de la même source met à jour le point au lieu d'en créer un
     * second — sans quoi toutes les courbes seraient faussées (docs/03 §12.1).
     */
    upsert(input: MetricSnapshotInput): MetricSnapshotRow {
      const now = nowMs();
      const columns: Record<string, unknown> = {
        publication_id: input.publicationId,
        project_id: input.projectId,
        platform: input.platform,
        captured_at: input.capturedAt,
        captured_date: input.capturedDate,
        source: input.source,
        raw_json: input.raw === undefined ? null : encodeJson(input.raw),
      };
      for (const [field, column] of Object.entries(METRIC_COLUMNS)) {
        const value = input.metrics[field as keyof MetricSnapshotMetrics];
        if (value !== undefined) columns[column] = value;
      }
      handle.db
        .insert(metricSnapshots)
        .values({
          id: uuidv7(now),
          created_at: now,
          ...columns,
        } as typeof metricSnapshots.$inferInsert)
        .onConflictDoUpdate({
          target: [
            metricSnapshots.publication_id,
            metricSnapshots.captured_date,
            metricSnapshots.source,
          ],
          set: columns,
        })
        .run();
      return handle.db.select().from(metricSnapshots).where(key(input)).get()!;
    },
    listByPublication(publicationId: string): MetricSnapshotRow[] {
      return handle.db
        .select()
        .from(metricSnapshots)
        .where(eq(metricSnapshots.publication_id, publicationId))
        .orderBy(desc(metricSnapshots.captured_date))
        .all();
    },
    /** Bornes `'YYYY-MM-DD'` : comparables lexicographiquement, donc indexables telles quelles. */
    listByProject(projectId: string, sinceDate: string): MetricSnapshotRow[] {
      return handle.db
        .select()
        .from(metricSnapshots)
        .where(
          and(
            eq(metricSnapshots.project_id, projectId),
            gte(metricSnapshots.captured_date, sinceDate),
          ),
        )
        .orderBy(desc(metricSnapshots.captured_date))
        .all();
    },
  };
}

// --- Apprentissages et patterns (schéma seul, étape 8 → étape 11) ----------

export type LearningRow = typeof learnings.$inferSelect;
export type PerformancePatternRow = typeof performancePatterns.$inferSelect;

export interface LearningInput {
  projectId: string;
  scope: LearningRow['scope'];
  platform: string | null;
  statement: string;
  sampleSize: number;
  confidence?: LearningRow['confidence'];
  evidence?: unknown;
}

export function createLearningsStore(handle: DatabaseHandle, nowMs: () => number) {
  return {
    /** `sample_size < 5` est refusé par la base : un « apprentissage » sur 3 posts est du bruit. */
    insert(input: LearningInput): LearningRow {
      const now = nowMs();
      const id = uuidv7(now);
      handle.db
        .insert(learnings)
        .values({
          id,
          project_id: input.projectId,
          scope: input.scope,
          platform: input.platform,
          statement: input.statement,
          evidence_json: input.evidence === undefined ? null : encodeJson(input.evidence),
          sample_size: input.sampleSize,
          confidence: input.confidence ?? 'faible',
          created_at: now,
        })
        .run();
      return handle.db.select().from(learnings).where(eq(learnings.id, id)).get()!;
    },
    /** Seuls les apprentissages **actifs** entrent dans un prompt (docs/03 §6.5, règles 4 et 5). */
    listActive(projectId: string): LearningRow[] {
      return handle.db
        .select()
        .from(learnings)
        .where(and(eq(learnings.project_id, projectId), eq(learnings.active, true)))
        .orderBy(asc(learnings.confidence))
        .all();
    },
    /** La preuve est du JSON : on ne la relit jamais par une requête (docs/03 §2.5). */
    evidenceOf(row: LearningRow): unknown {
      if (!row.evidence_json) return null;
      const parsed = parseJsonUnknown(row.evidence_json);
      return parsed.ok ? parsed.value : null;
    },
  };
}

export interface PerformancePatternInput {
  projectId: string;
  platform: string;
  dimension: PerformancePatternRow['dimension'];
  value: string;
  metric: PerformancePatternRow['metric'];
  sampleSize: number;
  avgValueX100: number;
  medianValueX100?: number | null;
  baselineX100?: number | null;
  deltaPercent?: number | null;
  periodStart: number;
  periodEnd: number;
}

export function createPerformancePatternStore(handle: DatabaseHandle, nowMs: () => number) {
  const key = (input: PerformancePatternInput) =>
    and(
      eq(performancePatterns.project_id, input.projectId),
      eq(performancePatterns.platform, input.platform),
      eq(performancePatterns.dimension, input.dimension),
      eq(performancePatterns.value, input.value),
      eq(performancePatterns.metric, input.metric),
      eq(performancePatterns.period_end, input.periodEnd),
    );

  return {
    /** Recalculer une période **remplace** son pattern (`uq_pattern`) : pas d'empilement. */
    upsert(input: PerformancePatternInput): PerformancePatternRow {
      const now = nowMs();
      const columns = {
        sample_size: input.sampleSize,
        avg_value_x100: input.avgValueX100,
        median_value_x100: input.medianValueX100 ?? null,
        baseline_x100: input.baselineX100 ?? null,
        delta_percent: input.deltaPercent ?? null,
        computed_at: now,
      };
      handle.db
        .insert(performancePatterns)
        .values({
          id: uuidv7(now),
          project_id: input.projectId,
          platform: input.platform,
          dimension: input.dimension,
          value: input.value,
          metric: input.metric,
          period_start: input.periodStart,
          period_end: input.periodEnd,
          ...columns,
        })
        .onConflictDoUpdate({
          target: [
            performancePatterns.project_id,
            performancePatterns.platform,
            performancePatterns.dimension,
            performancePatterns.value,
            performancePatterns.metric,
            performancePatterns.period_end,
          ],
          set: columns,
        })
        .run();
      return handle.db.select().from(performancePatterns).where(key(input)).get()!;
    },
    list(projectId: string, platform: string): PerformancePatternRow[] {
      return handle.db
        .select()
        .from(performancePatterns)
        .where(
          and(
            eq(performancePatterns.project_id, projectId),
            eq(performancePatterns.platform, platform),
          ),
        )
        .orderBy(desc(performancePatterns.sample_size))
        .all();
    },
  };
}
