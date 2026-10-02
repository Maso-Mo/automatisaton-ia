import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type VideoAssetView,
  type VideoPlanView,
  type VideoRenderView,
} from '../../api/client';
import { ProjectSelect } from '../../components/ProjectSelect';
import { JobProgressBar, useJobStream } from '../editorial/JobProgressBar';
import {
  buildPlanDraft,
  describeSource,
  formatMs,
  formatTimecodeInput,
  planSummary,
  statusLabel,
  transcriptionBlocker,
} from './video';

/**
 * Écran **Montage vidéo** (étape 7, docs/05 §6, docs/10 §4.7).
 *
 * Le parcours qu'il rend visible, dans l'ordre — et rien de plus :
 *
 * 1. choisir le **contenu approuvé** à monter : un montage se rattache toujours à
 *    une version de texte validée, jamais à un brouillon ;
 * 2. choisir ou **importer** la vidéo source, puis la **transcrire** (les
 *    sous-titres brûlés viennent de là) ;
 * 3. **proposer** un plan : l'agent propose, l'écran l'affiche avec ses
 *    avertissements, et l'utilisateur modifie le début et la fin ;
 * 4. **lancer** le rendu : c'est un job, avec sa barre de progression et ses
 *    étapes ;
 * 5. **regarder** l'aperçu, puis **valider** le montage — la seule trace que
 *    quelqu'un l'a vu. Aucune publication n'est déclenchée ici.
 *
 * Ce que cet écran ne fait **pas**, et pourquoi : pas de choix de format (un
 * seul), pas de musique, pas de transition, pas de détection de moment fort. Les
 * interdits de l'étape sont tenus par l'API ; l'écran ne les contourne pas.
 */
export function VideoView() {
  const queryClient = useQueryClient();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [contentId, setContentId] = useState<string | null>(null);
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [plan, setPlan] = useState<VideoPlanView | null>(null);
  const [startText, setStartText] = useState('0:00');
  const [endText, setEndText] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jobTitle, setJobTitle] = useState('Encodage du short');

  const projects = useQuery({ queryKey: ['projects', false], queryFn: () => api.projects() });
  const capabilities = useQuery({
    queryKey: ['video', 'capabilities'],
    queryFn: api.videoCapabilities,
    staleTime: 60_000,
  });
  const contents = useQuery({
    queryKey: ['project-content', projectId],
    queryFn: () => api.projectContent(projectId ?? ''),
    enabled: projectId !== null,
  });
  const videos = useQuery({
    queryKey: ['project-videos', projectId],
    queryFn: () => api.projectVideos(projectId ?? ''),
    enabled: projectId !== null,
  });
  const renders = useQuery({
    queryKey: ['content-renders', contentId],
    queryFn: () => api.contentRenders(contentId ?? ''),
    enabled: contentId !== null,
  });

  /**
   * Les contenus **montables** : ceux qui portent une version approuvée, quel que
   * soit leur état ensuite. C'est le critère de l'API (`approvedVersionId`), donc
   * l'écran ne peut pas proposer un contenu que le serveur refusera — ni en
   * cacher un qu'il accepterait, comme un contenu déjà publié.
   */
  const approved = useMemo(
    () =>
      (contents.data?.content ?? [])
        .filter((bundle) => bundle.item.state !== 'archived')
        .filter((bundle) => bundle.item.approvedVersionId !== null)
        .map((bundle) => ({
          id: bundle.item.id,
          label: bundle.item.title ?? bundle.version?.hook ?? bundle.item.target,
          target: bundle.item.target,
        })),
    [contents.data],
  );
  const source: VideoAssetView | null = useMemo(
    () => videos.data?.videos.find((video) => video.id === sourceAssetId) ?? null,
    [videos.data, sourceAssetId],
  );
  const blocker = source === null ? null : transcriptionBlocker(source);

  // Le job suivi : quand il se termine, les rendus sont **rechargés**, jamais
  // devinés (même mécanique que la génération de contenu).
  const progress = useJobStream(jobId, {
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['content-renders', contentId] });
      void queryClient.invalidateQueries({ queryKey: ['project-videos', projectId] });
    },
  });

  // Changer de vidéo remet les bornes à zéro sur la durée **mesurée** de la source.
  useEffect(() => {
    if (source === null) return;
    const max = capabilities.data?.maxClipMs ?? 60_000;
    const duration = source.durationMs ?? max;
    setStartText(formatTimecodeInput(0));
    setEndText(formatTimecodeInput(Math.min(duration, max)));
    setPlan(null);
  }, [source, capabilities.data]);

  const upload = useMutation({
    mutationFn: (file: File) => api.uploadVideo(projectId ?? '', file),
    onSuccess: (result) => {
      setMessage(
        result.deduplicated
          ? 'Cette vidéo était déjà importée : la même empreinte n’est stockée qu’une fois.'
          : null,
      );
      setSourceAssetId(result.video.id);
      void queryClient.invalidateQueries({ queryKey: ['project-videos', projectId] });
    },
  });

  const transcribe = useMutation({
    mutationFn: (assetId: string) => api.transcribeVideo(assetId),
    onSuccess: (result) => {
      setMessage('Transcription en file : sa progression s’affiche ci-dessous.');
      setJobTitle('Transcription de la vidéo');
      setJobId(result.jobId);
    },
  });

  const propose = useMutation({
    mutationFn: () => api.proposeVideoPlan(contentId ?? '', sourceAssetId ?? ''),
    onSuccess: (result) => {
      setPlan(result);
      setStartText(formatTimecodeInput(result.plan.startMs));
      setEndText(formatTimecodeInput(result.plan.endMs));
      setMessage(null);
    },
  });

  const start = useMutation({
    mutationFn: () => {
      if (source === null || plan === null) {
        throw new Error('Choisir une vidéo et proposer un plan avant de lancer le rendu.');
      }
      const draft = buildPlanDraft(startText, endText, {
        sourceDurationMs: source.durationMs ?? plan.video.durationMs,
        maxClipMs: capabilities.data?.maxClipMs ?? plan.policy.maxClipMs,
      });
      if (!draft.ok) throw new Error(draft.error);
      // La provenance part telle quelle : si l'utilisateur a déplacé les bornes,
      // le plan n'est plus celui de l'agent — et c'est écrit en base, pas déduit.
      const moved =
        draft.plan.startMs !== plan.plan.startMs || draft.plan.endMs !== plan.plan.endMs;
      return api.createVideoRender(contentId ?? '', {
        sourceAssetId: source.id,
        planSource: moved ? 'manual' : plan.plan.source,
        plan: {
          startMs: draft.plan.startMs,
          endMs: draft.plan.endMs,
          subtitleMode: 'burned',
          crop: 'vertical_center',
          reason: plan.plan.reason,
        },
      });
    },
    onSuccess: (result) => {
      setJobTitle('Encodage du short');
      setJobId(result.jobId);
      setMessage('Rendu en file : l’encodage a lieu dans le worker, pas dans cette requête.');
      void queryClient.invalidateQueries({ queryKey: ['content-renders', contentId] });
    },
  });

  const resume = useMutation({
    mutationFn: (id: string) => api.resumeVideoRender(id),
    onSuccess: (result) => {
      setJobTitle('Encodage du short');
      setJobId(result.jobId);
      setMessage('Reprise demandée : le même plan, la même source, un nouvel encodage.');
      void queryClient.invalidateQueries({ queryKey: ['content-renders', contentId] });
    },
  });

  const validate = useMutation({
    mutationFn: (id: string) => api.validateVideoRender(id),
    onSuccess: () => {
      setMessage('Montage validé. Rien n’est publié : la publication vidéo reste manuelle.');
      void queryClient.invalidateQueries({ queryKey: ['content-renders', contentId] });
    },
  });

  const error =
    upload.error ??
    transcribe.error ??
    propose.error ??
    start.error ??
    resume.error ??
    validate.error;

  return (
    <section className="space-y-6">
      <header>
        <h2 className="text-lg font-semibold">Montage vidéo</h2>
        <p className="mt-1 text-sm text-slate-600">
          Un short vertical 9:16 sous-titré, à partir d’une vidéo importée et d’un contenu{' '}
          <strong>approuvé</strong>. L’aperçu se regarde avant de valider ; rien n’est publié ici.
        </p>
      </header>

      {capabilities.data && !capabilities.data.ffmpeg && (
        <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          FFmpeg est introuvable sur cette machine : le rendu est impossible. Installer FFmpeg ou
          renseigner <code>FFMPEG_BIN</code>, puis relancer l’API.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-slate-600">Projet</span>
          <ProjectSelect
            projects={projects.data?.projects ?? []}
            value={projectId}
            onChange={(value) => {
              setProjectId(value);
              setContentId(null);
              setSourceAssetId(null);
              setPlan(null);
            }}
          />
        </label>

        <label className="text-sm">
          <span className="block text-slate-600">Contenu approuvé</span>
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            aria-label="Contenu approuvé"
            value={contentId ?? ''}
            disabled={projectId === null}
            onChange={(event) => {
              setContentId(event.target.value || null);
              setPlan(null);
            }}
          >
            <option value="">Choisir un contenu…</option>
            {approved.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label} · {item.target}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="block text-slate-600">Importer une vidéo</span>
          <input
            type="file"
            aria-label="Fichier vidéo"
            accept={(capabilities.data?.acceptedMimeTypes ?? []).join(',')}
            disabled={projectId === null || upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
            }}
          />
        </label>
      </div>

      {contentId !== null && approved.length === 0 && (
        <p className="text-sm text-slate-600">
          Aucun contenu approuvé dans ce projet : approuver une version avant de monter une vidéo.
        </p>
      )}

      {error && (
        <p className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {error.message}
        </p>
      )}
      {message && (
        <p className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {message}
        </p>
      )}

      {videos.data && videos.data.videos.length > 0 && (
        <ul className="space-y-2">
          {videos.data.videos.map((video) => (
            <li key={video.id} className="rounded border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <p className="font-medium">{describeSource(video)}</p>
                  <p className="text-slate-600">
                    {video.transcript.available
                      ? `Transcription prête · ${video.transcript.segments} segment(s) · ${
                          video.transcript.language ?? 'langue inconnue'
                        }`
                      : 'Aucune transcription'}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-1 text-sm"
                    onClick={() => setSourceAssetId(video.id)}
                  >
                    Choisir cette vidéo
                  </button>
                  <button
                    type="button"
                    className="rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50"
                    disabled={video.hasAudio === false || transcribe.isPending}
                    onClick={() => transcribe.mutate(video.id)}
                  >
                    Transcrire
                  </button>
                </div>
              </div>
              {sourceAssetId !== video.id && (
                <video
                  className="mt-2 h-40 rounded bg-slate-900"
                  controls
                  preload="metadata"
                  aria-label={`Aperçu de la source ${video.id}`}
                  src={api.sourceFileUrl(video.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      {source !== null && (
        <div className="rounded border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Vidéo retenue : {describeSource(source)}</p>
            <button
              type="button"
              className="rounded bg-slate-900 px-3 py-1 text-sm text-white disabled:opacity-50"
              disabled={contentId === null || blocker !== null || propose.isPending}
              onClick={() => propose.mutate()}
            >
              Proposer un montage
            </button>
          </div>
          {blocker !== null && <p className="mt-2 text-sm text-amber-800">{blocker}</p>}

          {plan !== null && (
            <div className="mt-3 space-y-3 text-sm">
              <p>
                Plan proposé : <strong>{planSummary(plan)}</strong>{' '}
                {plan.usedFallback
                  ? '· calculé par défaut (code)'
                  : '· proposé par l’agent de montage'}
              </p>
              <p className="text-slate-600">{plan.plan.reason}</p>
              {plan.fallbackReason && (
                <p className="text-amber-800">Repli : {plan.fallbackReason}</p>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <label>
                  <span className="block text-slate-600">Début</span>
                  <input
                    className="w-24 rounded border border-slate-300 px-2 py-1"
                    aria-label="Début de l’extrait"
                    value={startText}
                    onChange={(event) => setStartText(event.target.value)}
                  />
                </label>
                <label>
                  <span className="block text-slate-600">Fin</span>
                  <input
                    className="w-24 rounded border border-slate-300 px-2 py-1"
                    aria-label="Fin de l’extrait"
                    value={endText}
                    onChange={(event) => setEndText(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50"
                  disabled={start.isPending}
                  onClick={() => start.mutate()}
                >
                  Lancer le rendu
                </button>
              </div>

              {plan.warnings.length > 0 && (
                <ul className="list-disc pl-5 text-amber-800">
                  {plan.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}

      {progress !== null && <JobProgressBar progress={progress} title={jobTitle} />}

      {renders.data && renders.data.renders.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-medium">Rendus de ce contenu</h3>
          {renders.data.renders.map((render) => (
            <RenderCard
              key={render.id}
              render={render}
              statusText={statusLabel(capabilities.data, render.status)}
              onResume={() => resume.mutate(render.id)}
              onValidate={() => validate.mutate(render.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Une carte de rendu : statut, plan retenu, aperçu, action. Rien n'est implicite —
 * un échec affiche sa raison, un rendu en cours affiche sa progression, et un
 * rendu terminé non validé propose **une seule** action : le regarder et valider.
 */
function RenderCard({
  render,
  statusText,
  onResume,
  onValidate,
}: {
  render: VideoRenderView;
  statusText: string;
  onResume: () => void;
  onValidate: () => void;
}) {
  return (
    <article className="rounded border border-slate-200 p-3" data-render={render.id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <strong>{statusText}</strong> · {render.progress} % ·{' '}
          {render.plan
            ? `${formatMs(render.plan.startMs)} → ${formatMs(render.plan.endMs)} (${formatMs(
                render.plan.endMs - render.plan.startMs,
              )})`
            : 'plan illisible'}
          {render.durationMs !== null ? ` · rendu ${formatMs(render.durationMs)}` : ''}
        </p>
        <div className="flex gap-2">
          {render.status !== 'completed' && (
            <button
              type="button"
              className="rounded border border-slate-300 px-2 py-1 text-sm"
              onClick={onResume}
            >
              Reprendre
            </button>
          )}
          {render.status === 'completed' && render.validatedAt === null && (
            <button
              type="button"
              className="rounded bg-slate-900 px-2 py-1 text-sm text-white"
              onClick={onValidate}
            >
              Valider le montage
            </button>
          )}
          {render.validatedAt !== null && (
            <span className="text-sm text-emerald-700" data-validated="true">
              Validé
            </span>
          )}
        </div>
      </div>

      {render.error !== null && (
        <p className="mt-2 text-sm text-rose-800">
          Échec : {render.error.message ?? 'raison inconnue'}
        </p>
      )}

      {render.status === 'completed' && (
        <video
          className="mt-2 h-64 rounded bg-slate-900"
          controls
          preload="metadata"
          aria-label="Aperçu du short"
          src={api.renderFileUrl(render.id)}
        />
      )}
    </article>
  );
}
