import { describe, expect, it } from 'vitest';
import {
  canConfirmTranscript,
  isBusyStage,
  isTerminalJobStatus,
  jobFailed,
  microphoneErrorMessage,
  preferredRecordingMimeType,
  transcriptDraft,
  transcriptionUnavailableNotice,
  voiceStage,
  voiceStageLabel,
  type VoiceStageInput,
} from './voice';

/**
 * L'écran vocal doit rester compréhensible dans six situations différentes, et
 * ne jamais envoyer de texte sans relecture. Ces deux exigences se vérifient
 * ici, sans navigateur, sans microphone et sans whisper.cpp.
 */

function input(overrides: Partial<VoiceStageInput> = {}): VoiceStageInput {
  return {
    recording: false,
    uploading: false,
    jobStatus: null,
    hasTranscript: false,
    localError: null,
    ...overrides,
  };
}

describe('état affiché de l’entrée vocale (docs/05 §3.2)', () => {
  it('suit la chaîne complète : repos → enregistrement → upload → file → transcription → prêt', () => {
    expect(voiceStage(input())).toBe('idle');
    expect(voiceStage(input({ recording: true }))).toBe('recording');
    expect(voiceStage(input({ uploading: true }))).toBe('uploading');
    expect(voiceStage(input({ jobStatus: 'queued' }))).toBe('queued');
    expect(voiceStage(input({ jobStatus: 'running' }))).toBe('transcribing');
    expect(voiceStage(input({ jobStatus: 'completed', hasTranscript: true }))).toBe('ready');
  });

  it('affiche l’erreur locale avant tout le reste : sans micro, rien ne peut avancer', () => {
    expect(
      voiceStage(input({ localError: 'Micro refusé', recording: true, jobStatus: 'queued' })),
    ).toBe('failed');
  });

  it('laisse la transcription disponible primer sur un job encore en file', () => {
    // Même fichier envoyé deux fois : le job repart, mais le texte est déjà là.
    expect(voiceStage(input({ jobStatus: 'queued', hasTranscript: true }))).toBe('ready');
  });

  it('n’efface jamais un échec de job derrière un statut obsolète', () => {
    for (const status of ['failed', 'dead', 'cancelled']) {
      expect(voiceStage(input({ jobStatus: status }))).toBe('failed');
      expect(jobFailed(status)).toBe(true);
    }
    expect(jobFailed('completed')).toBe(false);
    // `completed` sans transcription lisible n'est pas « prêt » : on attend la
    // réponse de l'API plutôt que d'ouvrir un second enregistrement.
    expect(voiceStage(input({ jobStatus: 'completed' }))).toBe('transcribing');
  });

  it('arrête d’interroger l’API sur les statuts terminaux', () => {
    expect(isTerminalJobStatus('completed')).toBe(true);
    expect(isTerminalJobStatus('dead')).toBe(true);
    expect(isTerminalJobStatus('running')).toBe(false);
    expect(isTerminalJobStatus(null)).toBe(false);
  });

  it('marque comme occupés les états pendant lesquels un seul audio peut exister', () => {
    expect(isBusyStage('recording')).toBe(true);
    expect(isBusyStage('uploading')).toBe(true);
    expect(isBusyStage('queued')).toBe(true);
    expect(isBusyStage('transcribing')).toBe(true);
    expect(isBusyStage('idle')).toBe(false);
    expect(isBusyStage('ready')).toBe(false);
    expect(isBusyStage('failed')).toBe(false);
  });

  it('borne le pourcentage affiché', () => {
    expect(voiceStageLabel('transcribing', 150)).toContain('100 %');
    expect(voiceStageLabel('transcribing', -5)).toContain('0 %');
    expect(voiceStageLabel('ready')).toContain('relisez');
  });
});

describe('relecture obligatoire avant envoi (docs/05 §3.2)', () => {
  const draft = 'J’ai automatisé la facturation avec n8n.';

  it('n’autorise l’envoi qu’une fois la transcription prête', () => {
    expect(canConfirmTranscript({ stage: 'ready', draft, sending: false })).toBe(true);
    for (const stage of ['idle', 'recording', 'uploading', 'queued', 'transcribing'] as const) {
      expect(canConfirmTranscript({ stage, draft, sending: false })).toBe(false);
    }
  });

  it('refuse un texte vide, un texte blanc et un envoi déjà en cours', () => {
    expect(canConfirmTranscript({ stage: 'ready', draft: '   \n ', sending: false })).toBe(false);
    expect(canConfirmTranscript({ stage: 'ready', draft: '', sending: false })).toBe(false);
    expect(canConfirmTranscript({ stage: 'ready', draft, sending: true })).toBe(false);
  });
});

describe('texte proposé à la relecture', () => {
  it('préfère la correction enregistrée au texte brut du moteur', () => {
    expect(transcriptDraft({ text: 'brut', editedBody: '  corrigé  ' })).toBe('  corrigé  ');
    expect(transcriptDraft({ text: 'brut', editedBody: null })).toBe('brut');
    expect(transcriptDraft({ text: 'brut', editedBody: '   ' })).toBe('brut');
    expect(transcriptDraft(null)).toBe('');
  });
});

describe('erreurs de microphone (la phrase que l’utilisateur peut suivre)', () => {
  it('traduit les noms d’exception du navigateur', () => {
    expect(microphoneErrorMessage({ name: 'NotAllowedError' })).toContain('refusé');
    expect(microphoneErrorMessage({ name: 'PermissionDeniedError' })).toContain('refusé');
    expect(microphoneErrorMessage({ name: 'NotFoundError' })).toContain('Aucun microphone');
    expect(microphoneErrorMessage({ name: 'DevicesNotFoundError' })).toContain('Aucun microphone');
    expect(microphoneErrorMessage({ name: 'NotReadableError' })).toContain('déjà utilisé');
    expect(microphoneErrorMessage({ name: 'SecurityError' })).toContain('origine sécurisée');
  });

  it('retombe sur le message de l’erreur, puis sur une phrase générique', () => {
    expect(microphoneErrorMessage(new Error('Permission denied by policy'))).toContain(
      'Permission denied by policy',
    );
    expect(microphoneErrorMessage({ name: 'WeirdError' })).toContain('Microphone indisponible');
    expect(microphoneErrorMessage(null)).toContain('Microphone indisponible');
  });
});

describe('format d’enregistrement (celui que l’API sait reconnaître)', () => {
  it('choisit le premier conteneur supporté par le navigateur', () => {
    expect(preferredRecordingMimeType((type) => type.startsWith('audio/ogg'))).toBe(
      'audio/ogg;codecs=opus',
    );
    expect(preferredRecordingMimeType(() => false)).toBe('');
  });
});

describe('moteur absent : le bouton grisé est expliqué (docs/10 §4.6)', () => {
  it('n’affiche rien quand le moteur répond, ni tant que la réponse n’est pas là', () => {
    expect(transcriptionUnavailableNotice(undefined)).toBeNull();
    expect(transcriptionUnavailableNotice({ available: true })).toBeNull();
  });

  it('recopie le détail du serveur, parce que c’est lui qui sait ce qui manque', () => {
    expect(
      transcriptionUnavailableNotice({
        available: false,
        detail: 'Modèle whisper absent : data/models/ggml-small.bin.',
      }),
    ).toBe('Enregistrement indisponible : Modèle whisper absent : data/models/ggml-small.bin.');
  });

  it('garde une phrase utilisable même sans détail', () => {
    expect(transcriptionUnavailableNotice({ available: false })).toContain(
      'Enregistrement indisponible',
    );
    expect(transcriptionUnavailableNotice({ available: false, detail: '   ' })).toContain(
      'transcription locale',
    );
  });
});
