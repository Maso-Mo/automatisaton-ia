import { formatRelative, formatUsd, type SystemHealth } from '../api/client';

/** Deux cartes de mesure : budget du jour et état du worker/base. */
export function Metrics({ health }: { health: SystemHealth }) {
  return (
    <section className="mb-8 grid gap-4 sm:grid-cols-2">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-medium">Budget du jour</h2>
        <p className="mt-2 text-2xl font-semibold">{formatUsd(health.budget.todayMicroUsd)}</p>
        <p className="text-sm text-slate-600">
          sur {formatUsd(health.budget.todayLimitMicroUsd)} · {health.budget.todayCalls} appel(s)
          facturé(s)
        </p>
        <p className="mt-2 text-sm text-slate-600">
          Mois : {formatUsd(health.budget.monthMicroUsd)} (
          {Math.round(health.budget.monthRatio * 100)} % du plafond) · mode{' '}
          <span className="font-medium">{health.budget.state}</span>
        </p>
        {health.budget.alerts.map((alert) => (
          <p key={alert} className="mt-2 text-sm text-amber-700">
            ⚠️ {alert}
          </p>
        ))}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-medium">Worker et base</h2>
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          <li>Dernier battement de cœur : {formatRelative(health.worker.lastHeartbeatAt)}</li>
          <li>
            Jobs :{' '}
            {Object.entries(health.worker.jobs)
              .map(([status, total]) => `${status} ${total}`)
              .join(' · ') || 'aucun'}
          </li>
          <li>
            Base : {health.database.tableCount} tables · SQLite {health.database.sqliteVersion} ·{' '}
            {health.database.walEnabled ? 'WAL actif' : 'WAL inactif'}
          </li>
          <li>
            Prompts : {health.prompts.active} actif(s) sur {health.prompts.total}
          </li>
          {health.lastCompletedJob && (
            <li>
              Dernier job terminé : {health.lastCompletedJob.type} ·{' '}
              {formatUsd(health.lastCompletedJob.costMicroUsd)}
            </li>
          )}
        </ul>
      </div>
    </section>
  );
}
