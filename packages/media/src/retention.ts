/**
 * Politique de rétention des audios — **la seule règle qui décide** si un
 * enregistrement peut être supprimé du disque.
 *
 * Pourquoi une fonction pure, et pas un `if` dans le worker : la suppression
 * d'un fichier est irréversible, et l'audio d'un message envoyé fait partie de
 * la trace auditable du contenu publié (docs/03 §12.1). Une règle dispersée
 * finirait par supprimer un audio référencé le jour où l'on ajoute un usage
 * (un rendu vidéo, une seconde transcription). Ici, un seul endroit décide, et
 * il se teste sans base ni disque.
 *
 * Les durées de vie, elles, dépendent du **moment** :
 *
 * | Cas | Ce qui est conservé | Pourquoi |
 * |---|---|---|
 * | Enregistrement annulé avant envoi | rien : le navigateur n'a jamais téléversé le blob | il n'existe aucune ressource serveur |
 * | Téléversement accepté, transcription en cours | l'audio et son job | le job doit pouvoir être repris |
 * | Transcription échouée (transitoire) | l'audio | la reprise rejoue le même fichier |
 * | Transcription échouée (définitive) | l'audio, jusqu'à la fenêtre de reprise | l'utilisateur peut relire et réessayer |
 * | Transcription réussie, message **envoyé** | l'audio **pour toujours** | il est la preuve de ce qui a été dit |
 * | Transcription réussie, message jamais envoyé | l'audio, jusqu'à la fenêtre orpheline | c'est un brouillon |
 * | Processus tué pendant une transcription | l'audio | le bail du job expire, la file reprend |
 */

/** Trente jours : la fenêtre pendant laquelle un brouillon vocal reste récupérable. */
export const DEFAULT_AUDIO_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface AudioPurgeInput {
  /** Le nombre de fois où l'audio a été rattaché à un message (`usage_count`). */
  usageCount: number;
  /** Rattaché à un message, même si le compteur n'a pas encore été incrémenté. */
  attachedToMessage: boolean;
  createdAtMs: number;
  nowMs: number;
  retentionMs: number;
}

export interface AudioPurgeDecision {
  purge: boolean;
  reason: string;
}

/**
 * Décide du sort d'un audio **jamais référencé par un message**.
 *
 * Une seule raison autorise la suppression : plus aucun message ne le référence
 * **et** il est plus vieux que la fenêtre de rétention. Tout le reste est
 * conservé — y compris un audio récent, dont la suppression détruirait la
 * correction en cours de l'utilisateur.
 */
export function decideAudioPurge(input: AudioPurgeInput): AudioPurgeDecision {
  if (input.usageCount > 0 || input.attachedToMessage) {
    return {
      purge: false,
      reason: 'audio rattaché à un message : il reste la preuve de ce qui a été envoyé',
    };
  }

  const ageMs = input.nowMs - input.createdAtMs;
  if (ageMs < input.retentionMs) {
    return {
      purge: false,
      reason: `audio orphelin mais récent (${Math.max(0, Math.round(ageMs / 1_000))} s) : fenêtre de reprise ouverte`,
    };
  }

  return {
    purge: true,
    reason: `audio orphelin depuis ${Math.floor(ageMs / 86_400_000)} jour(s) : aucun message ne le référence`,
  };
}
/**
 * Le **balayeur** : applique le verdict de `decideAudioPurge` à ce que la base
 * sait proposer, et rien de plus.
 *
 * Il vit ici, dans le paquet média, et non dans le worker, pour deux raisons :
 * la commande `pnpm media:purge` et le worker doivent exécuter **exactement** la
 * même règle ; et la suppression de fichiers est irréversible, donc elle se teste
 * sans binaire, sans réseau et sans horloge réelle.
 *
 * Les deux ports ci-dessous sont structurels : `MediaStore` (`@aia/database`) et
 * `StorageAdapter` (`@aia/media`) les satisfont tels quels, sans que le paquet
 * média dépende de la base (docs/02 §5).
 */
export interface OrphanAudioCandidate {
  id: string;
  storageKey: string;
  usageCount: number;
  createdAt: number;
}

export interface AudioRetentionStore {
  /** Candidats bruts : audios de type `audio`, non référencés, antérieurs au seuil. */
  orphanAudioAssets(cutoffMs: number, limit?: number): OrphanAudioCandidate[];
  deleteAsset(id: string): void;
}

export interface AudioRetentionStorage {
  delete(key: string): Promise<void>;
}

export interface AudioSweepInput {
  store: AudioRetentionStore;
  storage: AudioRetentionStorage;
  nowMs: number;
  retentionMs?: number;
  limit?: number;
  /** `true` : on décide et on journalise, on ne supprime **rien**. */
  dryRun?: boolean;
}

export interface AudioSweepReport {
  /** Candidats examinés (le plus ancien d'abord). */
  examined: number;
  purged: { assetId: string; storageKey: string; reason: string }[];
  kept: { assetId: string; reason: string }[];
  dryRun: boolean;
}

/**
 * Supprime les audios orphelins, du **fichier vers la ligne**.
 *
 * Cet ordre est le seul sûr : si le processus est tué entre les deux, il reste
 * une ligne qui pointe vers un fichier absent — état que le reste du code sait
 * déjà traiter (`exists()` puis réécriture) et que le balayage suivant rattrape.
 * L'ordre inverse laisserait un fichier que plus rien ne référence : invisible,
 * et jamais réclamé par personne.
 */
export async function sweepOrphanAudio(input: AudioSweepInput): Promise<AudioSweepReport> {
  const retentionMs = input.retentionMs ?? DEFAULT_AUDIO_RETENTION_MS;
  const dryRun = input.dryRun ?? false;
  const candidates = input.store.orphanAudioAssets(input.nowMs - retentionMs, input.limit ?? 200);
  const report: AudioSweepReport = { examined: candidates.length, purged: [], kept: [], dryRun };

  for (const candidate of candidates) {
    const decision = decideAudioPurge({
      usageCount: candidate.usageCount,
      attachedToMessage: false,
      createdAtMs: candidate.createdAt,
      nowMs: input.nowMs,
      retentionMs,
    });

    if (!decision.purge) {
      report.kept.push({ assetId: candidate.id, reason: decision.reason });
      continue;
    }

    if (!dryRun) {
      await input.storage.delete(candidate.storageKey);
      input.store.deleteAsset(candidate.id);
    }
    report.purged.push({
      assetId: candidate.id,
      storageKey: candidate.storageKey,
      reason: decision.reason,
    });
  }

  return report;
}
