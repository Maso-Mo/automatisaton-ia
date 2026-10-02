/**
 * Logique d'écran de l'entrée vocale, **sans React** (docs/09 §1).
 *
 * Trois choses peuvent être fausses dans cet écran, et les trois se vérifient
 * sans navigateur :
 *
 * 1. **l'état affiché** — c'est ce qui décide si l'utilisateur attend ou
 *    recommence, donc il se calcule ici, à partir de trois faits observables ;
 * 2. **le droit d'envoyer** — la transcription ne part qu'après relecture
 *    explicite (docs/05 §3.2) : une seule fonction répond oui ou non ;
 * 3. **le message d'erreur du microphone** — le navigateur lève des exceptions
 *    nommées (`NotAllowedError`, `NotFoundError`…), jamais des phrases lisibles.
 */

/** Les états visibles de l'enregistrement. Un seul à la fois, jamais deux. */
export type VoiceStage =
  'idle' | 'recording' | 'uploading' | 'queued' | 'transcribing' | 'ready' | 'failed';

/** États de job qui n'évolueront plus : on arrête d'interroger l'API. */
export const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'dead']);

export function isTerminalJobStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && TERMINAL_JOB_STATUSES.has(status);
}

/** Un job terminé **sans** transcription exploitable : c'est un échec pour l'écran. */
export function jobFailed(status: string | null | undefined): boolean {
  return status === 'failed' || status === 'dead' || status === 'cancelled';
}

export interface VoiceStageInput {
  /** Le `MediaRecorder` tourne. */
  recording: boolean;
  /** Le blob est en cours de téléversement. */
  uploading: boolean;
  /** Statut du job, tel que servi par l'API (`null` tant qu'aucun job n'existe). */
  jobStatus: string | null;
  /** Une transcription est disponible (brute ou corrigée). */
  hasTranscript: boolean;
  /** Panne locale : micro refusé, upload rejeté, envoi refusé. */
  localError: string | null;
}

/**
 * L'état affiché, par ordre de priorité. L'ordre **est** la règle :
 *
 * - une **erreur locale** passe avant tout le reste : sans micro, aucune
 *   progression n'est possible, et l'afficher est la seule information utile ;
 * - l'**enregistrement** passe avant tout le reste sauf l'erreur : c'est le seul
 *   état qui dépend d'une action en cours de l'utilisateur (il doit arrêter) ;
 * - la **transcription disponible** passe avant l'état du job : un audio déjà
 *   transcrit (même fichier renvoyé, page rechargée) est immédiatement
 *   relisible, même si un job traîne encore ;
 * - l'**échec du job** est terminal : il ne doit jamais être masqué par un
 *   `queued` obsolète ;
 * - `queued` et `transcribing` ne diffèrent que par ce que fait le worker : la
 *   file, puis le décodage whisper.cpp — deux attentes perçues différemment.
 *   Tout autre statut non terminal (dont `completed` dont la transcription n'est
 *   pas encore lisible) reste « en cours » : ouvrir un second enregistrement
 *   pendant ce temps ferait perdre le premier.
 */
export function voiceStage(input: VoiceStageInput): VoiceStage {
  if (input.localError !== null) return 'failed';
  if (input.recording) return 'recording';
  if (input.uploading) return 'uploading';
  if (jobFailed(input.jobStatus)) return 'failed';
  if (input.hasTranscript) return 'ready';
  if (input.jobStatus === 'queued') return 'queued';
  if (input.jobStatus !== null) return 'transcribing';
  return 'idle';
}

/** L'écran est occupé : ni nouvel enregistrement, ni nouvel envoi possibles. */
export function isBusyStage(stage: VoiceStage): boolean {
  return (
    stage === 'recording' || stage === 'uploading' || stage === 'queued' || stage === 'transcribing'
  );
}

/**
 * Le libellé affiché : **ce qui se passe maintenant**, et ce que l'utilisateur
 * peut faire. Jamais « chargement… », jamais un pourcentage inventé.
 */
export function voiceStageLabel(stage: VoiceStage, progress = 0): string {
  switch (stage) {
    case 'recording':
      return 'Enregistrement en cours… parlez, puis cliquez sur « Arrêter ».';
    case 'uploading':
      return 'Téléversement vers l’API locale…';
    case 'queued':
      return 'En attente du worker local…';
    case 'transcribing':
      return `Transcription locale par whisper.cpp… ${Math.min(100, Math.max(0, Math.round(progress)))} %`;
    case 'ready':
      return 'Transcription prête : relisez-la, corrigez-la, puis envoyez-la.';
    case 'failed':
      return 'La transcription n’a pas abouti.';
    case 'idle':
      return 'Le texte ne sera envoyé qu’après votre relecture.';
  }
}

/**
 * Le texte proposé à la relecture : la **correction** si elle existe, sinon la
 * sortie brute du moteur. Jamais les deux concaténées, jamais une paraphrase :
 * ce que l'utilisateur relit doit être exactement ce qu'il a dit.
 */
export function transcriptDraft(
  transcript: { text: string; editedBody: string | null } | null | undefined,
): string {
  if (!transcript) return '';
  const edited = transcript.editedBody?.trim();
  if (edited !== undefined && edited.length > 0) return transcript.editedBody ?? edited;
  return transcript.text;
}

/**
 * Le **seul** endroit qui autorise l'envoi (docs/05 §3.2 : jamais d'envoi
 * automatique). Trois conditions : une transcription prête, un texte non vide,
 * aucun envoi déjà en cours. Un état antérieur (`queued`, `transcribing`,
 * `recording`) ne peut donc pas envoyer, même si l'écran contenait du texte.
 */
export function canConfirmTranscript(input: {
  stage: VoiceStage;
  draft: string;
  sending: boolean;
}): boolean {
  return input.stage === 'ready' && !input.sending && input.draft.trim().length > 0;
}

/**
 * Pourquoi « Enregistrer » est inactif quand la transcription locale n'est pas
 * prête, ou `null` quand tout va bien.
 *
 * Un bouton grisé sans explication est exactement ce que le projet s'interdit :
 * l'utilisateur croit à un bug. La cause est connue — c'est le `detail` que
 * `GET /media/capabilities` renvoie (`WhisperCppTranscriber.healthCheck`) et qui
 * nomme ce qui manque : le modèle, le binaire, ou ce que le binaire a répondu.
 * Le composant ne rédige donc rien : il affiche la phrase du serveur.
 */
export function transcriptionUnavailableNotice(
  health: { available: boolean; detail?: string } | undefined,
): string | null {
  if (!health || health.available) return null;
  const detail = health.detail?.trim();
  return detail !== undefined && detail.length > 0
    ? `Enregistrement indisponible : ${detail}`
    : 'Enregistrement indisponible : la transcription locale n’est pas installée sur ce poste.';
}

/**
 * Traduit une exception de `getUserMedia` en phrase actionnable.
 *
 * `DOMException.name` est la seule information fiable : les navigateurs donnent
 * les mêmes noms mais des messages différents, parfois vides. Les noms
 * historiques (`PermissionDeniedError`, `DevicesNotFoundError`) sont conservés —
 * Safari les a utilisés pendant des années.
 */
export function microphoneErrorMessage(cause: unknown): string {
  const name =
    typeof cause === 'object' && cause !== null && 'name' in cause
      ? String((cause as { name?: unknown }).name ?? '')
      : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Accès au microphone refusé. Autorisez-le pour ce site dans votre navigateur, puis réessayez.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'Aucun microphone détecté sur cet ordinateur.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Le microphone est déjà utilisé par une autre application. Fermez-la, puis réessayez.';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'Le microphone disponible ne correspond pas à la configuration demandée.';
    case 'SecurityError':
      return 'L’enregistrement exige une origine sécurisée : ouvrez l’application sur http://localhost ou en https.';
    case 'AbortError':
      return 'L’ouverture du microphone a été interrompue. Réessayez.';
    default: {
      const message = cause instanceof Error ? cause.message : '';
      return message.length > 0
        ? `Microphone indisponible : ${message}`
        : 'Microphone indisponible : le navigateur n’a pas pu l’ouvrir.';
    }
  }
}

/**
 * Le seul conteneur que le navigateur sait produire *et* que l'API accepte
 * (`detectAudioFormat` reconnaît WebM, Ogg, WAV, MP3 et M4A).
 */
export function preferredRecordingMimeType(
  isSupported: (mimeType: string) => boolean = (mimeType) =>
    typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType),
): string {
  const choices = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return choices.find((type) => isSupported(type)) ?? '';
}
