import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type TurnResponse } from '../../api/client';
import {
  canConfirmTranscript,
  isBusyStage,
  isTerminalJobStatus,
  microphoneErrorMessage,
  preferredRecordingMimeType,
  transcriptDraft,
  transcriptionUnavailableNotice,
  voiceStage,
  voiceStageLabel,
} from './voice';

/**
 * Entrée vocale (étape 6).
 *
 * Ce que le composant fait, et rien de plus : il enregistre, il téléverse, il
 * attend la transcription locale, il laisse corriger, et il **attend un clic**
 * pour envoyer. Aucun état intermédiaire n'envoie quoi que ce soit — c'est
 * `canConfirmTranscript` qui le garantit, et cette règle est testée hors
 * navigateur (`voice.test.ts`).
 *
 * Deux détails viennent du monde réel :
 *
 * - le **texte** est demandé dès que l'audio existe, sans attendre le statut du
 *   job : un audio déjà transcrit (même fichier renvoyé, page rechargée) est
 *   relisible tout de suite, sans repasser par la file ;
 * - les erreurs de microphone sont **nommées** par le navigateur
 *   (`NotAllowedError`, `NotFoundError`…), jamais rédigées : la traduction en
 *   français est dans `microphoneErrorMessage`.
 */
export function VoiceInput(props: {
  conversationId: string;
  disabled?: boolean;
  onSent(result: TurnResponse): void;
  onError(message: string): void;
}) {
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [corrected, setCorrected] = useState('');
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const supported =
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices !== undefined;

  const capabilities = useQuery({
    queryKey: ['voice-capabilities'],
    queryFn: api.voiceCapabilities,
    staleTime: 30_000,
  });

  const reset = (): void => {
    setAssetId(null);
    setJobId(null);
    setCorrected('');
    setLocalError(null);
    setAudioUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  };

  const upload = useMutation({
    mutationFn: (audio: Blob) => api.uploadVoice(props.conversationId, audio),
    onSuccess: (result) => {
      setLocalError(null);
      setAssetId(result.asset.id);
      setJobId(result.jobId);
    },
    onError: (cause: Error) => setLocalError(cause.message),
  });

  const job = useQuery({
    queryKey: ['voice-job', jobId],
    queryFn: () => api.job(jobId ?? ''),
    enabled: jobId !== null,
    refetchInterval: (query) => (isTerminalJobStatus(query.state.data?.job.status) ? false : 1_000),
  });

  const transcript = useQuery({
    queryKey: ['voice-transcript', props.conversationId, assetId],
    queryFn: () => api.voiceTranscript(props.conversationId, assetId ?? ''),
    enabled: assetId !== null,
    // On interroge l'API tant que le texte n'est pas là : c'est le seul fait qui
    // compte, et il arrive parfois avant que le statut du job ne soit lisible.
    refetchInterval: (query) => (query.state.data?.transcript ? false : 1_000),
  });

  const transcriptData = transcript.data?.transcript ?? null;

  useEffect(() => {
    // Une correction déjà saisie n'est jamais écrasée par une réponse tardive.
    if (transcriptData === null) return;
    setCorrected((current) =>
      current.trim().length > 0 ? current : transcriptDraft(transcriptData),
    );
  }, [transcriptData]);

  useEffect(
    () => () => {
      stream.current?.getTracks().forEach((track) => track.stop());
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    },
    [audioUrl],
  );

  const send = useMutation({
    mutationFn: () => api.sendVoiceTranscript(props.conversationId, assetId ?? '', corrected),
    onSuccess: (result) => {
      props.onSent(result);
      reset();
    },
    onError: (cause: Error) => props.onError(cause.message),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelVoice(props.conversationId, assetId ?? ''),
    onSuccess: () => reset(),
    onError: (cause: Error) => setLocalError(cause.message),
  });

  const start = async (): Promise<void> => {
    try {
      setLocalError(null);
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = mediaStream;
      chunks.current = [];
      const mimeType = preferredRecordingMimeType();
      const nextRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
      nextRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      });
      nextRecorder.addEventListener('stop', () => {
        const blob = new Blob(chunks.current, {
          type: nextRecorder.mimeType || mimeType || 'application/octet-stream',
        });
        setAudioUrl((current) => {
          if (current) URL.revokeObjectURL(current);
          return URL.createObjectURL(blob);
        });
        mediaStream.getTracks().forEach((track) => track.stop());
        stream.current = null;
        // Le blob part une seule fois : toute l'écoute se fait côté serveur.
        upload.mutate(blob);
      });
      recorder.current = nextRecorder;
      nextRecorder.start(250);
      setRecording(true);
    } catch (cause) {
      stream.current?.getTracks().forEach((track) => track.stop());
      stream.current = null;
      setLocalError(microphoneErrorMessage(cause));
    }
  };

  const stop = (): void => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  };

  const stage = voiceStage({
    recording,
    uploading: upload.isPending,
    jobStatus: job.data?.job.status ?? null,
    hasTranscript: transcriptData !== null,
    localError,
  });
  const available = capabilities.data?.transcription.available ?? false;
  const canSend = canConfirmTranscript({ stage, draft: corrected, sending: send.isPending });
  const maxUploadMb = Math.floor((capabilities.data?.maxUploadBytes ?? 0) / (1024 * 1024));
  const maxDurationMin = Math.floor((capabilities.data?.maxDurationMs ?? 0) / 60_000);
  // Deux raisons différentes d'être inactif, deux phrases différentes : le
  // moteur local n'est pas prêt, ou bien c'est l'API qui ne répond pas.
  const notice = transcriptionUnavailableNotice(
    capabilities.isError
      ? { available: false, detail: 'l’API locale n’a pas répondu sur /media/capabilities.' }
      : capabilities.data?.transcription,
  );

  return (
    <section className="rounded-lg border border-sky-200 bg-sky-50 p-3" aria-label="Entrée vocale">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="text-sm text-sky-950">Réponse vocale</strong>
        {!recording ? (
          <button
            type="button"
            className="rounded bg-sky-800 px-3 py-1 text-sm text-white disabled:opacity-50"
            disabled={
              props.disabled || !supported || !available || isBusyStage(stage) || cancel.isPending
            }
            onClick={() => void start()}
          >
            Enregistrer
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-rose-700 px-3 py-1 text-sm text-white"
            onClick={stop}
          >
            Arrêter
          </button>
        )}
        {assetId !== null && !upload.isPending && (
          <button
            type="button"
            className="rounded border border-slate-400 px-3 py-1 text-sm text-slate-800 disabled:opacity-50"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
            title="Supprime l’enregistrement et sa transcription : rien n’a été envoyé."
          >
            {cancel.isPending ? 'Suppression…' : 'Abandonner'}
          </button>
        )}
        <span className="text-xs text-slate-600" role="status" aria-live="polite">
          {voiceStageLabel(stage, job.data?.job.progress ?? 0)}
        </span>
      </div>

      {notice !== null && (
        <p className="mt-2 text-sm text-amber-800" role="status">
          {notice}
        </p>
      )}

      {audioUrl !== null && (
        // L'audio n'est jamais renvoyé au serveur depuis ce lecteur : il sert
        // uniquement à ce que l'utilisateur entende ce qu'il a enregistré.
        <audio
          className="mt-2 w-full"
          controls
          src={audioUrl}
          aria-label="Enregistrement à relire"
        />
      )}

      {transcriptData !== null && (
        <label className="mt-2 block text-sm text-sky-950">
          Texte reconnu — corrigez-le avant l’envoi
          <textarea
            className="mt-1 h-28 w-full rounded border border-sky-300 p-2 font-sans text-sm text-slate-900"
            value={corrected}
            disabled={stage !== 'ready'}
            onChange={(event) => setCorrected(event.target.value)}
          />
        </label>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded bg-emerald-700 px-3 py-1 text-sm text-white disabled:opacity-50"
          disabled={!canSend}
          onClick={() => send.mutate()}
        >
          {send.isPending ? 'Envoi…' : 'Envoyer cette transcription'}
        </button>
        {stage === 'failed' && (
          <button
            type="button"
            className="rounded border border-slate-400 px-3 py-1 text-sm text-slate-800"
            disabled={cancel.isPending}
            onClick={() => (assetId === null ? reset() : cancel.mutate())}
          >
            Recommencer
          </button>
        )}
        <span className="text-xs text-slate-500">
          {maxDurationMin > 0 && maxUploadMb > 0
            ? `Format accepté : audio jusqu’à ${maxDurationMin} min et ${maxUploadMb} Mo.`
            : 'Aucun texte ne part sans votre confirmation.'}
        </span>
      </div>

      {localError !== null && (
        <p className="mt-2 text-sm text-rose-700" role="alert">
          {localError}
        </p>
      )}
    </section>
  );
}
