import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type CheckStatus, type SystemHealth } from './api/client';
import { JobsSection } from './components/JobsSection';
import { Metrics } from './components/Metrics';
import { ConversationView } from './features/conversation/ConversationView';
import { ProjectsView } from './features/projects/ProjectsView';

/**
 * Application de l'étape 3 : trois vues, sans routeur (un routeur ne se justifie
 * pas pour trois onglets, docs/10 §1.3).
 *
 * - **Conversation** (étape 3) : on discute, la mémoire se construit, la fiche
 *   maître se relit et se valide.
 * - **Projets** (étape 2) : la mémoire structurée — projets, faits, contexte.
 * - **Diagnostic** (étape 1) : *le socle est-il en état ?*
 *
 * La génération de contenus n'existe pas encore : elle arrive à l'étape suivante.
 */

type View = 'diagnostic' | 'projects' | 'conversation';

const CHECK_STYLES: Record<CheckStatus, { icon: string; className: string }> = {
  ok: { icon: '✅', className: 'border-emerald-200 bg-emerald-50' },
  warn: { icon: '⚠️', className: 'border-amber-200 bg-amber-50' },
  error: { icon: '❌', className: 'border-rose-200 bg-rose-50' },
};

const GLOBAL_STYLES: Record<SystemHealth['status'], string> = {
  ok: 'bg-emerald-600',
  degraded: 'bg-amber-600',
  blocked: 'bg-rose-600',
};

const GLOBAL_LABELS: Record<SystemHealth['status'], string> = {
  ok: 'Socle opérationnel',
  degraded: 'Socle dégradé — utilisable, mais incomplet',
  blocked: 'Socle bloqué — à corriger avant de continuer',
};

export function App() {
  const [view, setView] = useState<View>('conversation');
  const health = useQuery({ queryKey: ['health'], queryFn: api.health, refetchInterval: 5_000 });
  const summary = useQuery({
    queryKey: ['jobs-summary'],
    queryFn: api.jobsSummary,
    refetchInterval: 5_000,
  });

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Automatisation IA</h1>
        <p className="mt-1 text-sm text-slate-600">
          Étape 3 : conversation par texte et fiche maître. La génération de contenus n’existe pas
          encore — elle arrive à l’étape suivante.
        </p>
        <nav className="mt-4 flex gap-2" aria-label="Vues">
          {(
            [
              ['conversation', 'Conversation'],
              ['projects', 'Projets'],
              ['diagnostic', 'Diagnostic'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`rounded px-3 py-1 text-sm ${
                view === value
                  ? 'bg-slate-900 text-white'
                  : 'border border-slate-300 text-slate-700'
              }`}
              aria-current={view === value ? 'page' : undefined}
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {view === 'conversation' && <ConversationView />}

      {view === 'projects' && <ProjectsView />}

      {view === 'diagnostic' && (
        <>
          {health.isPending && <p className="text-sm text-slate-600">Chargement du diagnostic…</p>}

          {health.isError && (
            <section className="rounded-lg border border-rose-200 bg-rose-50 p-4">
              <h2 className="font-medium text-rose-800">API injoignable</h2>
              <p className="mt-1 text-sm text-rose-700">{health.error.message}</p>
              <p className="mt-2 text-sm text-rose-700">
                Lancer l’API avec <code className="rounded bg-white px-1">pnpm dev:api</code>.
              </p>
            </section>
          )}

          {health.data && (
            <>
              <section
                className={`mb-6 rounded-lg p-4 text-white ${GLOBAL_STYLES[health.data.status]}`}
              >
                <p className="text-lg font-medium">{GLOBAL_LABELS[health.data.status]}</p>
                <p className="mt-1 text-sm opacity-90">
                  {health.data.app.name} {health.data.app.version} · {health.data.app.env} ·{' '}
                  {health.data.app.host}:{health.data.app.port} · démarré depuis{' '}
                  {Math.round(health.data.uptimeMs / 1000)} s
                </p>
              </section>

              <section className="mb-8 grid gap-3 sm:grid-cols-2">
                {health.data.checks.map((check) => {
                  const style = CHECK_STYLES[check.status];
                  return (
                    <article key={check.id} className={`rounded-lg border p-4 ${style.className}`}>
                      <h2 className="flex items-center gap-2 font-medium">
                        <span aria-hidden>{style.icon}</span>
                        {check.label}
                      </h2>
                      <p className="mt-1 text-sm text-slate-700">{check.detail}</p>
                    </article>
                  );
                })}
              </section>

              <Metrics health={health.data} />
            </>
          )}

          <JobsSection
            jobs={summary.data?.recent ?? []}
            isLoading={summary.isPending}
            isError={summary.isError}
          />

          <footer className="text-xs text-slate-500">
            Interdits de l’étape 1 : pas d’authentification complète, pas de panneau de réglages,
            pas de design system, pas de Redis, pas de CI distante, pas de fonctionnalité métier
            (docs/10 §4.1).
          </footer>
        </>
      )}
    </main>
  );
}
