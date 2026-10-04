import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type NewsItemView, type NewsUrgencyView } from '../../api/client';

const URGENCIES: Array<NewsUrgencyView | ''> = ['', 'BREAKING', 'HIGH', 'NORMAL', 'EVERGREEN'];
const CATEGORY_FILTERS = ['', 'ia', 'dev', 'react', 'typescript', 'outils'];

function tomorrow(): string {
  const value = new Date(Date.now() + 24 * 60 * 60_000);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function NewsView() {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState('');
  const [urgency, setUrgency] = useState<NewsUrgencyView | ''>('');
  const [category, setCategory] = useState('');
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
  const sources = useQuery({
    queryKey: ['news-sources', projectId],
    queryFn: () => api.newsSources(projectId || undefined),
  });
  const news = useQuery({
    queryKey: ['news', projectId, urgency],
    queryFn: () =>
      api.newsItems({ projectId: projectId || undefined, urgency: urgency || undefined }),
  });
  const calendar = useQuery({
    queryKey: ['calendar', 'week', projectId],
    queryFn: () => api.calendar('week', projectId || undefined),
  });

  useEffect(() => {
    const events = new EventSource('/api/events/news');
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['news'] });
      void queryClient.invalidateQueries({ queryKey: ['news-sources'] });
      void queryClient.invalidateQueries({ queryKey: ['news-summary'] });
    };
    events.addEventListener('news_changed', refresh);
    return () => events.close();
  }, [queryClient]);

  const visible = useMemo(
    () =>
      (news.data?.items ?? []).filter(
        (item) => !category || item.categories.some((value) => value.includes(category)),
      ),
    [category, news.data],
  );
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['news'] }),
      queryClient.invalidateQueries({ queryKey: ['news-sources'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar'] }),
    ]);
  };

  return (
    <section aria-labelledby="news-title" className="min-w-0">
      <div className="mb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
          Sources vérifiables
        </p>
        <h2 id="news-title" className="text-2xl font-semibold text-slate-900">
          News / Veille
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Le classement est local et expliqué. Une suggestion ne modifie jamais seule le calendrier.
        </p>
      </div>

      <div className="mb-4 grid min-w-0 gap-3 sm:grid-cols-3">
        <label className="text-sm font-medium">
          Projet
          <select
            className="mt-1 min-h-11 w-full rounded-lg border px-3"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Tous les projets</option>
            {(projects.data?.projects ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Urgence
          <select
            className="mt-1 min-h-11 w-full rounded-lg border px-3"
            value={urgency}
            onChange={(event) => setUrgency(event.target.value as NewsUrgencyView | '')}
          >
            {URGENCIES.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || 'Toutes'}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium">
          Catégorie
          <select
            className="mt-1 min-h-11 w-full rounded-lg border px-3"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            {CATEGORY_FILTERS.map((value) => (
              <option key={value || 'all'} value={value}>
                {value || 'Toutes'}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-3">
          {news.isPending && <p className="text-sm text-slate-600">Chargement de la veille…</p>}
          {news.isError && <ErrorBox message={news.error.message} />}
          {!news.isPending && visible.length === 0 && (
            <p className="rounded-xl border border-dashed p-6 text-sm text-slate-600">
              Aucune actualité pour ces filtres.
            </p>
          )}
          {visible.map((item) => (
            <NewsCard
              key={item.id}
              item={item}
              sourceName={
                sources.data?.sources.find((source) => source.id === item.sourceId)?.name ??
                'Source inconnue'
              }
              projectName={
                projects.data?.projects.find((project) => project.id === item.projectId)?.name ??
                item.projectId
              }
              slots={(calendar.data?.slots ?? []).filter((slot) =>
                ['scheduled', 'due'].includes(slot.status),
              )}
              timezone={calendar.data?.timezone ?? 'UTC'}
              onChanged={refresh}
            />
          ))}
        </div>
        <aside className="min-w-0 space-y-4">
          <SourceForm projectId={projectId} onChanged={refresh} />
          <section className="rounded-xl border bg-white p-4">
            <h3 className="font-semibold">Sources configurées</h3>
            <div className="mt-3 grid gap-3">
              {(sources.data?.sources ?? []).map((source) => (
                <SourceCard key={source.id} source={source} onChanged={refresh} />
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function SourceForm({ projectId, onChanged }: { projectId: string; onChanged(): Promise<void> }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [type, setType] = useState<'rss' | 'atom' | 'web'>('rss');
  const [categories, setCategories] = useState('dev, ia');
  const [trustLevel, setTrustLevel] = useState(3);
  const [refreshHours, setRefreshHours] = useState(12);
  const create = useMutation({
    mutationFn: () =>
      api.createNewsSource({
        projectId,
        name,
        type,
        url,
        categories: categories
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        keywords: categories
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        excludeKeywords: [],
        trustLevel,
        refreshHours,
        language: 'fr',
      }),
    onSuccess: async () => {
      setName('');
      setUrl('');
      await onChanged();
    },
  });
  return (
    <form
      className="rounded-xl border bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h3 className="font-semibold">Ajouter une source</h3>
      <label className="mt-3 block text-sm">
        Nom de la source
        <input
          className="mt-1 min-h-11 w-full rounded-lg border px-3"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="mt-3 block text-sm">
        URL publique
        <input
          className="mt-1 min-h-11 w-full rounded-lg border px-3"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <label className="mt-3 block text-sm">
        Type
        <select
          className="mt-1 min-h-11 w-full rounded-lg border px-3"
          value={type}
          onChange={(event) => setType(event.target.value as typeof type)}
        >
          <option value="rss">RSS</option>
          <option value="atom">ATOM</option>
          <option value="web">WEB JSON</option>
        </select>
      </label>
      <label className="mt-3 block text-sm">
        Catégories (virgules)
        <input
          className="mt-1 min-h-11 w-full rounded-lg border px-3"
          value={categories}
          onChange={(event) => setCategories(event.target.value)}
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-xs">
          Confiance 1–5
          <input
            className="mt-1 min-h-11 w-full rounded-lg border px-2"
            type="number"
            min="1"
            max="5"
            value={trustLevel}
            onChange={(event) => setTrustLevel(Number(event.target.value))}
          />
        </label>
        <label className="text-xs">
          Fréquence (heures)
          <input
            className="mt-1 min-h-11 w-full rounded-lg border px-2"
            type="number"
            min="2"
            max="168"
            value={refreshHours}
            onChange={(event) => setRefreshHours(Number(event.target.value))}
          />
        </label>
      </div>
      <button
        className="mt-4 min-h-11 w-full rounded-lg bg-indigo-600 px-3 text-sm font-medium text-white disabled:opacity-50"
        disabled={!projectId || !name || !url || create.isPending}
      >
        Ajouter la source
      </button>
      {create.isError && <ErrorBox message={create.error.message} />}
    </form>
  );
}

function SourceCard({
  source,
  onChanged,
}: {
  source: {
    id: string;
    name: string;
    enabled: boolean;
    categories: string[];
    authority: number;
    refreshHours: number;
    lastError: string | null;
  };
  onChanged(): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [categories, setCategories] = useState(source.categories.join(', '));
  const [authority, setAuthority] = useState(source.authority);
  const [refreshHours, setRefreshHours] = useState(source.refreshHours);
  const toggle = useMutation({
    mutationFn: () => api.updateNewsSource(source.id, { enabled: !source.enabled }),
    onSuccess: onChanged,
  });
  const collect = useMutation({
    mutationFn: () => api.collectNewsSource(source.id),
    onSuccess: onChanged,
  });
  const save = useMutation({
    mutationFn: () =>
      api.updateNewsSource(source.id, {
        categories: categories
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        trustLevel: authority,
        refreshHours,
      }),
    onSuccess: async () => {
      setEditing(false);
      await onChanged();
    },
  });
  return (
    <article className="min-w-0 rounded-lg bg-slate-50 p-3 text-sm">
      <p className="break-words font-medium">{source.name}</p>
      <p className="text-xs text-slate-500">
        Confiance {source.authority}/5 · toutes les {source.refreshHours} h
      </p>
      {source.lastError && (
        <p className="mt-1 break-words text-xs text-rose-700">{source.lastError}</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Action onClick={() => collect.mutate()} disabled={!source.enabled}>
          Collecter
        </Action>
        <Action onClick={() => toggle.mutate()}>{source.enabled ? 'Désactiver' : 'Activer'}</Action>
        <Action onClick={() => setEditing((value) => !value)}>Modifier</Action>
      </div>
      {editing && (
        <div className="mt-3 grid gap-2 rounded-lg border bg-white p-2">
          <label className="text-xs">
            Catégories de {source.name}
            <input
              className="mt-1 min-h-11 w-full rounded border px-2"
              value={categories}
              onChange={(event) => setCategories(event.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              Confiance de {source.name}
              <input
                className="mt-1 min-h-11 w-full rounded border px-2"
                type="number"
                min="1"
                max="5"
                value={authority}
                onChange={(event) => setAuthority(Number(event.target.value))}
              />
            </label>
            <label className="text-xs">
              Fréquence de {source.name}
              <input
                className="mt-1 min-h-11 w-full rounded border px-2"
                type="number"
                min="2"
                max="168"
                value={refreshHours}
                onChange={(event) => setRefreshHours(Number(event.target.value))}
              />
            </label>
          </div>
          <Action onClick={() => save.mutate()} disabled={save.isPending}>
            Enregistrer la source
          </Action>
        </div>
      )}
      {(toggle.isError || collect.isError || save.isError) && (
        <ErrorBox
          message={(toggle.error ?? collect.error ?? save.error)?.message ?? 'Action refusée.'}
        />
      )}
    </article>
  );
}

function NewsCard({
  item,
  sourceName,
  projectName,
  slots,
  timezone,
  onChanged,
}: {
  item: NewsItemView;
  sourceName: string;
  projectName: string;
  slots: Array<{
    id: string;
    rigidity: string;
    local: { localDate: string; localTime: string };
    content: { title: string };
  }>;
  timezone: string;
  onChanged(): Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [slotId, setSlotId] = useState('');
  const [date, setDate] = useState(tomorrow);
  const [time, setTime] = useState('18:00');
  const [proposalId, setProposalId] = useState<string | null>(null);
  const dismiss = useMutation({ mutationFn: () => api.dismissNews(item.id), onSuccess: onChanged });
  const idea = useMutation({
    mutationFn: () => api.createNewsSuggestion(item.id),
    onSuccess: onChanged,
  });
  const verify = useMutation({
    mutationFn: (status: 'needs_review' | 'confirmed' | 'disputed') =>
      api.verifyNews(item.id, status),
    onSuccess: onChanged,
  });
  const propose = useMutation({
    mutationFn: () =>
      api.proposeNewsInCalendar(item.id, {
        calendarSlotId: slotId,
        localDate: date,
        localTime: time,
        timezone,
      }),
    onSuccess: async (result) => {
      setProposalId(result.proposal.id);
      await onChanged();
    },
  });
  const decide = useMutation({
    mutationFn: (decision: 'accepted' | 'rejected') =>
      api.decideCalendarProposal(proposalId ?? '', decision),
    onSuccess: async () => {
      setProposalId(null);
      setProposalOpen(false);
      await onChanged();
    },
  });
  return (
    <article className="min-w-0 rounded-xl border bg-white p-4 shadow-sm" data-news-item={item.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-slate-500">
            {item.publishedAt
              ? new Date(item.publishedAt).toLocaleString('fr-FR')
              : 'Date inconnue'}{' '}
            · {sourceName} · {item.categories.join(', ') || 'sans catégorie'}
          </p>
          <h3 className="break-words font-semibold">{item.title}</h3>
        </div>
        <div className="flex gap-2">
          <span className="rounded-full bg-indigo-50 px-2 py-1 text-xs font-semibold text-indigo-700">
            {item.finalScore ?? 0}/100
          </span>
          <span className="rounded-full bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-800">
            {item.urgency}
          </span>
        </div>
      </div>
      <p className="mt-2 break-words text-sm text-slate-700">{item.summary}</p>
      <p className="mt-2 text-xs text-slate-500">
        Projet : {projectName} · Vérification : {item.verificationStatus}
      </p>
      {expanded && (
        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs">
          <p className="font-semibold">Pourquoi ce score ?</p>
          {item.scoreExplanation.map((line) => (
            <p key={line}>{line}</p>
          ))}
          {item.claims.length > 0 && (
            <>
              <p className="mt-2 font-semibold">Affirmations à vérifier</p>
              {item.claims.map((claim) => (
                <p key={claim}>• {claim}</p>
              ))}
            </>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Action onClick={() => verify.mutate('confirmed')}>Confirmer les faits</Action>
            <Action onClick={() => verify.mutate('needs_review')}>À vérifier</Action>
            <Action onClick={() => verify.mutate('disputed')}>Contester</Action>
          </div>
        </div>
      )}
      {item.suggestion?.angle && (
        <p className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
          Idée : {item.suggestion.angle}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          className="min-h-11 rounded-lg border px-3 py-2 text-sm"
          href={item.canonicalUrl ?? item.url}
          target="_blank"
          rel="noreferrer"
        >
          Voir
        </a>
        <Action onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Fermer' : 'Expliquer'}
        </Action>
        <Action onClick={() => dismiss.mutate()}>Ignorer</Action>
        <Action onClick={() => idea.mutate()}>Créer une idée</Action>
        <Action onClick={() => setProposalOpen((value) => !value)}>
          Proposer dans le calendrier
        </Action>
      </div>
      {proposalOpen && (
        <div className="mt-3 grid gap-2 rounded-lg border p-3 sm:grid-cols-3">
          <label className="text-xs sm:col-span-3">
            Créneau à déplacer
            <select
              className="mt-1 min-h-11 w-full rounded border px-2"
              value={slotId}
              onChange={(event) => setSlotId(event.target.value)}
            >
              <option value="">Choisir…</option>
              {slots.map((slot) => (
                <option key={slot.id} value={slot.id}>
                  {slot.local.localDate} {slot.local.localTime} · {slot.rigidity} ·{' '}
                  {slot.content.title}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs">
            Nouvelle date
            <input
              className="mt-1 min-h-11 w-full rounded border px-2"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <label className="text-xs">
            Nouvelle heure
            <input
              className="mt-1 min-h-11 w-full rounded border px-2"
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="min-h-11 rounded bg-violet-600 px-3 text-sm text-white"
            disabled={!slotId}
            onClick={() => propose.mutate()}
          >
            Créer la proposition
          </button>
          {proposalId && (
            <div className="flex gap-2 sm:col-span-3">
              <Action onClick={() => decide.mutate('accepted')}>Accepter la proposition</Action>
              <Action onClick={() => decide.mutate('rejected')}>Refuser la proposition</Action>
            </div>
          )}
        </div>
      )}
      {(dismiss.isError || idea.isError || verify.isError || propose.isError || decide.isError) && (
        <ErrorBox
          message={
            (dismiss.error ?? idea.error ?? verify.error ?? propose.error ?? decide.error)
              ?.message ?? 'Action refusée.'
          }
        />
      )}
    </article>
  );
}

function Action({
  children,
  onClick,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick(): void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="min-h-11 rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700" role="alert">
      {message}
    </p>
  );
}
