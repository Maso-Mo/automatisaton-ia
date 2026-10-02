# 16 — Mise en œuvre de l'étape 6 (entrée vocale et transcription locale)

> Compte rendu de ce qui est **réellement** livré pour l'entrée vocale :
> `docs/05` §3.3 (entrée vocale et fichiers), `docs/03` §10 et §12.1 (médias,
> rétention) et le volet « transcription locale » de `docs/10` §4.6.
> Le reste de `docs/10` §4.6 — import de vidéos et d'images, découpage de clips,
> sauvegarde/restauration, décision D3 — n'est **pas** dans cette livraison, et
> ce document le dit explicitement (§12).

## 1. Résultat livré

L'application encaisse désormais la parole et la transforme en tour de
conversation **relu par l'utilisateur** :

```text
micro du navigateur → MediaRecorder (WebM/Opus)
  → POST /conversations/:id/voice        (contenu validé par signature)
  → fichier sur disque + media_assets    (clé fabriquée par le serveur)
  → job transcribe_media                 (requires_network = false)
  → worker local : FFmpeg → whisper.cpp  → transcripts
  → écran : texte proposé, corrigeable   (rien n'est envoyé)
  → POST …/voice/:assetId/send           (clic explicite)
  → pipeline texte existant              (messages.input_mode = 'voice')
```

Trois garanties structurent cette chaîne, et chacune est prouvée par un test :

- **aucun envoi automatique** : après l'enregistrement et la transcription, la
  conversation ne contient **aucun** message `input_mode = 'voice'`. Le tour
  n'existe qu'après le clic « Envoyer cette transcription » (API vérifiée dans
  `tests/integration/voice-api.test.ts` et `tests/e2e/parcours-voix.spec.ts`) ;
- **le texte qui part est le texte relu** : la correction est écrite dans
  `transcripts.edited_body` avant l'envoi, et c'est elle qui devient le tour ; le
  texte brut du moteur reste en base pour la traçabilité (docs/03 §10.2) ;
- **l'audio d'un message envoyé ne disparaît jamais** : il est rattaché par
  `message_attachments` et la purge refuse tout audio référencé (docs/03 §12.1).

## 2. Les étapes, et ce qui décide à chacune

| Étape | Où | Ce qui décide |
|---|---|---|
| Enregistrement | `apps/web` — `VoiceInput.tsx` + `voice.ts` | Le conteneur est choisi parmi ceux que le **navigateur sait produire** et que l'**API sait reconnaître** (`preferredRecordingMimeType`) |
| Capacité affichée | `GET /media/capabilities` | L'écran annonce la limite **réelle** du serveur (`maxUploadBytes`, `maxDurationMs`) et l'état du moteur ; sans moteur disponible, il le dit au lieu d'afficher un bouton qui échouera |
| Téléversement | `POST /conversations/:id/voice` | Signature du contenu, empreinte SHA-256, déduplication, clé de stockage fabriquée par le serveur |
| File | job `transcribe_media` | `maxAttempts = 2`, backoff 30 s, bail 1 h, `requiresNetwork = false`, déduplication `transcribe:<asset>:<langue>` |
| Transcription | worker local — `handlers/transcribe-media.ts` | Fichier présent, transcription déjà là (réutilisation), plafond de durée **après décodage** |
| Décodage + moteur | `packages/media` — `WhisperCppTranscriber` | FFmpeg normalise en WAV mono 16 kHz, `whisper-cli` rend un JSON de segments horodatés |
| Relecture | `VoiceInput.tsx` | `canConfirmTranscript` : transcription prête, texte non vide, aucun envoi en cours |
| Envoi | `POST …/voice/:assetId/send` | Transcription présente, texte non vide, puis le pipeline texte existant : rattachement de l'audio et marquage `voice` |

## 3. Données : ce que la migration `0005` ajoute, et pourquoi

La migration `0005_step_six_voice_transcription.sql` crée **trois** tables
(`media_assets`, `transcripts`, `message_attachments`) avec leurs index et leurs
contraintes `CHECK`.

`docs/10` §4.6 annonce « aucune table créée à cette étape », parce que le domaine
média est **modélisé** depuis l'étape 3 (docs/03 §10). Une table sans chemin
d'écriture ne rend aucun service : les trois sont créées ici, au moment où un
flux réel les remplit.

| Table | Rôle | Garde-fous |
|---|---|---|
| `media_assets` | Un audio téléversé : empreinte, taille, type, clé de stockage, `usage_count` | `uq_asset_hash (project_id, sha256, role)` : le même enregistrement n'est stocké qu'une fois **par projet** ; `chk_assets_size (size_bytes > 0)` ; `chk_assets_source ('upload')` |
| `transcripts` | La sortie du moteur **et** la correction (`edited_body`) | `uq_transcript_asset (media_asset_id, engine, model)` : jamais deux fois le même travail ; `chk_transcripts_engine` |
| `message_attachments` | Le lien entre un message envoyé et son audio | `uq_attachment (message_id, media_asset_id, kind)` : un rattachement ne se double pas |

Le côté conversation n'a **rien** demandé : `messages.input_mode`,
`messages.audio_asset_id` et `messages.transcript_status` existent depuis
l'étape 3, avec leur contrainte `chk_messages_input_mode`. L'étape 6 les utilise
tels quels — le signe que la modélisation initiale était juste.

### 3.1 Écarts assumés par rapport à docs/03

- **`uq_asset_hash` est projeté sur `project_id`.** docs/03 §10.1 écrit
  `(sha256, role)`. Deux projets peuvent légitimement héberger le même fichier —
  même voix d'essai, même vidéo de référence — et un asset appartient à un projet
  (`usage_count`, `deleted_at`, suppression). Une unicité globale ferait qu'un
  projet supprimant « son » audio casserait le lien d'un autre.
- **`message_attachments.purpose` n'est pas créée.** docs/03 §7.3 la prévoyait
  (`'voice_input'|'example_text'|…`). Aucun chemin de code ne la remplirait
  aujourd'hui, et `kind` (= `'audio'`) suffit à décrire ce qui est rattaché. Une
  colonne que personne n'écrit devient une colonne qui ment : elle sera ajoutée
  le jour où un second usage existera (le même raisonnement vaut pour
  `transcripts.scope` et `media_assets.purpose` de docs/05 §3.3).
- **La fenêtre de rétention par défaut est de 30 jours**, là où docs/03 §12 parle
  de 90 jours pour un asset générique non utilisé. Trente jours sont la fenêtre
  pendant laquelle un **brouillon vocal** reste utile à son auteur : au-delà, il
  n'a plus de texte à récupérer. La valeur est un paramètre
  (`--retention-days`), pas une constante enfouie.

### 3.2 Rétention : une seule règle, exécutable à la main

`packages/media/src/retention.ts` contient la seule fonction qui décide si un
audio peut disparaître du disque (`decideAudioPurge`) et le balayage qui
l'applique (`sweepOrphanAudio`). `pnpm media:purge` **simule** par défaut ;
`--apply` supprime réellement, **fichier avant ligne** — le seul ordre qui laisse
un état réparable si le processus est tué (une ligne vers un fichier absent, que
`exists()` traite déjà). Un audio rattaché à un message n'est jamais touché, et
deux verrous indépendants le garantissent : le filtre SQL (`usage_count = 0`) et
la règle pure.

## 4. Transcription locale : un contrat, deux processus, aucune dépendance réseau

`packages/media` expose un contrat unique — `Transcriber` (`engine`, `model`,
`healthCheck()`, `transcribe()`) — et deux implémentations :

- `WhisperCppTranscriber` : FFmpeg normalise en WAV **mono 16 kHz `pcm_s16le`**
  (`buildNormalizeAudioArgs`), puis `whisper-cli` rend un JSON de segments
  horodatés (`buildWhisperArgs`, `-ojf -of -np`), relu par `parseWhisperJson`.
  Les deux commandes sont lancées **sans shell** (`spawn` avec `shell: false`)
  et leurs sorties sont plafonnées à 1 Mio ; le dossier de travail
  (`aia-transcription-<uuid>`) est supprimé dans un `finally`, même en échec.
- `ScriptedTranscriber` : le moteur des tests. Il sert la même sortie à chaque
  appel, peut annoncer une capacité absente et peut **échouer N fois avant de
  réussir** — c'est ce qui rend une reprise de file observable sans binaire.

Les arguments sont construits par des fonctions **pures**, donc testables sans
exécuter quoi que ce soit : un chemin hostile ne peut pas devenir une commande,
puisqu'il reste un argument entier.

### 4.1 Les erreurs décident, la file tranche (docs/02 §12)

| Situation | Erreur | Catégorie | Conséquence |
|---|---|---|---|
| FFmpeg ne décode pas le fichier | `AUDIO_DECODE_FAILED` | `validation` | Aucune reprise : rejouer le même fichier échouera pareil |
| `whisper-cli` sort en erreur | `WHISPER_FAILED` | `capability` | Aucune reprise : le moteur est en cause, pas le fichier |
| Binaire ou modèle absents | `WHISPER_UNAVAILABLE` | `capability` | Aucune reprise, et `GET /media/capabilities` l'annonce à l'écran |
| JSON illisible | `WHISPER_OUTPUT_INVALID` | `internal` | Aucune reprise ; c'est un bug de format, pas une panne passagère |
| Enregistrement trop long | `AUDIO_TOO_LONG` | `validation` | Aucune reprise, et le motif est affiché |
| Fichier disparu du stockage | `MEDIA_FILE_MISSING` | `not_found` | Aucune reprise |
| Échec transitoire réel | `TransientError` | `transient` | **Reprise** après 30 s, deux tentatives au total |

Le handler ne décide **jamais** de reprendre : il lève une erreur typée, la file
applique la politique. C'est la propriété qui rend les quatre décisions du
handler lisibles — vérifier le fichier avant d'appeler le décodeur, réutiliser
une transcription du même moteur et du même modèle, plafonner la durée après
décodage, ne pas décider de reprise.

### 4.2 Le job `transcribe_media`

```ts
maxAttempts: 2, backoff: () => 30_000, leaseMs: 3_600_000,
idempotent: true, priority: 2, requiresNetwork: false,
dedupeKey: (input) => `transcribe:${input.assetId}:${input.language}`
```

`requiresNetwork: false` **n'est pas décoratif** : c'est ce que la file lit pour
continuer à travailler en mode hors ligne (docs/08). Une transcription locale est
exactement le travail qui doit passer sans réseau. Deux tentatives suffisent :
un décodage raté et un moteur absent n'en méritent aucune, seule une panne
passagère (fichier verrouillé, mémoire pleine) mérite la seconde.

### 4.3 Écart assumé par rapport à docs/02 §9.5

docs/02 fige un contrat `Transcriber` plus large que ce qui est implémenté :

| docs/02 §9.5 | Ici | Pourquoi |
|---|---|---|
| `capabilities(): { languages, wordTimestamps, maxDurationSec }` | Pas de `capabilities()` : `engine`, `model` et `healthCheck()` | `languages` et `wordTimestamps` seraient des constantes de configuration, pas des propriétés du moteur ; `maxDurationSec` dépend du **poste**, et c'est `GET /media/capabilities` qui l'annonce, une fois, au bon endroit |
| `healthCheck(): { ok, modelLoaded, error? }` | `healthCheck(): { available, engine, model, detail? }` | `ok: false` ne dit pas quoi réparer. `detail` porte une phrase actionnable (modèle absent **avec son chemin**, binaire non lançable **avec son nom et `WHISPER_BIN`**, `stderr` du binaire), et l'écran la recopie. Un booléen ne peut pas porter ça |
| `transcribe({ path, language, wordTimestamps })` | `transcribe(inputPath, language?)` | Aucun appelant ne demande de mots horodatés : `has_word_timestamps` reste `false` en base. Ajouter le paramètre aurait créé une option testée mais jamais exercée |
| Rendu `{ text, segments, language, durationSec }` | `{ text, segments, language, durationMs }` | Millisecondes, comme partout ailleurs dans le projet (`start_ms`, `end_ms`, `duration_ms`) : une seule unité évite une conversion à chaque frontière |
| `segments: TranscriptSegment[]` | `{ startMs, endMs, text }` | Même raison |

Ce n'est pas un abandon du contrat : c'est le contrat **minimum** que le produit
utilise, et chaque écart porte une justification. Le jour où un rendu vidéo a
besoin des mots horodatés (étape 7, sous-titres), c'est `transcribe()` qui
gagnera un paramètre — et ce sera un changement assumé, pas un paramètre
préventif.

## 5. Ce que le serveur ne croit jamais

Quatre valeurs arrivent d'un client, et aucune n'est crue sur parole :

| Ce que le client envoie | Ce que le serveur fait | Échec |
|---|---|---|
| Un **nom de fichier** | Ignoré : la clé de stockage est fabriquée (`voiceStorageKey(hash, assetId, ext, date)`) et `original_filename` reste `null` | Impossible par construction |
| Un **type MIME déclaré** | Comparé au contenu réel (`detectAudioFormat` : EBML, `RIFF`+`WAVE`, `OggS`, `ID3`/trame MP3, `ftyp`) | `AUDIO_MIME_MISMATCH`, `AUDIO_FORMAT_UNSUPPORTED` |
| Une **taille** | `bodyLimit` de la route = `MEDIA_MAX_UPLOAD_MB` (512 Mio par défaut) ; Fastify refuse avant le handler | `413` → `UPLOAD_TOO_LARGE` |
| Une **durée** | Le plafond `MEDIA_MAX_DURATION_S` (900 s) est appliqué **par le worker, après décodage** : un en-tête WebM tronqué peut annoncer 5 s pour 40 min | `AUDIO_TOO_LONG` |

`application/octet-stream` est accepté : il n'y a alors aucun type déclaré à
croire, et c'est la signature qui décide. Les clés de stockage sont vérifiées
avant tout accès disque (`STORAGE_KEY_INVALID` pour un chemin absolu, contenant
`..` ou un octet nul — quel que soit le séparateur, `/` ou `\`).

`GET /media/capabilities` renvoie exactement ces limites — taille, durée, types
acceptés, état du moteur — et l'écran les **recopie** au lieu d'inventer les
siennes. Une capacité annoncée mais absente ferait un écran qui ment ; un écran
qui recopie la réponse ne le peut pas.

## 6. Trois défauts trouvés en chemin, et ce qui les rend impossibles à rejouer

**1. Le backoff de reprise était annulé par le planificateur.** `markJobForRetry`
écrivait `available_at = maintenant + 30 s` mais laissait `scheduled_for` sur
l'échéance d'origine. Comme `promoteScheduled()` rend disponibles les jobs dont
`scheduled_for` est atteint, il remettait `available_at = now` au tour de boucle
suivant : la politique de reprise de docs/02 §12 devenait une reprise immédiate —
invisible dans les journaux, et brutale pour un service déjà en difficulté.
Correctif : `scheduled_for` **suit** le backoff, parce qu'un job n'a qu'une
échéance, celle de sa prochaine exécution, qu'elle vienne d'un cron ou d'une
reprise. Preuve : `tests/integration/queue-schedule.test.ts` utilise la vraie
spécification `transcribe_media`, provoque un `TransientError`, vérifie
`scheduled_for === available_at`, puis qu'aucun claim n'est possible avant la fin
de l'attente.

**2. Un test écrivait dans le dépôt.** Le double du binaire whisper écrivait le
JSON à côté du préfixe `-of`… et `healthCheck()` appelle le binaire avec `-h`
seul : le fichier atterrissait donc en `-h.json`, relatif au répertoire courant,
c'est-à-dire à la racine du dépôt. Un test qui salit son environnement finit par
faire échouer une vérification sans rapport. Correctif : le double ne produit une
sortie que lorsqu'il y a un `-of` ; les tests de capacité n'ont rien à écrire.

**3. Le bouton grisé ne disait pas pourquoi.** Quand `whisper-cli` ou le modèle
manquait, l'écran affichait un bouton « Enregistrer » inactif et une phrase sur la
relecture : l'utilisateur ne pouvait pas savoir que le problème était son
installation. Correctif, en deux temps : `WhisperCppTranscriber.healthCheck()`
distingue désormais **trois** causes et écrit une phrase actionnable — modèle
absent (avec le chemin attendu), binaire non lançable (avec son nom et
`WHISPER_BIN`), binaire en erreur (son `stderr`, repris tel quel) — et l'écran
recopie ce détail via `transcriptionUnavailableNotice` (`voice.ts`), y compris
quand c'est l'API qui ne répond pas.

## 7. Limites vérifiées sur ce poste (2 octobre 2026)

| Élément | État réel | Conséquence |
|---|---|---|
| FFmpeg | **présent** (`/usr/bin/ffmpeg`, n9.0.2) | La normalisation audio est vérifiée en conditions réelles : un WebM/Opus produit par `MediaRecorder` devient bien un WAV mono 16 kHz |
| `whisper-cli` | **absent du `PATH`** | `healthCheck()` répond `available: false` avec « Binaire « whisper-cli » introuvable ou inexécutable… » ; l'écran l'affiche, le bouton reste inactif — et **aucun** job n'échoue en silence |
| Modèle (`data/models/ggml-small.bin`) | **absent** (`data/models/` n'existe pas) | `healthCheck()` répond `available: false` avec « Modèle whisper absent : data/models/ggml-small.bin… » |
| Pipeline complet `ffmpeg → whisper.cpp` réel | **non exécuté** | C'est la seule chose que ce document ne peut pas afficher : sans binaire ni modèle, la transcription réelle n'a pas été produite. Ce qui **est** prouvé : la chaîne d'appel, les arguments, le format de sortie attendu, la classification des erreurs et l'effacement du dossier de travail — par des doubles qui écrivent de vrais fichiers (34 puis 35 tests dans `@aia/media`) |
| Parcours vocal au navigateur | **exécuté et vert** | `tests/e2e/parcours-voix.spec.ts` : le navigateur enregistre vraiment (micro factice, `MediaRecorder` → WebM) et le moteur **scripté** remplace whisper.cpp |

Dit autrement : tout ce qui dépend du poste est vérifié ; tout ce qui dépend de
l'installation de whisper.cpp est **annoncé** comme absent, pas contourné. Le
parcours de bout en bout remplace un seul composant — le moteur — et il le fait
explicitement : la pile de test injecte le **même** `ScriptedTranscriber` dans
l'API (qui annonce la capacité sur `/media/capabilities`) et dans le worker (qui
transcrit), par le même mécanisme de surcharge que le reste du projet. C'est la
topologie de production — une installation, deux processus qui la lisent — sans
binaire, sans modèle et sans réseau (docs/09 §1.1).

## 8. L'API : six routes, des refus nommés

| Route | Réponse | Refus |
|---|---|---|
| `GET /media/capabilities` | État du moteur, taille max, durée max, types acceptés | — |
| `POST /conversations/:id/voice` | `202` `{ asset, jobId }` — et, si une transcription est déjà en file pour ce couple (asset, langue), `202` avec **le même** `jobId` | `400 VOICE_BODY_REQUIRED` (corps vide) ; `400 AUDIO_FORMAT_UNSUPPORTED` / `AUDIO_MIME_MISMATCH` (signature) ; `413 UPLOAD_TOO_LARGE` (taille) |
| `GET /conversations/:id/voice/:assetId/transcript` | `200` `{ asset, transcript }` — `transcript` peut être `null` | `404 VOICE_ASSET_NOT_FOUND` |
| `DELETE /conversations/:id/voice/:assetId` | `204` | `409 VOICE_ASSET_IN_USE` (audio déjà rattaché à un message) ; `404 VOICE_ASSET_NOT_FOUND` |
| `POST /conversations/:id/voice/:assetId/send` | `201` (tour complet : conversation, message utilisateur, réponse, plan, coût, transcription corrigée) | `404 TRANSCRIPT_NOT_FOUND` (rien à relire) ; `400 TRANSCRIPT_EMPTY` (texte vide) ; `400 TRANSCRIPT_INPUT_INVALID` (corps hors schéma) |
| `GET /jobs/:id` (existante) | Statut, progression, `retry_at`, événements | `404` |

Quatre points de conception visibles dans cette table :

- **`202` à la réception, pas `200`** : le téléversement est accepté, la
  transcription n'a pas eu lieu. Le client sait qu'il doit attendre (il s'abonne
  au statut du job), il ne peut pas croire que le texte est prêt.
- **Un second envoi du même enregistrement n'est pas une erreur** : la
  déduplication rend le job déjà en file, plutôt que d'en créer un second ou de
  refuser en `409`. Renvoyer la même réponse (`202`, même `assetId`, même
  `jobId`) est ce qui permet à un écran rechargé de reprendre un enregistrement
  interrompu sans rien dupliquer.
- **`transcript: null` n'est pas une erreur** : un audio existe, sa transcription
  n'est pas encore là. La route répond `200` avec `null`, et l'écran continue
  d'interroger. Confondre « pas encore » et « pas trouvé » ferait afficher une
  panne à un utilisateur qui attend simplement son tour.
- **Aucun orphelin, dans les deux sens** : si l'écriture du fichier réussit mais
  que la ligne échoue, le fichier est retiré ; si la ligne existe mais que le job
  ne peut pas être créé, l'audio **créé par cette requête** est retiré — et
  seulement celui-là, parce qu'un audio dédupliqué appartient à l'envoi précédent
  qui l'a créé.

## 9. L'écran : sept états nommés, une relecture, un clic

`apps/web/src/features/conversation/voice.ts` (pur, testé sans navigateur) décide
ce qui est affiché, ce que `VoiceInput.tsx` se contente de rendre.

| État | Ce que l'écran dit |
|---|---|
| `idle` | « Le texte ne sera envoyé qu'après votre relecture. » |
| `recording` | « Enregistrement en cours… parlez, puis cliquez sur « Arrêter ». » |
| `uploading` | « Téléversement vers l'API locale… » |
| `queued` | « En attente du worker local… » |
| `transcribing` | « Transcription locale par whisper.cpp… 42 % » |
| `ready` | « Transcription prête : relisez-la, corrigez-la, puis envoyez-la. » |
| `failed` | « La transcription n'a pas abouti. » + bouton « Recommencer » |

- Le bouton « Enregistrer » n'est actif que si le navigateur sait enregistrer
  **et** si le moteur est disponible ; sinon l'écran affiche la raison exacte
  renvoyée par l'API (`transcriptionUnavailableNotice`).
- « Abandonner » supprime l'enregistrement et sa transcription (`DELETE`, `204`).
  Il disparaît dès qu'un message référence l'audio, et l'API refuse alors en
  `409` — l'interface ne propose donc jamais une action qui échouerait.
- Le lecteur audio sert à réécouter ce qui a été enregistré ; il ne renvoie
  jamais l'audio au serveur.
- Le texte proposé est la **correction enregistrée** si elle existe, sinon le
  texte brut du moteur (`transcriptDraft`). Une correction déjà saisie n'est
  jamais écrasée par une réponse tardive de l'API.
- `canConfirmTranscript` est le seul endroit qui autorise l'envoi, et il exige
  les trois conditions à la fois : état `ready`, texte non blanc, envoi non en
  cours.

## 10. Décisions d'implémentation (M28 – M35)

| # | Décision | Ce que ça évite |
|---|---|---|
| M28 | **Le moteur est annoncé par l'API, jamais supposé par l'écran** — `/media/capabilities` renvoie l'état réel, les limites réelles et les types réellement acceptés | Un écran qui propose un bouton que le serveur refusera |
| M29 | **Un binaire absent est une capacité, pas une panne** — `healthCheck()` ne lève jamais, et `WHISPER_*` sont classés `capability` (aucune reprise) | Une file qui s'acharne sur un moteur qui n'existe pas, et des journaux pleins d'échecs « transitoires » qui n'en sont pas |
| M30 | **Un conteneur sans type déclaré est accepté** (`application/octet-stream`) : la signature décide | Refuser un enregistrement valide parce que le navigateur n'a pas su nommer son format |
| M31 | **La durée n'est plafonnée qu'après décodage**, par le worker | Un en-tête WebM menteur qui laisse passer 40 minutes d'audio |
| M32 | **Le texte corrigé est écrit dans `transcripts.edited_body`** *avant* l'envoi du tour | Perdre la correction si le tour échoue après, et repartir du texte brut |
| M33 | **Un audio rattaché à un message ne se supprime jamais** — ni par l'interface (`409`), ni par la purge (deux verrous) | Supprimer la preuve de ce qui a été publié (docs/03 §12.1) |
| M34 | **La clé de stockage est fabriquée par le serveur** (`voiceStorageKey`), le nom du client est jeté | Toute traversée de répertoire depuis l'entrée |
| M35 | **La transcription est réutilisée** si le même moteur et le même modèle ont déjà traité l'asset (`uq_transcript_asset`) | Payer deux fois, en temps de calcul, le même travail |

## 11. Ce que cette étape a ajouté comme tests

| Fichier | Ce qu'il prouve | Tests |
|---|---|---|
| `packages/media/src/index.test.ts` | Format détecté par signature ; clé de stockage et sandbox (0600, `..`, séparateurs Windows) ; arguments FFmpeg/whisper ; `parseWhisperJson` ; `WhisperCppTranscriber` avec processus simulés **écrivant de vrais fichiers** ; `ScriptedTranscriber` ; rétention et ordre fichier → ligne | 35 |
| `apps/web/src/features/conversation/voice.test.ts` | États affichés, droit d'envoyer, texte proposé, erreurs de microphone, format d'enregistrement, explication du moteur absent | 16 |
| `tests/integration/voice-api.test.ts` | Capacités, téléversement + déduplication, refus (signature, type menteur, corps vide, taille), transcription, relecture, correction, envoi, suppression/`409`, **aucun message avant confirmation** | 12 |
| `tests/integration/queue-schedule.test.ts` | L'échéance d'un job et son backoff ne se confondent pas | 2 |
| `tests/e2e/parcours-voix.spec.ts` | Le parcours complet au navigateur : micro → WebM → transcription scriptée → correction → envoi → tour visible | 1 scénario |

Deux règles ont guidé ces tests : **le binaire est le seul composant remplacé**
(un `CommandRunner` injecté, qui écrit de vrais fichiers, laisse la plomberie et
les modes d'échec réels), et **aucun test n'écrit hors de son dossier
temporaire**.

## 12. Ce qui n'a pas été construit, et pourquoi

Cette livraison couvre le volet **entrée vocale et transcription locale** de
l'étape 6. Le reste de `docs/10` §4.6 n'est pas fait, et n'est pas contourné :

| Non fait | Pourquoi ce n'est pas un oubli |
|---|---|
| Import de **vidéos et d'images**, inventaire d'assets, découpage de clips (`-ss`/`-to`) | Le critère de sortie de la livraison est le parcours vocal. Les mêmes briques (stockage, empreinte, FFmpeg sans shell) sont en place : c'est la prochaine tranche, pas une dette |
| `scripts/backup.ts` et **test de restauration** | Exigé par docs/03 §16.2, explicitement rattaché à l'étape 6 — **pas encore écrit**. Tant qu'il ne l'est pas, les données de ce projet ne sont pas sauvegardées, et le document ne prétend pas le contraire |
| Décision **D3** (adaptation multi-plateformes : LLM ou humaine) | Décision produit, hors du périmètre du code livré ici |
| Purge **automatique** planifiée | La règle existe (`decideAudioPurge`) et la commande existe (`pnpm media:purge`) ; la planification est une décision d'exploitation. Par défaut, la commande **simule** |
| Transcription **cloud** (`faster_whisper`, `cloud`) | Le moteur est choisi par contrat (`Transcriber`) ; aucune implémentation réseau n'est ajoutée tant que le local n'est pas installé (et un job vocal est `requiresNetwork: false`) |
| **Diarisation**, mots horodatés, transcription partielle en direct | `has_word_timestamps` reste `false`. Le JSON de whisper.cpp ne fournit pas les mots par défaut ; les inventer serait pire que l'absence |
| Bouton « **réessayer la transcription** » dans l'écran | Rejouer un échec `validation` ou `capability` donnerait le même résultat. La commande de reprise existe côté file (le job redevient `queued`), mais l'écran n'expose pas un bouton qui ferait perdre du temps |
| Suppression automatique d'un média | Interdit explicite de docs/10 §4.6 : rien ne se supprime sans confirmation |

## 13. Points ouverts

- **Whisper.cpp n'est installé sur aucun poste de cette machine** : la chaîne
  réelle `ffmpeg → whisper-cli` n'a pas tourné. Le contrat, les arguments et les
  modes d'échec sont testés ; le premier essai réel se fera à l'installation, et
  il portera sur l'unique question restante : la qualité de la sortie JSON d'un
  binaire donné (`-ojf` produit bien le format attendu).
- **Déduplication d'un asset entre deux projets** : elle est projetée sur
  `project_id` (§3.1). Si un jour un asset doit être partagé — une vidéo source
  commune à deux projets —, il faudra une table de liaison, pas une unicité
  globale.
- **Message du moteur en anglais** : quand le binaire lui-même parle (`stderr`),
  sa phrase est reprise telle quelle — c'est voulu (elle est exacte), mais elle
  n'est pas en français.
- **Pas de quota ni de statistiques d'espace** : la purge protège la preuve de
  ce qui a été envoyé, mais rien n'avertit encore que le disque se remplit
  (risque nommé par docs/10 §4.6).
- **Durée affichée** : l'écran affiche la durée max en minutes entières
  (`floor`), donc « 15 min » pour 900 s exactement. Un arrondi plus fin n'a pas
  d'intérêt tant qu'une seule valeur est configurée.

## 14. Définition de terminé

| Critère | Preuve |
|---|---|
| On peut enregistrer, transcrire, relire, corriger, envoyer | `tests/e2e/parcours-voix.spec.ts` (navigateur + micro factice) |
| **Rien n'est envoyé sans confirmation** | `canConfirmTranscript` + `tests/integration/voice-api.test.ts` (aucun message `input_mode='voice'` avant l'appel de `send`) |
| Le texte envoyé est le texte relu | `edited_body` écrit avant le tour, et le tour porte la correction (integration + E2E : la chaîne corrigée est affichée dans la conversation) |
| Un moteur absent est annoncé, pas contourné | `WhisperCppTranscriber.healthCheck()` (3 causes distinguées) + `transcriptionUnavailableNotice` + `GET /media/capabilities` |
| Aucune donnée client n'est crue | Signature, empreinte, clé de stockage serveur, `413`, durée après décodage — `tests/integration/voice-api.test.ts` |
| Aucun fichier orphelin | Retrait du fichier si la ligne échoue, retrait de l'audio créé si le job échoue, purge simulée par défaut, ordre fichier → ligne |
| La transcription ne se refait pas | `uq_transcript_asset` + réutilisation côté worker |
| La purge ne touche jamais un audio envoyé | `decideAudioPurge` + filtre SQL + `409` sur `DELETE` |
| Tout est vert | `pnpm typecheck`, `pnpm lint`, `pnpm test` (52 fichiers), `pnpm build`, `pnpm test:e2e` (2 parcours), `pnpm verify` |
