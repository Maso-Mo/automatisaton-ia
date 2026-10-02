import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client';
import { ProjectSelect } from '../../components/ProjectSelect';
import { JobProgressBar, useJobStream } from './JobProgressBar';
import { SubjectPlanList } from './SubjectPlanList';
import { describeApiError } from './state';

/**
 * Écran « Plan éditorial » : produire des sujets, choisir un angle, générer.
 *
 * Trois temps, dans cet ordre, parce que le domaine les impose :
 *
 * 1. **le plan** exige une fiche maître validée — l'écran le dit avant l'appel
 *    plutôt que de laisser le serveur refuser (`BRIEF_NOT_APPROVED`) ;
 * 2. **un angle** se sélectionne : une génération sans angle choisi n'existe pas ;
 * 3. **les cibles** se cochent : cinq cibles, cinq contenus, un seul job.
 *
 * Le plan est **synchrone** (docs/05 §10.1) : il dure quelques secondes et l'écran
 * affiche les sujets retenus **et les refusés avec leur raison**. Une génération,
 * elle, est asynchrone : elle renvoie un job que l'on suit en direct.
 */
export function EditorialView() {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const projects = useQuery({
    queryKey: ['projects', false],
    queryFn: () => api.projects(),
  });
  const vocabulary = useQuery({
    queryKey: ['editorial', 'vocabulary'],
    queryFn: api.editorialVocabulary,
    staleTime: 60_000,
  });
  const brief = useQuery({
    queryKey: ['project-brief', projectId],
    queryFn: () => api.projectBrief(projectId ?? ''),
    enabled: projectId !== null,
  });
  const subjects = useQuery({
    queryKey: ['project-subjects', projectId],
    queryFn: () => api.projectSubjects(projectId ?? ''),
    enabled: projectId !== null,
  });

  const job = useJobStream(jobId, {
    onSettled: (progress) => {
      setJobId(null);
      setNotice(
        progress.status === 'completed'
          ? 'Génération terminée : les contenus sont à relire dans l’onglet « Revue des contenus ».'
          : 'La génération s’est arrêtée avant la fin : le détail est ci-dessus.',
      );
      void queryClient.invalidateQueries({ queryKey: ['project-content', projectId] });
      void queryClient.invalidateQueries({ queryKey: ['project-subjects', projectId] });
    },
  });

  const plan = useMutation({
    mutationFn: () => api.editorialPlan(projectId ?? ''),
    onSuccess: () => {
      setError(null);
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: ['project-subjects', projectId] });
    },
    onError: (cause: Error) => setError(describeApiError(cause)),
  });

  const angle = useMutation({
    mutationFn: (input: { run: () => Promise<unknown> }) => input.run(),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['project-subjects', projectId] });
    },
    onError: (cause: Error) => setError(describeApiError(cause)),
  });

  const generate = useMutation({
    mutationFn: (input: { angleId: string; targets: string[] }) =>
      api.generateContent(projectId ?? '', input),
    onSuccess: (result) => {
      setError(null);
      setNotice(null);
      setJobId(result.jobId);
    },
    onError: (cause: Error) => setError(describeApiError(cause)),
  });

  const masterBrief = brief.data?.brief ?? null;
  // Le domaine refuse un plan sans fiche validée : le dire ici évite un
  // aller-retour et un message d'erreur pour une règle connue d'avance.
  const briefReady = masterBrief !== null && masterBrief.status === 'validated';
  const planResult = plan.data;

  return (
    <section className="grid gap-4">
      <header className="rounded-lg border border-slate-200 bg-white p-4">
        <h2 className="font-medium">Plan éditorial</h2>
        <p className="mt-1 text-sm text-slate-600">
          L’assistant propose des sujets et des angles tirés de la fiche maître ; vous choisissez
          l’angle, puis les plateformes à produire. Le plan s’appuie sur la mémoire du projet, il
          n’invente pas de faits.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ProjectSelect
            projects={projects.data?.projects ?? []}
            value={projectId}
            label="Projet du plan"
            onChange={(next) => {
              setProjectId(next);
              setError(null);
              setNotice(null);
            }}
          />
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={projectId === null || !briefReady || plan.isPending}
            title={
              briefReady
                ? 'Produire cinq sujets et leurs angles'
                : 'Fiche maître non validée : la valider dans l’onglet Conversation'
            }
            onClick={() => plan.mutate()}
          >
            {plan.isPending ? 'Production du plan…' : 'Produire le plan'}
          </button>
        </div>

        {projectId !== null && brief.isSuccess && !briefReady && (
          <p className="mt-3 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">
            {masterBrief === null
              ? 'Aucune fiche maître pour ce projet : produisez-la et validez-la dans l’onglet « Conversation » avant de demander un plan.'
              : `La fiche maître est en état « ${masterBrief.status} » : elle doit être validée pour servir de source au plan.`}
          </p>
        )}
      </header>

      {job !== null && <JobProgressBar progress={job} title="Génération des contenus" />}

      {notice !== null && (
        <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          {notice}
        </p>
      )}
      {error !== null && (
        <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error}
        </p>
      )}

      {planResult !== undefined && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
          <h3 className="font-medium">Verdict du plan</h3>
          <p className="mt-1 text-slate-700">
            {planResult.accepted} sujet(s) retenu(s) sur {planResult.subjects.length} ·{' '}
            {planResult.rejected.length} refusé(s) · {planResult.angles.length} angle(s) ·{' '}
            {(planResult.usage.costMicroUsd / 1_000_000).toFixed(4)} $ ({planResult.usage.model})
            {planResult.repaired ? ' · réponse du modèle réparée' : ''}
          </p>

          {planResult.rejected.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase text-slate-500">
                Sujets refusés par le contrôle local
              </h4>
              <ul className="mt-1 space-y-1">
                {planResult.rejected.map((rejected, index) => (
                  <li
                    key={`${rejected.title ?? 'sujet'}-${index}`}
                    className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900"
                  >
                    <strong>{rejected.title ?? 'Sujet sans titre'}</strong> — {rejected.reason}
                  </li>
                ))}
              </ul>
            </>
          )}

          {planResult.droppedAngles.length > 0 && (
            <>
              <h4 className="mt-3 text-xs font-semibold uppercase text-slate-500">
                Angles écartés
              </h4>
              <ul className="mt-1 space-y-1">
                {planResult.droppedAngles.map((dropped, index) => (
                  <li
                    key={`${dropped.hook ?? 'angle'}-${index}`}
                    className="rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700"
                  >
                    {dropped.hook ?? 'Angle sans accroche'} — {dropped.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {projectId === null && (
        <p className="text-sm text-slate-600">Choisir un projet pour produire un plan éditorial.</p>
      )}

      {projectId !== null && subjects.isPending && (
        <p className="text-sm text-slate-600">Chargement des sujets…</p>
      )}
      {projectId !== null && subjects.isError && (
        <p className="text-sm text-rose-700">{describeApiError(subjects.error)}</p>
      )}
      {projectId !== null && subjects.data && vocabulary.data && (
        <SubjectPlanList
          subjects={subjects.data.subjects}
          vocabulary={vocabulary.data}
          pending={angle.isPending || generate.isPending}
          onSelectAngle={(angleId, note) =>
            angle.mutate({ run: () => api.selectAngle(angleId, note ?? undefined) })
          }
          onRejectAngle={(angleId, reason) =>
            angle.mutate({ run: () => api.rejectAngle(angleId, reason) })
          }
          onGenerate={(angleId, targets) => generate.mutate({ angleId, targets })}
        />
      )}
    </section>
  );
}
