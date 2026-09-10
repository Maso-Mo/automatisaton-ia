import { formatMicroUsd, type AppEnv, type Clock } from '@aia/shared';

/**
 * Cas d'usage « diagnostic » de l'étape 1 (docs/10 §4.1) : l'écran affiche
 * *base migrée · worker actif · clé IA présente · budget du jour*.
 *
 * Le domaine ne connaît **aucune** infrastructure : il reçoit des ports et
 * renvoie un objet de domaine. C'est `apps/api` qui câble les implémentations
 * (SQLite, file, prompts, budget) — c'est pour cela que cet écran continuera de
 * fonctionner après une migration PostgreSQL, sans être réécrit.
 */

export interface HealthDatabasePort {
  sqliteVersion(): string;
  tables(): string[];
  appliedMigrations(): number;
  walEnabled(): boolean;
}

export interface HealthQueuePort {
  counts(): Record<string, number>;
  /** Dernier battement de cœur d'un job en cours : le worker est-il vivant ? */
  latestHeartbeatAt(): number | null;
  lastCompletedJob(): {
    id: string;
    type: string;
    finishedAt: number;
    durationMs: number | null;
    costMicroUsd: number;
  } | null;
}

export interface HealthPromptsPort {
  summary(): { total: number; active: number; lastSyncedAt: number | null };
}

/** Forme structurelle du statut de budget produit par `@aia/analytics`. */
export interface HealthBudgetPort {
  status(): {
    day: { spentMicroUsd: number; limitMicroUsd: number; remainingMicroUsd: number; calls: number };
    month: { spentMicroUsd: number; limitMicroUsd: number; ratio: number };
    state: 'ok' | 'vigilance' | 'economy' | 'hard_stop';
    alerts: string[];
  };
}

export interface HealthSecretsPort {
  /** Présence des variables nécessaires : on écrit le nom, jamais la valeur. */
  presence(): Record<string, boolean>;
  providerDefault(): string;
}

export interface SystemHealthPorts {
  app: { name: string; version: string; env: AppEnv; host: string; port: number };
  expectedTables: readonly string[];
  database: HealthDatabasePort;
  queue: HealthQueuePort;
  prompts: HealthPromptsPort;
  budget: HealthBudgetPort;
  secrets: HealthSecretsPort;
  clock: Clock;
  /** Démarrage du processus, pour afficher une durée de vie. */
  startedAtMs: number;
  /** Silences tolérés avant de considérer le worker comme muet. */
  workerSilenceMs?: number;
}

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
  app: { name: string; version: string; env: AppEnv; host: string; port: number };
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

const DEFAULT_WORKER_SILENCE_MS = 30_000;

export function getSystemHealth(ports: SystemHealthPorts): SystemHealth {
  const now = ports.clock.nowMs();
  const tables = ports.database.tables();
  const present = new Set(tables);
  const missingTables = ports.expectedTables.filter((table) => !present.has(table));
  const appliedMigrations = ports.database.appliedMigrations();
  const walEnabled = ports.database.walEnabled();
  const sqliteVersion = ports.database.sqliteVersion();

  const jobs = ports.queue.counts();
  const lastHeartbeatAt = ports.queue.latestHeartbeatAt();
  const silenceMs = lastHeartbeatAt === null ? null : now - lastHeartbeatAt;
  const silenceLimit = ports.workerSilenceMs ?? DEFAULT_WORKER_SILENCE_MS;
  const running = (jobs.running ?? 0) > 0;
  const workerActive = running
    ? silenceMs !== null && silenceMs <= silenceLimit
    : lastHeartbeatAt !== null;

  const prompts = ports.prompts.summary();
  const presence = ports.secrets.presence();
  const budget = ports.budget.status();

  const checks: HealthCheck[] = [];
  const names = Object.entries(presence) as Array<[string, boolean]>;
  const missingRequired = names.filter(([key, value]) => key === 'SESSION_SECRET' && !value);

  checks.push(
    missingTables.length === 0
      ? {
          id: 'database',
          label: 'Base migrée',
          status: 'ok',
          detail: `${tables.length} tables · ${appliedMigrations} migration(s) appliquée(s) · SQLite ${sqliteVersion}`,
        }
      : {
          id: 'database',
          label: 'Base migrée',
          status: 'error',
          detail: `tables manquantes : ${missingTables.join(', ')} — lancer « pnpm db:migrate »`,
        },
  );

  checks.push({
    id: 'wal',
    label: 'Mode WAL',
    status: walEnabled ? 'ok' : 'warn',
    detail: walEnabled
      ? 'actif : un lecteur ne bloque pas un écrivain'
      : 'inactif : les lectures peuvent bloquer le worker',
  });

  checks.push(
    workerActive
      ? {
          id: 'worker',
          label: 'Worker actif',
          status: 'ok',
          detail:
            silenceMs === null
              ? 'aucun job en cours, aucun battement de cœur enregistré'
              : `dernier battement de cœur il y a ${Math.round(silenceMs / 1000)} s`,
        }
      : {
          id: 'worker',
          label: 'Worker actif',
          status: 'warn',
          detail:
            'aucun battement de cœur connu — lancer « pnpm dev:worker ». Les jobs resteront en attente, ils ne sont pas perdus.',
        },
  );

  const llmConfigured = names.some(([key, value]) => key.endsWith('_API_KEY') && value);
  checks.push(
    llmConfigured
      ? {
          id: 'llm',
          label: 'Clé IA présente',
          status: 'ok',
          detail: `fournisseur par défaut : ${ports.secrets.providerDefault()}`,
        }
      : {
          id: 'llm',
          label: 'Clé IA présente',
          status: 'warn',
          detail:
            'aucune clé IA configurée : les fonctionnalités de génération resteront indisponibles (docs/02 §11)',
        },
  );

  checks.push({
    id: 'budget',
    label: 'Budget du jour',
    status: budget.state === 'ok' ? 'ok' : budget.state === 'hard_stop' ? 'error' : 'warn',
    detail: `${formatMicroUsd(budget.day.spentMicroUsd)} sur ${formatMicroUsd(budget.day.limitMicroUsd)} · ${budget.day.calls} appel(s)`,
  });

  checks.push(
    prompts.active > 0
      ? {
          id: 'prompts',
          label: 'Prompts synchronisés',
          status: 'ok',
          detail: `${prompts.active} prompt(s) actif(s) sur ${prompts.total} version(s)`,
        }
      : {
          id: 'prompts',
          label: 'Prompts synchronisés',
          status: 'warn',
          detail: 'aucun prompt actif : vérifier le dossier PROMPTS_DIR',
        },
  );

  if (missingRequired.length > 0) {
    checks.push({
      id: 'secrets',
      label: 'Secrets obligatoires',
      status: 'error',
      detail: `variables manquantes : ${missingRequired.map(([key]) => key).join(', ')}`,
    });
  }

  const status = checks.some((check) => check.status === 'error')
    ? 'blocked'
    : checks.some((check) => check.status === 'warn')
      ? 'degraded'
      : 'ok';

  return {
    status,
    generatedAt: now,
    uptimeMs: Math.max(0, now - ports.startedAtMs),
    app: ports.app,
    checks,
    database: { appliedMigrations, tableCount: tables.length, walEnabled, sqliteVersion },
    worker: { active: workerActive, lastHeartbeatAt, silenceMs, jobs },
    prompts,
    budget: {
      todayMicroUsd: budget.day.spentMicroUsd,
      todayLimitMicroUsd: budget.day.limitMicroUsd,
      todayCalls: budget.day.calls,
      monthMicroUsd: budget.month.spentMicroUsd,
      monthRatio: budget.month.ratio,
      state: budget.state,
      alerts: budget.alerts,
    },
    lastCompletedJob: ports.queue.lastCompletedJob(),
  };
}
