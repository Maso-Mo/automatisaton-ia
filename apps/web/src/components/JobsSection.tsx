import { formatRelative, formatUsd } from '../api/client';

export interface JobRowView {
  id: string;
  type: string;
  status: string;
  createdAt: number;
  costMicroUsd: number;
}

/**
 * Jobs récents. À l'étape 1, un seul type de job existe (`noop`, la sonde de
 * bout en bout) : la table reste volontairement brute, sans filtre ni action.
 */
export function JobsSection({
  jobs,
  isLoading,
  isError,
}: {
  jobs: JobRowView[];
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section className="mb-8 rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="font-medium">Jobs récents</h2>
      {isLoading && <p className="mt-2 text-sm text-slate-600">Chargement…</p>}
      {isError && <p className="mt-2 text-sm text-rose-700">Liste des jobs indisponible.</p>}
      {!isLoading && !isError && jobs.length === 0 && (
        <p className="mt-2 text-sm text-slate-600">
          Aucun job. Lancer la sonde de bout en bout :{' '}
          <code className="rounded bg-slate-100 px-1">pnpm job:noop</code>.
        </p>
      )}
      {jobs.length > 0 && (
        <table className="mt-3 w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="pb-1">Type</th>
              <th className="pb-1">Statut</th>
              <th className="pb-1">Créé</th>
              <th className="pb-1">Coût</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id} className="border-t border-slate-100">
                <td className="py-1 font-mono text-xs">{job.type}</td>
                <td className="py-1">{job.status}</td>
                <td className="py-1">{formatRelative(job.createdAt)}</td>
                <td className="py-1">{formatUsd(job.costMicroUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
