import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

export function DashboardView({ onOpenCalendar }: { onOpenCalendar(): void }) {
  const summary = useQuery({ queryKey: ['calendar-summary'], queryFn: api.calendarSummary });

  if (summary.isPending) return <p className="text-sm text-slate-600">Chargement d’aujourd’hui…</p>;
  if (summary.isError) {
    return (
      <p className="rounded-lg bg-rose-50 p-4 text-sm text-rose-700">{summary.error.message}</p>
    );
  }
  const value = summary.data;
  return (
    <section aria-labelledby="dashboard-title">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
            Aujourd’hui
          </p>
          <h2 id="dashboard-title" className="text-2xl font-semibold text-slate-900">
            Votre rythme éditorial
          </h2>
        </div>
        <button
          type="button"
          className="min-h-11 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white"
          onClick={onOpenCalendar}
        >
          Voir le calendrier
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Publications prévues" value={String(value.today)} />
        <Metric
          label="Prochaine publication"
          value={
            value.next
              ? `${value.next.local.localTime} · ${value.next.platform}`
              : 'Aucune planification'
          }
        />
        <Metric
          label="Retards et conflits"
          value={`${value.missed} retard(s) · ${value.conflicts} conflit(s)`}
          alert={value.missed + value.conflicts > 0}
        />
        <Metric
          label="Contenus à traiter"
          value={`${value.contentToValidate} à valider · ${value.approvedUnscheduled} à planifier`}
        />
      </div>

      {value.next && (
        <article className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Prochain départ · {value.timezone}</p>
          <h3 className="mt-1 text-lg font-semibold">{value.next.content.title}</h3>
          <p className="mt-1 text-sm text-slate-600">
            {value.next.local.localDate} à {value.next.local.localTime} · {value.next.platform} ·{' '}
            {value.next.rigidity}
          </p>
        </article>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
  alert = false,
}: {
  label: string;
  value: string;
  alert?: boolean;
}) {
  return (
    <article
      className={`rounded-xl border p-4 ${alert ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-base font-semibold text-slate-900">{value}</p>
    </article>
  );
}
