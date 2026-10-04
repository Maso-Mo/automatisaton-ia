import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type MetricSnapshotView } from '../../api/client';

const numberOrUndefined = (value: string): number | undefined =>
  value.trim() === '' ? undefined : Number(value);

export function AnalyticsView() {
  const client = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
  const analytics = useQuery({
    queryKey: ['analytics', projectId],
    queryFn: () => api.analytics(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 5_000,
  });
  const patterns = useQuery({
    queryKey: ['patterns', projectId],
    queryFn: () => api.analyticsPatterns(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 5_000,
  });
  const externals = useQuery({
    queryKey: ['external-examples', projectId],
    queryFn: () => api.externalExamples(projectId),
    enabled: Boolean(projectId),
    refetchInterval: 5_000,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['analytics', projectId] }),
      client.invalidateQueries({ queryKey: ['patterns', projectId] }),
      client.invalidateQueries({ queryKey: ['external-examples', projectId] }),
    ]);
  };
  const rebuild = useMutation({
    mutationFn: () => api.rebuildPatterns(projectId),
    onSuccess: refresh,
  });

  return (
    <section className="min-w-0" aria-labelledby="analytics-title">
      <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
        Mesures réelles, associations expliquées
      </p>
      <h2 id="analytics-title" className="text-2xl font-semibold text-slate-900">
        Analytics
      </h2>
      <p className="mt-1 text-sm text-slate-600">
        Une valeur inconnue reste inconnue. Les patterns signalent des corrélations, jamais une
        causalité.
      </p>

      <label className="mt-4 block max-w-md text-sm font-medium">
        Projet
        <select
          className="mt-1 min-h-11 w-full rounded-lg border px-3"
          aria-label="Projet Analytics"
          value={projectId}
          onChange={(event) => setProjectId(event.target.value)}
        >
          <option value="">Choisir un projet…</option>
          {(projects.data?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>

      {!projectId && (
        <p className="mt-6 rounded-xl border border-dashed p-6 text-sm text-slate-600">
          Choisissez un projet pour consulter ses performances et saisir ses métriques.
        </p>
      )}

      {projectId && (
        <div className="mt-6 grid min-w-0 gap-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(analytics.data?.byPlatform ?? []).map((summary) => (
              <article key={summary.platform} className="rounded-xl border bg-white p-4">
                <p className="text-xs uppercase text-slate-500">{summary.platform}</p>
                <p className="mt-1 text-2xl font-semibold">
                  {summary.views.toLocaleString('fr-FR')}
                </p>
                <p className="text-xs text-slate-500">vues · {summary.publications} contenu(s)</p>
              </article>
            ))}
            {analytics.data?.byPlatform.length === 0 && (
              <p className="rounded-xl border border-dashed p-4 text-sm text-slate-600 sm:col-span-2">
                Cold start : aucune métrique. Ajoutez une mesure manuelle ou un export plateforme.
              </p>
            )}
          </div>

          <MetricForm projectId={projectId} onChanged={refresh} />

          <section className="grid gap-4 lg:grid-cols-2">
            <PerformanceList title="Top contenus" rows={analytics.data?.top ?? []} />
            <PerformanceList title="Contenus faibles" rows={analytics.data?.weak ?? []} />
          </section>

          <section className="rounded-xl border bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-semibold">Patterns détectés</h3>
                <p className="text-xs text-slate-500">
                  Gagnants comparés à une baseline normale ou faible.
                </p>
              </div>
              <button
                type="button"
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                disabled={rebuild.isPending}
                onClick={() => rebuild.mutate()}
              >
                Reconstruire les patterns
              </button>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {(patterns.data?.patterns ?? []).map((pattern) => (
                <article key={pattern.id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap justify-between gap-2">
                    <strong>
                      {pattern.dimension} · {pattern.value}
                    </strong>
                    <span className="rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700">
                      {pattern.status}
                    </span>
                  </div>
                  <p className="mt-2 text-sm">{pattern.observed_effect ?? 'Effet non calculé'}</p>
                  <p className="mt-1 text-xs text-slate-600">
                    {pattern.platform}
                    {pattern.niche ? ` · ${pattern.niche}` : ''} · {pattern.sample_size}{' '}
                    observations · confiance {pattern.confidence_x100}%
                  </p>
                  <details className="mt-2 text-xs text-slate-600">
                    <summary className="cursor-pointer">Voir les preuves</summary>
                    <p className="mt-1">
                      {pattern.positive_sample_size} positives contre {pattern.baseline_sample_size}{' '}
                      baseline. IDs : {pattern.evidence_json ?? 'non disponibles'}
                    </p>
                  </details>
                </article>
              ))}
              {(patterns.data?.patterns ?? []).length === 0 && (
                <p className="text-sm text-slate-600">
                  Pas encore de conclusion : au moins 5 exemples dans un groupe et 5 en baseline
                  sont nécessaires.
                </p>
              )}
            </div>
          </section>

          <ViralResearch
            projectId={projectId}
            examples={externals.data?.examples ?? []}
            onChanged={refresh}
          />
        </div>
      )}
    </section>
  );
}

function MetricForm({ projectId, onChanged }: { projectId: string; onChanged(): Promise<void> }) {
  const [publicationId, setPublicationId] = useState('');
  const [views, setViews] = useState('');
  const [likes, setLikes] = useState('');
  const [shares, setShares] = useState('');
  const add = useMutation({
    mutationFn: () =>
      api.addMetricSnapshot({
        publicationId,
        views: numberOrUndefined(views),
        likes: numberOrUndefined(likes),
        shares: numberOrUndefined(shares),
        provenance: 'saisie utilisateur',
      }),
    onSuccess: async () => {
      await api.analyzePerformance(projectId, publicationId);
      await onChanged();
    },
  });
  return (
    <form
      className="rounded-xl border bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        add.mutate();
      }}
    >
      <h3 className="font-semibold">Importer une métrique personnelle</h3>
      <p className="mt-1 text-xs text-slate-500">
        Laissez vide ce qui est inconnu : vide ne signifie pas zéro.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Input label="ID publication" value={publicationId} onChange={setPublicationId} required />
        <Input label="Vues" value={views} onChange={setViews} numeric />
        <Input label="Likes" value={likes} onChange={setLikes} numeric />
        <Input label="Partages" value={shares} onChange={setShares} numeric />
      </div>
      <button
        className="mt-3 rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50"
        disabled={add.isPending || !publicationId || (!views && !likes && !shares)}
      >
        Enregistrer le snapshot et analyser
      </button>
      {add.isError && <p className="mt-2 text-sm text-rose-700">{add.error.message}</p>}
    </form>
  );
}

function PerformanceList({ title, rows }: { title: string; rows: MetricSnapshotView[] }) {
  return (
    <section className="rounded-xl border bg-white p-4">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-3 grid gap-2">
        {rows.map((row) => (
          <article key={row.id} className="rounded-lg bg-slate-50 p-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <span>
                {row.platform} · {row.publication_id}
              </span>
              <strong>{row.classification ?? 'NORMAL'}</strong>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              {row.views === null ? 'vues inconnues' : `${row.views.toLocaleString('fr-FR')} vues`}{' '}
              ·{' '}
              {row.relative_performance_x100 === null
                ? 'référence insuffisante'
                : `${row.relative_performance_x100}% de la médiane`}
            </p>
            {row.reason && <p className="mt-1 text-xs text-slate-500">Pourquoi : {row.reason}</p>}
          </article>
        ))}
        {rows.length === 0 && <p className="text-sm text-slate-500">Aucune donnée disponible.</p>}
      </div>
    </section>
  );
}

function ViralResearch({
  projectId,
  examples,
  onChanged,
}: {
  projectId: string;
  examples: Awaited<ReturnType<typeof api.externalExamples>>['examples'];
  onChanged(): Promise<void>;
}) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [platform, setPlatform] = useState('tiktok');
  const [views, setViews] = useState('');
  const [followers, setFollowers] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.addExternalExample({
        projectId,
        platform,
        url,
        title,
        views: numberOrUndefined(views),
        followers: numberOrUndefined(followers),
        provenance: 'URL fournie par utilisateur',
      }),
    onSuccess: async () => {
      setUrl('');
      setTitle('');
      await onChanged();
    },
  });
  const toggle = useMutation({
    mutationFn: ({ id, included }: { id: string; included: boolean }) =>
      api.setExternalIncluded(id, projectId, included),
    onSuccess: onChanged,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <section className="rounded-xl border bg-white p-4">
      <h3 className="text-lg font-semibold">Viral Research</h3>
      <p className="mt-1 text-xs text-slate-500">
        Ajoutez une URL ou des données publiques. Seules les caractéristiques abstraites sont
        apprises ; aucun script tiers n’est copié.
      </p>
      <form className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5" onSubmit={submit}>
        <Input label="URL publique" value={url} onChange={setUrl} required />
        <Input label="Titre descriptif" value={title} onChange={setTitle} required />
        <label className="text-sm font-medium">
          Plateforme
          <select
            className="mt-1 min-h-11 w-full rounded-lg border px-3"
            value={platform}
            onChange={(event) => setPlatform(event.target.value)}
          >
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube</option>
            <option value="linkedin">LinkedIn</option>
            <option value="reddit">Reddit</option>
          </select>
        </label>
        <Input label="Vues (optionnel)" value={views} onChange={setViews} numeric />
        <Input label="Abonnés (optionnel)" value={followers} onChange={setFollowers} numeric />
        <button
          className="rounded-lg bg-indigo-600 px-3 py-2 text-sm text-white disabled:opacity-50 sm:col-span-2 lg:col-span-1"
          disabled={create.isPending || !url || !title}
        >
          Ajouter et analyser
        </button>
      </form>
      {create.isError && <p className="mt-2 text-sm text-rose-700">{create.error.message}</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {examples.map((example) => (
          <article key={example.id} className="rounded-lg border p-3 text-sm">
            <a
              className="font-medium text-indigo-700 underline"
              href={example.url}
              target="_blank"
              rel="noreferrer"
            >
              {example.title}
            </a>
            <p className="mt-1 text-xs text-slate-600">
              {example.platform} · {example.views ?? 'vues inconnues'} · provenance :{' '}
              {example.provenance} · confiance {example.confidence_x100}%
            </p>
            <button
              type="button"
              className="mt-2 rounded border px-2 py-1 text-xs"
              onClick={() => toggle.mutate({ id: example.id, included: !example.included })}
            >
              {example.included ? 'Exclure de l’apprentissage' : 'Inclure dans l’apprentissage'}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function Input({
  label,
  value,
  onChange,
  numeric = false,
  required = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  numeric?: boolean;
  required?: boolean;
}) {
  return (
    <label className="text-sm font-medium">
      {label}
      <input
        className="mt-1 min-h-11 w-full rounded-lg border px-3"
        type={numeric ? 'number' : 'text'}
        min={numeric ? 0 : undefined}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}
