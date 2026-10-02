# 17 — Mise en œuvre de l'étape 7 (rendu vidéo vertical et schéma de la veille)

> Compte rendu de ce qui est **réellement** livré pour l'étape 7 : `docs/05` §6
> (pipeline vidéo), `docs/03` §10.3 (rendus) et §13 (veille) et le périmètre de
> `docs/10` §4.7. Le **pipeline de veille** n'est pas dans cette livraison — seule
> sa table existe, et c'est dit explicitement (§3 et §12).

## 1. Résultat livré

Un contenu **approuvé** peut devenir un short vertical sous-titré, et l'utilisateur
peut le regarder avant de le valider :

```text
contenu approuvé + vidéo importée (MP4/MOV/WebM, H.264)
  → POST /projects/:id/videos            (contenu reconnu, ffprobe, clé serveur)
  → POST /media/assets/:id/transcribe    (job transcribe_media, local)
  → POST /content/:id/video/plan         (media_planner propose — rien n'est créé)
  → écran : bornes modifiables, avertissements affichés
  → POST /content/:id/video/renders      (plan validé → ligne video_renders + job)
  → worker : plan relu → ASS écrit → FFmpeg (un passage) → asset `subtitled`
  → GET /events/jobs/:id                 (progression, étapes, échec dit)
  → GET /renders/:id/file                (aperçu, `Range` supporté)
  → POST /renders/:id/validate           (regardé, figé — aucune publication)
```

Quatre garanties structurent cette chaîne, chacune prouvée par un test :

- **rien n'est rendu avant un plan validé** : proposer un plan ne crée ni ligne
  `video_renders` ni job ; la création est une route distincte, qui revalide le
  plan contre la source ;
- **le rendu est rattaché à la bonne version de contenu**
  (`video_renders.content_version_id`) : c'est le lien « quel texte a produit ce
  montage ? », et il ne se devine pas ;
- **un échec est explicable** : le statut du rendu et son motif sont écrits, et la
  politique de reprise reste celle de la file (erreur transitoire → reprise ;
  erreur de capacité → décision humaine) ;
- **une reprise ne recrée rien** : même rendu, même plan, même source, même
  version ; seul l'encodage est relancé (§4 du critère de sortie de `docs/10` §4.7).

## 2. Les étapes, et ce qui décide à chacune

| Étape | Où | Ce qui décide |
|---|---|---|
| Import | `POST /projects/:id/videos` → `packages/media/src/video.ts` | Le **contenu** décide du conteneur (`ftyp`/EBML), `ffprobe` décide du reste ; un codec non H.264 est refusé en le nommant |
| Clé de stockage | `videoStorageKey` | Fabriquée par le serveur (`202603/ab/<uuid>.mp4`) : aucun nom d'utilisateur, aucun chemin |
| Déduplication | `media_assets.sha256` (par projet) | Deux fois le même fichier = un seul asset ; la réponse dit `deduplicated: true` |
| Transcription | job `transcribe_media` (`apps/worker/src/handlers/transcribe-media.ts`) | Le handler accepte **audio et vidéo** : un transcript appartient à un média. Durée mesurée conservée, transcription réutilisée si elle existe |
| Plan proposé | `POST /content/:id/video/plan` → `apps/api/src/features/media.ts` | L'agent `media_planner` propose ; sinon le plan est calculé en code (`defaultRenderPlan`), avec la raison du repli |
| Bornes réelles | `validateRenderPlan` (`packages/media`) | Le schéma ne connaît pas la durée de la vidéo : `end <= durée`, `durée ∈ [1 s, VIDEO_MAX_CLIP_S]`, et l'extrait doit contenir de la parole transcrite |
| Création | `POST /content/:id/video/renders` | Contenu porteur d'une **version approuvée**, source du même projet, transcript présent, plan revalidé → ligne + job `render_video` (202) |
| Encodage | `apps/worker/src/handlers/render-video.ts` | Sémaphore 1, délai maximal, progression depuis `-progress pipe:1`, fichier `.part` renommé à la fin |
| Sous-titres | `packages/media/src/subtitles.ts` | Répliques issues des **segments** (pas de mots), bornes relatives à l'extrait, minimum 400 ms, accolades retirées |
| Aperçu | `GET /renders/:id/file` | Le fichier n'existe que si le rendu est terminé ; `Range` supporté pour la timeline |
| Validation | `POST /renders/:id/validate` | Un rendu terminé, regardé par un humain. Aucun job de publication n'est créé |

## 3. Données : ce que la migration `0006` ajoute, et pourquoi

`docs/10` §4.7 annonce **deux tables** pour l'étape 7 : `news_sources` et
`news_items`. Elles sont créées, avec leurs contraintes, leurs index d'unicité et
un `CHECK` sur le type et l'autorité d'une source :

- `news_sources` : une source déclarée par l'utilisateur (`rss`, `atom`, `api`,
  `manual`), avec sa cadence, ses échecs consécutifs et son état activé. L'index
  `uq_source_url` interdit deux fois la même URL **dans un projet** ;
- `news_items` : une actualité **récupérée** (jamais inventée), avec son empreinte
  de contenu. `uq_news_hash` fait de la déduplication une contrainte de base, pas
  une politesse du code appelant.

Ce qui n'existe **pas**, volontairement : aucune table de travail, aucun état de
collecte, aucun planificateur, aucun scoring, aucun appel de modèle de veille.
`docs/10` §1.3 (« la table d'abord, le pipeline ensuite ») est appliqué à la
lettre : le pipeline arrive à l'**étape 10**. La migration ne contient donc que le
modèle, et `tests/integration/news-schema.test.ts` vérifie qu'aucun type de job de
veille n'est enregistré — donc que la file refuse d'en enfiler un.

`video_renders` existait depuis l'étape 4, mais elle n'était **pas encore
exécutable**. La migration `0006` la reconstruit pour lui donner ce qu'un rendu réel
exige, sans DROP (SQLite n'accepte pas de modifier une table sur place, et une
reconstruction accompagnée d'un `DROP` aurait effacé des lignes) :

| Colonne ajoutée | Pourquoi elle existe |
|---|---|
| `content_version_id` | Le lien « quel texte a produit ce montage ». Sans lui, un rendu serait rattaché à un contenu, pas à une version — et le lien mentirait au premier changement |
| `edit_plan_json` | Le plan **tel que l'utilisateur l'a validé** (bornes, provenance). C'est l'intention, conservée avant toute compilation |
| `ffmpeg_args_json` / `ffmpeg_version` | Les arguments **réellement compilés** et la version du binaire. Comparer l'intention et le résultat est ce qui rend un échec explicable, et un rendu rejouable à l'identique |
| `job_id`, `requested_at`, `started_at`, `finished_at` | Le suivi : quel job exécute ce rendu, et depuis quand |
| `validated_at` | La trace qu'un humain a regardé le montage |
| `output_asset_id` | L'asset produit — un **nouvel** asset, jamais un remplacement (docs/05 §6.4) |
| `error_json` | Le motif d'échec, sérialisé sans pile d'appels (docs/08 §6.3) |

Le statut (`queued`, `preparing`, `rendering`, `completed`, `failed`, `cancelled`)
est écrit par `packages/database/src/repositories/renders.ts`, et **nulle part
ailleurs** : les transitions autorisées y sont explicites, `completed` et
`cancelled` sont terminaux, et `failed` décrit la **dernière tentative** — ce qui
permet à une reprise légitime de ré-armer la ligne (`markPreparing`) sans
condamner le rendu sur une première coupure.

## 4. L'API : des refus explicites, jamais silencieux

| Route | Ce qu'elle refuse, et pourquoi le code est là |
|---|---|
| `GET /media/video/capabilities` | Rien : elle annonce le format unique, les bornes réelles (`VIDEO_MAX_CLIP_S`, `MEDIA_MAX_UPLOAD_MB`), les modes acceptés et la disponibilité **mesurée** de FFmpeg |
| `POST /projects/:id/videos` | `PROJECT_NOT_FOUND`, `VIDEO_BODY_REQUIRED`, `VIDEO_TOO_LARGE`, `VIDEO_FORMAT_UNSUPPORTED`, `VIDEO_MIME_MISMATCH`, `VIDEO_CODEC_UNSUPPORTED`, `VIDEO_STREAM_MISSING`, `VIDEO_DURATION_UNKNOWN` |
| `POST /media/assets/:id/transcribe` | `MEDIA_ASSET_NOT_FOUND`, `MEDIA_HAS_NO_AUDIO`, `MEDIA_FILE_MISSING` |
| `POST /content/:id/video/plan` | `CONTENT_NOT_FOUND`, `CONTENT_ARCHIVED`, `CONTENT_NOT_APPROVED`, `VIDEO_SOURCE_NOT_FOUND`, `VIDEO_DURATION_UNKNOWN`, `VIDEO_TOO_LONG` |
| `POST /content/:id/video/renders` | Tous ceux du plan (`VIDEO_PLAN_*`, `VIDEO_NO_SUBTITLES_IN_WINDOW`), plus `VIDEO_TRANSCRIPT_REQUIRED`, `VIDEO_HAS_NO_AUDIO` |
| `POST /renders/:id/resume` | `VIDEO_RENDER_NOT_FOUND`, `VIDEO_RENDER_ALREADY_COMPLETED` |
| `POST /renders/:id/validate` | `VIDEO_RENDER_NOT_COMPLETED` |
| `GET /renders/:id/file` | `VIDEO_RENDER_NOT_COMPLETED`, `VIDEO_OUTPUT_ASSET_NOT_FOUND`, `MEDIA_FILE_MISSING` |

Deux décisions méritent d'être écrites :

1. **« approuvé » ne veut pas dire « état = approuvé »**. Le critère est
   `approvedVersionId` + `approvedAt` : un contenu déjà **publié** reste montable —
   c'est le cas normal d'un short destiné à une autre plateforme — alors qu'un
   contenu régénéré ou corrigé depuis ne l'est plus, parce que le domaine remet
   `approvedVersionId` à `null`. Un contenu **archivé** (rejeté) est refusé
   (`CONTENT_ARCHIVED`).
2. **Le contenu porteur du montage n'est pas deviné** : la route le reçoit, et la
   source doit appartenir au **même projet** que lui (`VIDEO_SOURCE_NOT_FOUND`).


## 5. Le worker : ce qui est long, et ce qui est dit

Le handler `render_video` (`apps/worker/src/handlers/render-video.ts`) porte quatre
décisions, et aucune n'est laissée à l'improvisation :

1. **il ne relit le plan que dans `video_renders`** : le job ne porte qu'un
   `renderId`, donc une reprise relit exactement le même plan, la même source et la
   même version de contenu ;
2. **il est idempotent** : un rendu déjà terminé rend son résultat sans réencoder ;
   un rendu en cours ou en échec repart de sa source, et le fichier temporaire est
   supprimé dans tous les cas (`finally`) ;
3. **il écrit l'échec sur la ligne du rendu** (`recordRenderFailure`) : sans cette
   écriture, un refus de FFmpeg laisserait l'écran sur « encodage » indéfiniment.
   La **politique de reprise reste celle de la file** : une erreur transitoire est
   reprogrammée, une erreur de capacité attend une décision humaine ;
4. **un seul encodage à la fois** (`apps/worker/src/features/semaphore.ts`) : la
   machine reste réactive pendant un rendu, ce qui compte plus que finir plus tôt
   (docs/05 §6.4).

Le fichier est écrit dans un `.part` **du répertoire cible** puis renommé : un
fichier visible est un fichier complet, et le renommage reste sur le même volume.
Les sous-titres sont écrits dans un répertoire de travail temporaire, sous le nom
`subtitles.ass` — un **nom relatif**, jamais un chemin.

## 6. Le plan : l'agent propose, le code arbitre, l'utilisateur décide

`media_planner` (`packages/ai/src/agents/media-planner.ts`, prompt
`prompts/media_planner/video_plan.md`) a une définition étroite : proposer un
extrait, des sous-titres brûlés, un recadrage centré, et une phrase de
justification. Il ne lance rien, ne publie rien, ne regarde aucune image et ne
cherche aucun « moment fort » — les interdits de `docs/10` §4.7 sont dans sa
définition, pas dans une consigne d'usage.

Trois filets, dans cet ordre :

1. **le schéma** (`renderPlanProposalSchema`, `@aia/shared`) : bornes cohérentes,
   durée minimale de 1 s, `subtitleMode` et `crop` **littéraux** — un plan qui
   demande autre chose que ce que l'étape sait faire est refusé avant tout appel
   FFmpeg ;
2. **le code** (`validateRenderPlan`) : les bornes réelles, que le schéma ne
   connaît pas (durée de la vidéo, `VIDEO_MAX_CLIP_S`) ;
3. **le repli** (`defaultRenderPlan`) : si l'agent est absent, échoue, ou rend un
   plan hors bornes, un plan calculé en code prend le relais — premier passage
   transcrit, soixante secondes au plus — et sa provenance est écrite
   (`plan.source`: `agent` | `fallback` | `manual`). L'écran affiche la raison du
   repli : un plan par défaut honnête vaut mieux qu'un écran bloqué, à condition de
   dire qu'il est par défaut.

L'écran, lui, ne revalide pas le plan : il vérifie seulement ce qu'il peut
(`buildPlanDraft`) pour éviter un aller-retour inutile, et affiche **tel quel** le
refus du serveur quand il y en a un.

## 7. Sous-titres : la précision qu'on a, pas celle qu'on aimerait

`packages/media/src/subtitles.ts` produit un fichier ASS (et non un SRT converti
par FFmpeg) pour une raison précise : `PlayResX/PlayResY` valant la taille de
sortie donne une taille de police en **pixels réels**, donc un rendu reproductible
d'une machine à l'autre.

Quatre règles, toutes vérifiées par des tests unitaires :

- **granularité de segment** : nos transcripts n'ont pas d'horodatage mot à mot
  (`has_word_timestamps = false`). Quand un segment est découpé en plusieurs
  répliques, le temps est réparti **au prorata des caractères** — approximatif,
  reproductible, et écrit dans le code plutôt que sous-entendu ;
- **bornes relatives à l'extrait** : un segment à cheval est coupé à la fenêtre, et
  rien ne commence avant zéro ;
- **minimum de 400 ms par réplique** : plus court, ça clignote au lieu de se lire ;
- **accolades retirées** : `{\an8}`, `{\c&HFF0000&}` sont des balises `libass`. Une
  transcription qui en contient ne doit pas pouvoir déplacer ni repeindre un
  sous-titre.

## 8. Sécurité : les trois endroits où une injection aurait été possible

1. **Aucun shell** : `packages/media/src/exec.ts` n'utilise que
   `spawn(binaire, argv)` avec `shell: false`. Un chemin de fichier hostile reste
   un argument entier — le test le vérifie avec un nom contenant `; rm -rf`.
2. **Aucun chemin utilisateur dans un filtre FFmpeg** : le filtre `subtitles=`
   ne reçoit que `subtitles.ass`, écrit par le worker dans un répertoire
   temporaire créé par lui. Un nom relatif supprime la question de l'échappement.
3. **Aucune confiance au client** : type reconnu par la signature du contenu,
   mesures par `ffprobe`, clé de stockage fabriquée par le serveur, plafonds de
   taille (`MEDIA_MAX_UPLOAD_MB`) et de durée (`MEDIA_MAX_DURATION_S`) vérifiés
   par le serveur — et `probe()` / `version()` traduisent un binaire absent en
   `CapabilityError` (`FFMPEG_UNAVAILABLE`) plutôt qu'en erreur interne.


## 9. L'écran « Montage vidéo »

Un onglet de plus, pas un sixième écran à part : il suit le parcours réel, dans
l'ordre (choisir le contenu → choisir ou importer la vidéo → transcrire → proposer
un plan → modifier les bornes → lancer → regarder → valider).

Ce que l'écran ne fait **pas**, et qui est aussi important que ce qu'il fait :

- pas de choix de format : le format unique est affiché, pas proposé ;
- pas de musique, pas de transition, pas de détection de moment fort ;
- pas de bouton « valider » avant qu'un fichier existe : un rendu terminé propose
  une action, un rendu en cours propose de reprendre ;
- pas de publication : valider est une trace, pas une action.

Les libellés de statut ne sont pas écrits dans React : ils viennent de
`GET /media/video/capabilities`, comme ceux des contenus viennent de
`/editorial/vocabulary`. Un statut ajouté au domaine apparaît alors sans
modification d'écran.

## 10. Ce que les tests prouvent, et par quel test

| Ce qui est prouvé | Où |
|---|---|
| Conteneur reconnu par le contenu, codec nommé, bornes du plan, plan de repli, avertissements | `packages/media/src/video.test.ts` (22 tests) |
| Graphe FFmpeg (un passage, `-ss` avant `-i`, `crop=1080:1920`, `subtitles=subtitles.ass`), absence de shell | `packages/media/src/video.test.ts` |
| Répliques (fenêtre, prorata, minimum 400 ms), horodatage ASS, accolades neutralisées | `packages/media/src/subtitles.test.ts` (11 tests) |
| Lecture de `ffprobe`, progression (`out_time_us` préféré), `runOrThrow` (timeout/abort/refus), cache de version | `packages/media/src/ffmpeg.test.ts` (21 tests) |
| Le lanceur scripté écrit vraiment son fichier, échoue N fois, émet sa progression | `packages/media/src/ffmpeg.test.ts` |
| Prompt du `media_planner` (contexte, bornes, absence), schéma de sortie strict | `packages/ai/src/agents/media-planner.test.ts` (8 tests) |
| Import (dédup, refus MIME contenu/PNG/projet inconnu), plan (agent, repli, refus), création, rendu complet, progression monotone, aperçu `Range`, validation, échec + reprise, **préservation des données** | `tests/integration/video-api.test.ts` (24 tests) |
| **Rendu réel** : 1080 × 1920, H.264/AAC, durée bornée, et fichier **différent** avec et sans sous-titres | `tests/integration/video-render-ffmpeg.test.ts` (2 tests, ignorés si FFmpeg est absent) |
| Schéma de la veille : contraintes, unicité d'URL et d'empreinte, dédup, **aucun job de veille** | `tests/integration/news-schema.test.ts` (4 tests) |
| Migration 0006 appliquée, tables attendues à jour, base peuplée migrée sans perte | `tests/integration/migrations.test.ts`, `tests/integration/project-memory-migration.test.ts` |
| Le parcours complet à l'écran (import → transcription → plan édité → rendu → aperçu → validation) et le rattachement à la **bonne** version | `tests/e2e/parcours-conversation-contenu.spec.ts` (étape « le montage vidéo ») |

Le rendu réel et le rendu scripté coexistent volontairement : le second tourne
partout et prouve le **câblage**, le premier prouve que les **arguments compilés**
sont acceptés par FFmpeg et que les sous-titres sont réellement incrustés. Un test
qui exigerait FFmpeg pour vérifier une transition d'état serait inutilement lent ;
un test qui n'utiliserait que lui ne vérifierait pas la sécurité des chemins.

## 11. Décisions prises en chemin

| # | Décision | Pourquoi |
|---|---|---|
| M1 | Un **seul** format (`vertical_9_16`, 1080 × 1920, 30 i/s), un seul passage d'encodage | docs/10 §4.7 : si le rendu déborde, on réduit le périmètre, on n'allonge pas l'étape |
| M2 | H.264 accepté en entrée, et **seulement** lui | Supporter tous les codecs est un travail sans fin ; un refus qui nomme le codec est plus utile qu'un rendu approximatif |
| M3 | Sous-titres en **ASS** écrit par nous, pas en SRT converti | Taille de police en pixels réels, donc rendu reproductible |
| M4 | Répliques basées sur les **segments** horodatés | Nous n'avons pas d'horodatage mot à mot, et l'inventer serait pire que l'approximation |
| M5 | Le plan proposé est **modifiable**, et sa provenance est écrite (`agent`/`fallback`/`manual`) | Un plan figé obligerait à tout refaire ; une provenance inconnue rendrait un écart inexplicable |
| M6 | `defaultRenderPlan` **en code** plutôt qu'un second appel au modèle | Un repli doit être déterministe, instantané et gratuit |
| M7 | Le refus « aucune parole dans l'extrait » est appliqué à la **création** du rendu, pas dans un avertissement | C'est le seul cas où les sous-titres brûlés n'afficheraient rien : un avertissement laisserait produire un short muet |
| M8 | Le statut `failed` décrit la **dernière tentative** (`markPreparing` l'accepte en entrée) | Une première coupure ne doit pas condamner un rendu, et une reprise doit pouvoir ré-armer la ligne |
| M9 | Les échecs sont **écrits** sur la ligne du rendu, pas seulement sur le job | L'écran lit le rendu ; sans motif écrit, il afficherait « encodage » indéfiniment |
| M10 | Le handler de transcription accepte **audio et vidéo**, et ne remplace pas une durée mesurée | `docs/03` §10.2 ne distingue pas les deux ; `ffprobe` a vu tout le fichier, le moteur n'a entendu que le son |
| M11 | « Approuvé » = `approvedVersionId` + `approvedAt`, pas `state === 'approved'` | Un contenu publié doit rester montable, un contenu régénéré depuis ne doit plus l'être |
| M12 | `Range` supporté sur les fichiers média | Sans lui, la timeline d'un lecteur `<video>` est inutilisable : l'aperçu avant validation deviendrait décoratif |
| M13 | La migration `0006` est **écrite à la main** | `drizzle-kit` a proposé un `DROP` de `video_renders` ; une reconstruction accompagnée d'un DROP aurait effacé des lignes |
| M14 | L'image de marque du montage reste le mot « montage » à l'écran, pas « vidéo » | C'est un montage d'un texte approuvé ; le mot « vidéo » seul ferait croire à un éditeur vidéo |


## 12. Ce qui n'a **pas** été construit, et pourquoi

| Absent | Raison |
|---|---|
| **Pipeline de veille** (collecte RSS, scoring, LLM de veille) | Étape 10. `docs/10` §1.3 : la table d'abord. Le schéma est livré, le pipeline non, et un test vérifie qu'aucun job de veille n'existe |
| Choix du format, presets carré/paysage | `docs/10` §4.7 : un seul format. `square_1_1`, `landscape_16_9` et `clip_short` existent dans le modèle **et** dans les libellés, mais `supported: false` |
| Détection de « moment fort » (score, vision, LLM sur le contenu vidéo) | Interdit explicite. L'agent `media_planner` ne reçoit que le texte approuvé, la transcription et la durée |
| Musique, transitions, effets, recadrage mobile (suivi de visage) | Interdits explicites. Le recadrage est centré, et l'écran le dit quand il coupe beaucoup |
| Publication vidéo par API | Interdit à l'étape 7. Valider un rendu n'ouvre aucune publication |
| Sous-titres **externes** (fichier `.srt` à côté de la vidéo) | Ce serait un second mode à tester et à expliquer pour un produit qui n'en a pas besoin aujourd'hui |
| Montage à partir de plusieurs sources (couper entre deux vidéos) | Un short = un extrait d'**une** source. Le modèle porte `source_asset_ids[]` le jour où ce sera demandé, sans migration cassante |
| Import d'images, découpage aveugle de clips, sauvegarde/restauration, décision D3 | Restent de l'étape 6 (docs/16 §12) ; l'étape 7 ne les a pas absorbés |
| Quota d'espace disque, purge des rendus | Nommé comme risque dès docs/10 §4.7. Rien ne se supprime sans confirmation, et un rendu produit un asset de sortie, donc une preuve |
| Miniature (`thumbnail`/`poster`) du short | Utile à la publication, qui arrive à l'étape 8. Le `role` existe déjà dans le schéma |

## 13. Points ouverts

- **FFmpeg n'a tourné qu'en 1080 × 1920 avec `libx264`** : le graphe est testé pour
  ce format, et le rendu réel est vérifié sur une source `lavfi` de trois secondes.
  Un encodage long (trois minutes, source 4K) n'a pas été mesuré sur cette
  machine : le délai (`VIDEO_RENDER_TIMEOUT_MS`, 15 min par défaut) est le seul
  garde-fou, et il est configurable.
- **Vitesse d'encodage** : `-preset veryfast -crf 23` a été choisi pour tenir sur un
  PC modeste. Sur une machine plus confortable, `medium` donnerait un meilleur
  rapport qualité/poids — c'est une constante de `buildVerticalShortArgs`, donc un
  changement d'une ligne, mais qui demande une mesure.
- **Transcription d'une vidéo longue** : le handler de transcription normalise par
  FFmpeg puis transcrit en une passe. Rien n'a été testé au-delà de
  `MEDIA_MAX_DURATION_S`.
- **Sous-titres sur une source déjà sous-titrée** : le rendu écrit **ses** répliques
  par-dessus l'image ; si la source en contient déjà, les deux se superposent.
  Aucune détection n'existe, et en ajouter une serait un autre sujet.
- **`Range` non testé sur un navigateur** : l'en-tête est couvert par un test
  d'intégration (`206`, `content-range`), et le lecteur Chromium du parcours E2E ne
  le demande pas explicitement pour un fichier de 96 ko.
- **`video_renders.source_asset_ids_json` porte un identifiant** : c'est cohérent
  avec le modèle, mais une jointure propre attendrait le jour où plusieurs sources
  seront possibles.
- **Le libellé du contenu dans l'écran** retombe sur l'accroche quand le contenu n'a
  pas de titre (LinkedIn, TikTok) : « accroche · cible ». Lisible, mais pas idéal
  pour une liste longue.

## 14. Définition de terminé

| Critère de `docs/10` §4.7 | Preuve |
|---|---|
| Un short est rendu **hors requête HTTP** | `POST /content/:id/video/renders` rend `202` et un `jobId` ; l'encodage a lieu dans `apps/worker/src/handlers/render-video.ts` |
| La progression est visible | `-progress pipe:1` → `job_events` → SSE → `JobProgressBar` ; monotonie vérifiée dans `tests/integration/video-api.test.ts` |
| L'échec est explicable | `recordRenderFailure` écrit le motif sérialisé sur la ligne ; les échecs sont nommés (`FFMPEG_FAILED`, `FFMPEG_TIMEOUT`, `VIDEO_RENDER_FORMAT_MISMATCH`…) |
| Le fichier est retrouvable | `renders/<render_id>.mp4` + `output_asset_id` + `GET /renders/:id/file` (asset `subtitled`, `parent_asset_id` = source) |
| Un rendu interrompu reprend sans repartir de zéro | `POST /renders/:id/resume` + `requeue()` : même ligne, même plan, même version ; prouvé en intégration (interruption, échec transitoire, échec de capacité) |
| Les tables de veille sont créées et migrées | Migration `0006` ; `tests/integration/news-schema.test.ts` et `tests/integration/migrations.test.ts` |
| Sous-titres brûlés depuis la transcription | `buildSubtitleCues` + `renderAssSubtitles` + filtre `subtitles=` ; fichier différent avec et sans, dans le rendu réel |
| Aperçu avant validation | `GET /renders/:id/file` + `<video>` dans l'écran + `POST /renders/:id/validate` |
| Publication toujours manuelle | Aucun job de publication n'est créé par la validation (vérifié en test) |
| Tout est vert | `pnpm typecheck`, `pnpm lint`, `pnpm test` (60 fichiers, 520 tests), `pnpm build`, `pnpm test:e2e` (2 parcours), `pnpm verify` |

