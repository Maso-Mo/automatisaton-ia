import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type CalendarRigidityView,
  type CalendarSlotView,
  type ContentBundleView,
} from '../../api/client';

type CalendarViewMode = 'today' | 'tomorrow' | 'week';
const RIGIDITIES: CalendarRigidityView[] = ['LOCKED', 'FLEXIBLE', 'EVERGREEN'];
const PLATFORM_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

function tomorrowDate(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1_000);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function CalendarView() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<CalendarViewMode>('week');
  const [projectId, setProjectId] = useState('');
  const [contentVersionId, setContentVersionId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [localDate, setLocalDate] = useState(tomorrowDate);
  const [localTime, setLocalTime] = useState('10:00');
  const [rigidity, setRigidity] = useState<CalendarRigidityView>('FLEXIBLE');
  const [notice, setNotice] = useState<string | null>(null);

  const settings = useQuery({ queryKey: ['calendar-settings'], queryFn: api.calendarSettings });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
  const content = useQuery({
    queryKey: ['calendar-content', projectId],
    queryFn: () => api.projectContent(projectId),
    enabled: Boolean(projectId),
  });
  const accounts = useQuery({
    queryKey: ['calendar-accounts', projectId],
    queryFn: () => api.platformAccounts(projectId),
    enabled: Boolean(projectId),
  });
  const calendar = useQuery({
    queryKey: ['calendar', mode, projectId],
    queryFn: () => api.calendar(mode, projectId || undefined),
  });
  const proposals = useQuery({
    queryKey: ['calendar-proposals'],
    queryFn: () => api.calendarProposals(),
  });

  useEffect(() => {
    const events = new EventSource('/api/events/calendar');
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['calendar-summary'] });
      void queryClient.invalidateQueries({ queryKey: ['calendar-proposals'] });
    };
    events.addEventListener('calendar_changed', refresh);
    return () => events.close();
  }, [queryClient]);

  const approved = useMemo(
    () =>
      (content.data?.content ?? []).filter(
        (bundle) =>
          bundle.item.archivedAt === null &&
          bundle.item.approvedVersionId === bundle.version?.id &&
          Boolean(bundle.version?.approvedAt),
      ),
    [content.data],
  );
  const selected = approved.find((bundle) => bundle.version?.id === contentVersionId);
  const compatibleAccounts = (accounts.data?.accounts ?? []).filter(
    (account) => !selected || account.platform === selected.item.platform,
  );

  useEffect(() => {
    if (!contentVersionId && approved[0]?.version) setContentVersionId(approved[0].version.id);
  }, [approved, contentVersionId]);
  useEffect(() => {
    if (!accountId && compatibleAccounts[0]) setAccountId(compatibleAccounts[0].id);
  }, [accountId, compatibleAccounts]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['calendar'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar-summary'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar-content'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar-proposals'] }),
      queryClient.invalidateQueries({ queryKey: ['calendar-settings'] }),
    ]);
  };

  const create = useMutation({
    mutationFn: () =>
      api.createCalendarSlot({
        contentVersionId,
        platformAccountId: accountId,
        localDate,
        localTime,
        timezone: settings.data?.timezone ?? 'UTC',
        rigidity,
      }),
    onSuccess: async (result) => {
      const warnings = [
        ...result.warnings.conflicts.map((conflict) => conflict.message),
        ...result.warnings.cadence,
      ];
      setNotice(warnings.length ? warnings.join(' ') : 'Créneau enregistré.');
      await refresh();
    },
  });

  const groups = useMemo(() => {
    const map = new Map<string, CalendarSlotView[]>();
    for (const slot of calendar.data?.slots ?? []) {
      const values = map.get(slot.local.localDate) ?? [];
      values.push(slot);
      map.set(slot.local.localDate, values);
    }
    return [...map.entries()];
  }, [calendar.data]);

  return (
    <section aria-labelledby="calendar-title">
      <div className="mb-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
          Planification humaine
        </p>
        <h2 id="calendar-title" className="text-2xl font-semibold text-slate-900">
          Calendrier éditorial
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Les heures sont affichées dans {settings.data?.timezone ?? 'votre fuseau configuré'}.
        </p>
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <div
            className="mb-4 flex flex-wrap gap-2"
            role="group"
            aria-label="Période du calendrier"
          >
            {(
              [
                ['today', 'Aujourd’hui'],
                ['tomorrow', 'Demain'],
                ['week', 'Cette semaine'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`min-h-11 rounded-lg px-4 py-2 text-sm ${mode === value ? 'bg-indigo-600 text-white' : 'border border-slate-300 bg-white'}`}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {calendar.isPending && (
            <p className="text-sm text-slate-600">Chargement du calendrier…</p>
          )}
          {calendar.isError && <ErrorBox message={calendar.error.message} />}
          {!calendar.isPending && groups.length === 0 && (
            <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
              Aucun créneau sur cette période.
            </p>
          )}
          <div className={mode === 'week' ? 'grid min-w-0 gap-3 md:grid-cols-2' : 'grid gap-3'}>
            {groups.map(([date, slots]) => (
              <section
                key={date}
                className="min-w-0 rounded-xl border border-slate-200 bg-slate-50 p-3"
              >
                <h3 className="mb-3 font-semibold text-slate-800">{formatDate(date)}</h3>
                <div className="grid gap-3">
                  {slots.map((slot) => (
                    <SlotCard
                      key={slot.id}
                      slot={slot}
                      proposals={(proposals.data?.proposals ?? []).filter(
                        (proposal) =>
                          proposal.calendarSlotId === slot.id && proposal.status === 'pending',
                      )}
                      onChanged={refresh}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <aside className="min-w-0 space-y-4">
          <form
            className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            onSubmit={(event) => {
              event.preventDefault();
              setNotice(null);
              create.mutate();
            }}
          >
            <h3 className="font-semibold">Planifier un contenu approuvé</h3>
            <label className="mt-3 block text-sm font-medium">
              Projet
              <select
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3"
                value={projectId}
                onChange={(event) => {
                  setProjectId(event.target.value);
                  setContentVersionId('');
                  setAccountId('');
                }}
              >
                <option value="">Choisir…</option>
                {(projects.data?.projects ?? []).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm font-medium">
              Contenu approuvé
              <select
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3"
                value={contentVersionId}
                onChange={(event) => {
                  setContentVersionId(event.target.value);
                  setAccountId('');
                }}
                disabled={!projectId}
              >
                <option value="">Choisir…</option>
                {approved.map((bundle) => (
                  <ContentOption key={bundle.version!.id} bundle={bundle} />
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm font-medium">
              Plateforme / compte
              <select
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                disabled={!contentVersionId}
              >
                <option value="">Choisir…</option>
                {compatibleAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {PLATFORM_LABELS[account.platform] ?? account.platform} · {account.accountLabel}
                  </option>
                ))}
              </select>
            </label>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <label className="block text-sm font-medium">
                Date
                <input
                  type="date"
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3"
                  value={localDate}
                  onChange={(event) => setLocalDate(event.target.value)}
                />
              </label>
              <label className="block text-sm font-medium">
                Heure
                <input
                  type="time"
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3"
                  value={localTime}
                  onChange={(event) => setLocalTime(event.target.value)}
                />
              </label>
            </div>
            <label className="mt-3 block text-sm font-medium">
              Rigidité
              <select
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3"
                value={rigidity}
                onChange={(event) => setRigidity(event.target.value as CalendarRigidityView)}
              >
                {RIGIDITIES.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="mt-4 min-h-11 w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              disabled={!contentVersionId || !accountId || create.isPending}
            >
              {create.isPending ? 'Enregistrement…' : 'Confirmer le créneau'}
            </button>
            {create.isError && <ErrorBox message={create.error.message} />}
            {notice && (
              <p className="mt-3 text-sm text-amber-700" role="status">
                {notice}
              </p>
            )}
          </form>
          <SettingsCard settings={settings.data} onChanged={refresh} />
        </aside>
      </div>
    </section>
  );
}

function ContentOption({ bundle }: { bundle: ContentBundleView }) {
  return (
    <option value={bundle.version?.id}>
      {PLATFORM_LABELS[bundle.item.platform] ?? bundle.item.platform} ·{' '}
      {bundle.item.title ?? bundle.version?.hook ?? bundle.version?.body.slice(0, 45)}
    </option>
  );
}

function SlotCard({
  slot,
  proposals,
  onChanged,
}: {
  slot: CalendarSlotView;
  proposals: Array<{ id: string; reason: string }>;
  onChanged(): Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [date, setDate] = useState(slot.local.localDate);
  const [time, setTime] = useState(slot.local.localTime);
  const [rigidity, setRigidity] = useState(slot.rigidity);
  const update = useMutation({
    mutationFn: () =>
      api.updateCalendarSlot(slot.id, {
        localDate: date,
        localTime: time,
        timezone: slot.timezone,
        rigidity,
      }),
    onSuccess: async () => {
      setEditing(false);
      await onChanged();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api.cancelCalendarSlot(slot.id, 'Annulé depuis le calendrier.'),
    onSuccess: onChanged,
  });
  const publish = useMutation({
    mutationFn: () => api.publishCalendarSlotNow(slot.id),
    onSuccess: onChanged,
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'accepted' | 'rejected' }) =>
      api.decideCalendarProposal(id, decision),
    onSuccess: onChanged,
  });
  const actionable = ['scheduled', 'due', 'missed'].includes(slot.status);

  return (
    <article
      className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      data-calendar-slot={slot.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-lg font-semibold text-indigo-700">{slot.local.localTime}</p>
          <h4 className="break-words font-semibold">
            {PLATFORM_LABELS[slot.platform] ?? slot.platform}
          </h4>
          <p className="break-words text-sm text-slate-700">{slot.content.title}</p>
          <p className="text-xs text-slate-500">
            {slot.project.name} · {slot.account.label}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold">
            {slot.rigidity}
          </span>
          <span className="rounded-full bg-indigo-50 px-2 py-1 text-xs text-indigo-700">
            {slot.status}
          </span>
        </div>
      </div>
      {slot.conflicts?.map((conflict) => (
        <p key={`${conflict.kind}-${conflict.slotId}`} className="mt-2 text-xs text-amber-700">
          ⚠ {conflict.message}
        </p>
      ))}
      {slot.missedReason && <p className="mt-2 text-xs text-rose-700">{slot.missedReason}</p>}
      {expanded && (
        <p className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-3 text-sm">
          {slot.content.body}
        </p>
      )}
      {editing && (
        <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 p-3 sm:grid-cols-3">
          <label className="text-xs">
            Date
            <input
              className="mt-1 min-h-11 w-full rounded border px-2"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <label className="text-xs">
            Heure
            <input
              className="mt-1 min-h-11 w-full rounded border px-2"
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
            />
          </label>
          <label className="text-xs">
            Rigidité
            <select
              className="mt-1 min-h-11 w-full rounded border px-2"
              value={rigidity}
              onChange={(event) => setRigidity(event.target.value as CalendarRigidityView)}
            >
              {RIGIDITIES.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="min-h-11 rounded bg-indigo-600 px-3 text-sm text-white sm:col-span-3"
            onClick={() => update.mutate()}
          >
            Enregistrer le déplacement
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Action onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Fermer le contenu' : 'Ouvrir le contenu'}
        </Action>
        {actionable && (
          <Action onClick={() => setEditing((value) => !value)}>Modifier / déplacer</Action>
        )}
        {actionable && <Action onClick={() => publish.mutate()}>Publier maintenant</Action>}
        {actionable && (
          <Action danger onClick={() => cancel.mutate()}>
            Annuler
          </Action>
        )}
        {slot.publication?.remoteUrl && (
          <a
            className="min-h-11 rounded-lg border px-3 py-2 text-sm"
            href={slot.publication.remoteUrl}
            target="_blank"
            rel="noreferrer"
          >
            Voir le statut distant
          </a>
        )}
      </div>
      {(update.isError || cancel.isError || publish.isError) && (
        <ErrorBox
          message={(update.error ?? cancel.error ?? publish.error)?.message ?? 'Action refusée.'}
        />
      )}
      {proposals.map((proposal) => (
        <div
          key={proposal.id}
          className="mt-3 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm"
        >
          <p>Proposition : {proposal.reason}</p>
          <div className="mt-2 flex gap-2">
            <Action onClick={() => decide.mutate({ id: proposal.id, decision: 'accepted' })}>
              Accepter
            </Action>
            <Action onClick={() => decide.mutate({ id: proposal.id, decision: 'rejected' })}>
              Refuser
            </Action>
          </div>
        </div>
      ))}
    </article>
  );
}

function SettingsCard({
  settings,
  onChanged,
}: {
  settings?: { timezone: string; cadencePerDay: Record<string, number> };
  onChanged(): Promise<void>;
}) {
  const [timezone, setTimezone] = useState('');
  const [cadence, setCadence] = useState<Record<string, number>>({});
  useEffect(() => {
    if (settings) {
      setTimezone(settings.timezone);
      setCadence(settings.cadencePerDay);
    }
  }, [settings]);
  const save = useMutation({
    mutationFn: () => api.updateCalendarSettings({ timezone, cadencePerDay: cadence }),
    onSuccess: onChanged,
  });
  return (
    <form
      className="rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <h3 className="font-semibold">Fuseau et cadence</h3>
      <label className="mt-3 block text-sm">
        Fuseau IANA
        <input
          className="mt-1 min-h-11 w-full rounded-lg border px-3"
          value={timezone}
          onChange={(event) => setTimezone(event.target.value)}
          placeholder="Europe/Paris"
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {['linkedin', 'tiktok', 'youtube', 'reddit'].map((platform) => (
          <label key={platform} className="text-xs">
            {PLATFORM_LABELS[platform]} / jour
            <input
              type="number"
              min="1"
              max="20"
              className="mt-1 min-h-11 w-full rounded-lg border px-2"
              value={cadence[platform] ?? 1}
              onChange={(event) =>
                setCadence((current) => ({ ...current, [platform]: Number(event.target.value) }))
              }
            />
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="mt-3 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-sm"
      >
        Enregistrer les préférences
      </button>
      {save.isError && <ErrorBox message={save.error.message} />}
    </form>
  );
}

function Action({
  children,
  onClick,
  danger = false,
}: {
  children: React.ReactNode;
  onClick(): void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={`min-h-11 rounded-lg border px-3 py-2 text-sm ${danger ? 'border-rose-200 text-rose-700' : 'border-slate-300 text-slate-700'}`}
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

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}
