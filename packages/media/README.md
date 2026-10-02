# `@aia/media` — stockage audio et transcription locale

L'étape 6 implémente ici la frontière média minimale nécessaire à l'entrée
vocale : stockage local, validation par signature, normalisation WAV mono 16 kHz
avec FFmpeg et transcription avec `whisper-cli`.

Ce qui arrivera ici, et quand :

| Étape | Contenu | Document de référence |
|---|---|---|
| 6 | Entrée vocale, déduplication par hash et transcription locale (`Transcriber`) | docs/16 |
| 7 | Pipeline vidéo FFmpeg : découpe, silences, sous-titres, burn-in, export | docs/10 §4.7 |

Les arguments FFmpeg et whisper.cpp sont construits par des fonctions pures et
les processus sont lancés sans shell. Les noms envoyés par le navigateur ne sont
jamais utilisés comme chemins de stockage.

Un binaire ou un modèle absent est traité comme une capacité dégradée : l'entrée
texte reste disponible.

## Ce que le paquet contient (étape 6)

| Fichier | Rôle |
|---|---|
| `src/index.ts` | `StorageAdapter` (`LocalStorageAdapter`), détection de format par signature, `voiceStorageKey`, `sha256`, `buildNormalizeAudioArgs`, `buildWhisperArgs`, `parseWhisperJson`, `WhisperCppTranscriber`, `ScriptedTranscriber` |
| `src/retention.ts` | `DEFAULT_AUDIO_RETENTION_MS`, `decideAudioPurge` (règle pure), `sweepOrphanAudio` (suppression fichier **puis** ligne) |
| `src/index.test.ts` | Les tests, sans binaire : un `CommandRunner` injecté écrit de **vrais** fichiers |

Le paquet ne lit **aucune** variable d'environnement : les chemins des binaires et
du modèle lui sont passés en options. C'est `apps/worker/src/bootstrap.ts` qui les
lit depuis `@aia/config` (`WHISPER_BIN`, `WHISPER_MODEL_PATH`, `FFMPEG_BIN`), ce
qui permet aux tests d'injecter un autre moteur sans toucher à l'environnement.

## Installation du moteur local

```bash
# FFmpeg (déjà présent sur ce poste : n9.0.2)
sudo pacman -S ffmpeg          # ou apt install ffmpeg

# whisper.cpp : le binaire doit s'appeler whisper-cli, ou être nommé par WHISPER_BIN
# Le modèle doit exister au chemin WHISPER_MODEL_PATH (data/models/ggml-small.bin par défaut)
```

Sans binaire ni modèle, `GET /media/capabilities` répond `available: false` avec
la raison exacte, l'écran l'affiche, et le bouton d'enregistrement reste inactif :
rien n'échoue en silence.

## Purge des audios orphelins (docs/03 §12.1)

```bash
pnpm media:purge                                  # simulation (par défaut)
pnpm media:purge --apply                          # suppression réelle
pnpm media:purge -- --apply --retention-days=7 --limit=500
```

Un audio **rattaché à un message n'est jamais touché** : c'est la preuve de ce qui
a été publié. Seuls les brouillons (transcrits mais jamais envoyés) sortent, après
la fenêtre de rétention (trente jours par défaut).

