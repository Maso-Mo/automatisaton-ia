import type { ZodType } from 'zod';
import type { LogLevel, SerializedError } from '@aia/shared';
import type { AppLogger } from '@aia/observability';

/**
 * Contrat `Queue` figé avant le code (docs/02 §9.3). Le driver V1 est
 * `SqliteQueue` (table `jobs`, `BEGIN IMMEDIATE`). Un driver `RedisQueue`
 * pourra être ajouté sans modifier un seul appel dans le domaine.
 */

export interface EnqueueOptions {
  /** 1 (urgent) – 9 (batch). Défaut : la priorité du type de job. */
  priority?: number;
  /** Retard avant disponibilité (cron, planification). */
  delayMs?: number;
  /** Un seul job en attente par clé logique (docs/03 §14.1). */
  dedupeKey?: string;
  projectId?: string;
  contentItemId?: string;
  parentJobId?: string;
  requiresNetwork?: boolean;
}

export interface ClaimedJob {
  id: string;
  type: string;
  /** Incrémenté à la réservation, donc « 1 » à la première exécution. */
  attempt: number;
  maxAttempts: number;
  priority: number;
  requiresNetwork: boolean;
  input: unknown;
  leaseMs: number;
}

export interface ClaimParams {
  workerId: string;
  limit: number;
  /** Mode hors ligne : ne rien réserver qui exige le réseau (docs/08 §3). */
  offline?: boolean;
}

export interface Queue {
  enqueue<TInput>(type: string, input: TInput, opts?: EnqueueOptions): Promise<string>;
  /** Réservation atomique : `UPDATE … WHERE status='queued' LIMIT n`. */
  claim(workerId: string, limit: number, opts?: { offline?: boolean }): Promise<ClaimedJob[]>;
  complete(jobId: string, result: unknown, extra?: { durationMs?: number }): Promise<void>;
  fail(jobId: string, error: SerializedError | unknown, retry?: boolean): Promise<void>;
  /** Récupère les jobs `running` dont le lease a expiré (crash du worker). */
  reclaimExpired(now: Date): Promise<number>;
}

/** Ce qu'un handler peut publier comme étape intermédiaire (journalisé et diffusé en SSE). */
export interface JobEventInput {
  level?: LogLevel;
  step?: string;
  message: string;
  data?: unknown;
  progress?: number;
  durationMs?: number;
}

/** Contexte d'exécution donné à un handler : il ne connaît ni la base, ni Drizzle. */
export interface JobContext {
  readonly jobId: string;
  readonly type: string;
  readonly attempt: number;
  readonly workerId: string;
  /** Signal d'arrêt : l'arrêt propre du worker le déclenche après le délai de grâce. */
  readonly signal: AbortSignal;
  /** Émission d'événement : écrite dans `job_events`, jamais dans un journal seulement. */
  emitEvent(event: JobEventInput): Promise<void>;
  setStep(step: string, progress?: number): Promise<void>;
  /** Le coût dépensé est cumulé sur le job, jamais remplacé. */
  recordCost(microUsd: number): Promise<void>;
  readonly logger: AppLogger;
}

export type JobHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  ctx: JobContext,
) => Promise<TOutput>;

/**
 * Ce qu'il faut savoir d'un type de job pour l'**accepter** dans la file :
 * schéma d'entrée, priorités, politique de retry, lease. Rien de plus.
 *
 * La séparation avec `JobDefinition` n'est pas cosmétique : **l'API enfile, le
 * worker exécute** (docs/02 §3). Les deux processus partagent donc la même
 * spécification — importée d'un seul endroit, jamais recopiée — mais seul le
 * worker possède le handler. Un producteur sans handler est un cas normal ; un
 * consommateur sans handler est un bug, et c'est le worker qui le détecte.
 */
export interface JobSpec<TInput = unknown> {
  type: string;
  inputSchema: ZodType<TInput>;
  maxAttempts: number;
  /** Retry exponentiel : 30 s, 2 min, 8 min, 32 min (docs/02 §9.3). */
  backoff: (attempt: number) => number;
  /** Durée maximale avant reprise du lease par le worker. */
  leaseMs: number;
  /** Un job idempotent peut être rejoué sans effet de bord. */
  idempotent: boolean;
  priority?: number;
  requiresNetwork?: boolean;
  /** Clé logique déduite de l'entrée, quand le type s'y prête. */
  dedupeKey?: (input: TInput) => string | undefined;
}

export interface JobDefinition<TInput, TOutput> extends JobSpec<TInput> {
  handler: JobHandler<TInput, TOutput>;
}

/**
 * Entrée du registre : une spécification, à laquelle un handler **peut** être
 * attaché. `handler` reste optionnel pour que la file puisse valider un job
 * produit par l'API sans exiger du producteur qu'il sache l'exécuter.
 */
export interface RegisteredJob extends JobSpec<unknown> {
  handler?: JobHandler | undefined;
}
