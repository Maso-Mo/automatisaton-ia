import { useEffect, useRef, useState } from 'react';
import { api, type PublicJob } from '../../api/client';
import { applyJobProgress, jobStepLabel, type JobProgress, type JobStreamMessage } from './state';

/**
 * Suivi d'un job de génération, en direct.
 *
 * Le flux SSE est **reprenable** (docs/02 §13) : le serveur envoie d'abord
 * `snapshot` (l'état complet), puis chaque `job_event`, puis `done` quand le job
 * est terminal. On ne devine donc jamais l'avancement : on l'affiche tel que le
 * worker l'a écrit.
 *
 * Le crochet rend `null` tant qu'aucun job n'est suivi — l'écran n'affiche alors
 * aucune barre, plutôt qu'une barre à zéro qui laisserait croire à un travail en
 * cours.
 */
export function useJobStream(
  jobId: string | null,
  options: { onSettled?: (progress: JobProgress) => void } = {},
): JobProgress | null {
  const [progress, setProgress] = useState<JobProgress | null>(null);
  // La fermeture du flux est mémorisée : `onSettled` ne doit être appelé qu'une
  // fois par job, même si le serveur renvoie `done` puis ferme.
  const settled = useRef<string | null>(null);
  const callback = useRef(options.onSettled);
  callback.current = options.onSettled;

  useEffect(() => {
    if (jobId === null) {
      setProgress(null);
      return;
    }
    setProgress(null);
    settled.current = null;
    const source = new EventSource(api.eventsJobUrl(jobId));

    const update = (message: JobStreamMessage): void => {
      setProgress((current) => applyJobProgress(current ?? { ...EMPTY_PROGRESS, jobId }, message));
    };

    source.addEventListener('snapshot', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { job: PublicJob };
      update({ kind: 'snapshot', job: payload.job });
    });
    source.addEventListener('job_event', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as {
        level?: string;
        step?: string | null;
        message?: string;
        progress?: number;
      };
      update({ kind: 'event', event: payload });
    });
    source.addEventListener('done', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { job: PublicJob };
      update({ kind: 'done', job: payload.job });
    });
    source.addEventListener('closed', (event) => {
      const payload = JSON.parse((event as MessageEvent<string>).data) as { reason?: string };
      update({ kind: 'closed', reason: payload.reason });
    });

    return () => source.close();
  }, [jobId]);

  // Le rappel de fin est déclenché par un effet, pas par le réducteur : mettre à
  // jour le cache de requêtes depuis un `setState` serait un effet de bord pendant
  // le rendu (React peut appeler l'updater deux fois, le rafraîchissement partirait
  // deux fois).
  useEffect(() => {
    if (!progress?.closed || progress.jobId === null) return;
    if (settled.current === progress.jobId) return;
    settled.current = progress.jobId;
    callback.current?.(progress);
  }, [progress]);

  return progress;
}

const EMPTY_PROGRESS: JobProgress = {
  jobId: null,
  status: 'queued',
  statusLabel: 'En file d’attente',
  progress: 0,
  step: null,
  message: '',
  costMicroUsd: 0,
  error: null,
  closed: false,
};

/** La barre de suivi : étape lisible, avancement, coût, échec éventuel. */
export function JobProgressBar({
  progress,
  title = 'Génération en cours',
}: {
  progress: JobProgress;
  title?: string;
}) {
  const step = jobStepLabel(progress.step);
  const failed = progress.status === 'failed' || progress.status === 'dead';
  return (
    <section
      className={`mb-4 rounded-lg border p-3 text-sm ${
        failed ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-slate-50'
      }`}
      aria-live="polite"
    >
      <div className="flex items-baseline justify-between">
        <strong className="font-medium">{failed ? 'Génération interrompue' : title}</strong>
        <span className="text-slate-600">
          {progress.statusLabel}
          {progress.costMicroUsd > 0
            ? ` · ${(progress.costMicroUsd / 1_000_000).toFixed(4)} $`
            : ''}
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded bg-slate-200">
        <div
          className={`h-full ${failed ? 'bg-rose-500' : 'bg-slate-900'}`}
          style={{ width: `${Math.min(100, Math.max(0, progress.progress))}%` }}
        />
      </div>
      <p className="mt-2 text-slate-700">
        {step ? `${step}` : 'Étape inconnue'}
        {progress.message ? ` — ${progress.message}` : ''}
      </p>
      {progress.error !== null && <p className="mt-1 text-rose-700">{progress.error}</p>}
    </section>
  );
}
