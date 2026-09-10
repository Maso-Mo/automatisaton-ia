# 10 — Plan de développement en 12 étapes

> Répond à la section 45 du [cahier des charges](00-cahier-des-charges.md) (« chaque phase contient :
> objectif, fonctionnalités, modules, dépendances, critères de sortie, tests, risques, estimation de
> complexité, ce qu'il ne faut pas encore construire ») et aux questions 33 et 34.
> S'appuie sur [`02-architecture.md`](02-architecture.md) (composants, contrats, décisions ouvertes),
> [`03-modele-de-donnees.md`](03-modele-de-donnees.md) (l'étape de création de chaque table),
> [`09-tests-et-qualite.md`](09-tests-et-qualite.md) (définition de « terminé »).

---

## 1. Comment lire ce plan

### 1.1 Le découpage en trois versions

Les douze étapes sont regroupées en trois versions **utilisables**. Chaque version est un produit
qui marche, pas une couche technique.

| Version | Étapes | Ce qu'elle permet de faire | Critère de sortie global |
|---|---|---|---|
| **V1 — le cœur** | 1 à 5 | Parler de son projet, produire un contenu, le valider, le publier **manuellement** (niveau C) | L'utilisateur produit et publie un contenu réel **sans intervention technique** |
| **V2 — l'industrialisation** | 6 à 9 | Traiter vidéos et médias, publier par API, planifier un calendrier | Le système tourne seul une semaine sans que rien ne casse |
| **V3 — l'autonomie** | 10 à 12 | Veille automatique, analytics, apprentissage, portabilité | Le système propose, mesure et s'améliore sans être alimenté à la main |

**Pourquoi cette séparation :** la V1 doit exister le plus tôt possible, parce que c'est la seule
façon de savoir si la **qualité éditoriale** est au rendez-vous. Tout le reste (vidéo, analytics,
veille) est de l'amplification d'un cœur qui doit d'abord fonctionner
([`01-vision-produit.md`](01-vision-produit.md) §19).

### 1.2 Le format d'une étape

Chaque étape est décrite par **neuf rubriques fixes** :

| Rubrique | Contenu |
|---|---|
| **Objectif** | Une phrase : ce que l'étape rend possible |
| **Fonctionnalités** | Ce qui est visible par l'utilisateur à la fin |
| **Modules** | Ce qui est créé ou modifié dans le monorepo |
| **Dépendances** | Ce qui doit exister avant |
| **Critères de sortie** | Ce qui doit être vrai pour passer à l'étape suivante |
| **Tests** | Les familles de [`09-tests-et-qualite.md`](09-tests-et-qualite.md) concernées |
| **Risques** | Ce qui peut faire échouer l'étape |
| **Complexité** | Faible / Moyenne / Élevée, avec une charge estimée en jours de travail effectif |
| **Ce qu'il ne faut pas encore construire** | Les tentations de l'étape |

### 1.3 La règle « la table d'abord, le pipeline ensuite »

Une table est créée quand son **domaine est modélisé**, même si le pipeline qui la remplit arrive
plus tard. C'est pourquoi `video_renders` apparaît à l'étape 4 (modélisée avec le contenu) alors que
le pipeline vidéo arrive à l'étape 7, et pourquoi les tables de veille apparaissent à l'étape 7
alors que le pipeline de veille complet arrive à l'étape 10.

**Cette règle n'est pas un détail de présentation** : elle évite une migration traumatisante à
chaque nouvelle fonctionnalité. Le schéma est conçu **une fois par domaine**, pas une fois par
étape. En revanche, une table vide n'est **jamais** remplie par du code provisoire.

### 1.4 La règle d'arrêt

À la fin de **chaque** étape, la question est posée explicitement :

> **Si le projet s'arrêtait ici, serait-il utile ?**

| Étape | Réponse |
|---|---|
| 1 à 2 | Non — c'est une infrastructure |
| **3 à 5** | **Oui — l'utilisateur produit et publie du contenu réel** |
| 6 à 9 | Oui — il le fait plus vite et plus régulièrement |
| 10 à 12 | Oui — il le fait sans y penser |

**C'est l'argument décisif pour mettre la publication manuelle (niveau C) dès l'étape 5.** Attendre
un accès API validé pour publier quoi que ce soit signifie attendre des semaines sans jamais savoir
si le contenu produit est bon.

---

## 2. Vue d'ensemble des douze étapes

| # | Étape | Version | Dépend de | Complexité | Livrable visible |
|---|---|---|---|---|---|
| 1 | Fondations exécutables | V1 | — | Élevée (6–8 j) | Le monorepo démarre, migre, exécute un job trivial |
| 2 | Conversation et mémoire | V1 | 1 | Élevée (5–7 j) | On parle de son projet, la mémoire se construit |
| 3 | Sujets, angles et entrée média | V1 | 2 | Moyenne (5–7 j) | Fiche maître, angles, note vocale transcrite |
| 4 | Génération éditoriale | V1 | 3 | Élevée (8–10 j) | Un contenu multi-plateformes, chiffré, tracé |
| 5 | Qualité, comptes et publication manuelle | V1 | 4 | Élevée (6–8 j) | Un contenu validé, publié à la main, statut suivi |
| 6 | Médias et sauvegarde | V2 | 5 | Moyenne (4–5 j) | Une vidéo importée, découpée, un backup restauré |
| 7 | Vidéo | V2 | 6 | Élevée (8–12 j) | Un short rendu, sous-titré, prêt à publier |
| 8 | Publication par API et budget | V2 | 7 | Élevée (6–9 j) | Un contenu publié par l'API, budget plafonné |
| 9 | Calendrier et planification | V2 | 8 | Faible (2–3 j) | Un contenu se publie à l'heure prévue |
| 10 | Veille et exploitation continue | V3 | 9 | Moyenne (4–6 j) | Une semaine sans intervention, aucune perte |
| 11 | Analytics et apprentissage | V3 | 10 | Moyenne (4–6 j) | Des recommandations fondées sur la performance |
| 12 | Consolidation et portabilité | V3 | 11 | Moyenne (5–8 j) | Une sauvegarde complète, une migration PostgreSQL testée |

**Charge totale estimée : 63 à 89 jours de travail effectif.** C'est une estimation, pas un
engagement : elle sert à comparer les étapes entre elles et à détecter les étapes trop grosses. Les
deux plus lourdes (4 et 7) sont celles où il faut envisager de découper davantage si le moral baisse.

---

## 3. Pourquoi cet ordre, et les deux ordres écartés

### 3.1 L'ordre retenu : suivre la valeur, pas la technique

```text
V1  fondations → conversation → matière (sujets/médias) → génération → validation + publication manuelle
V2  médias → vidéo → publication par API → calendrier
V3  veille → analytics → consolidation
```

Trois propriétés de cet ordre :

| Propriété | Pourquoi elle compte |
|---|---|
| **La publication manuelle avant la publication par API** | Le niveau C ne dépend d'aucune validation externe ([`06-connecteurs-et-publication.md`](06-connecteurs-et-publication.md) §8). L'attendre serait bloquer tout le produit sur la partie qu'on ne contrôle pas |
| **La mémoire avant la génération** | Un contenu généré sans `project_skill_facts` produit exactement le problème que le produit doit résoudre : une fausse expertise assumée |
| **La vidéo après les textes** | La chaîne média est la partie la plus coûteuse en temps de développement et en échecs matériels (FFmpeg, disque, codecs). Elle ne doit pas retarder la première publication |

### 3.2 Ordre écarté n° 1 : « d'abord toute l'infrastructure »

```text
base complète + queue + API + front + observabilité + tests → puis les fonctionnalités
```

| Pour | Contre |
|---|---|
| Aucun refactor de schéma par la suite | Six à dix semaines avant de produire le premier contenu ; on ne sait toujours pas si la qualité éditoriale est là |
| La file et l'observabilité sont plus faciles à tester seules | Le risque principal du produit (le contenu est-il bon ?) reste entier jusqu'à la fin |

**Écarté** : le risque du produit n'est pas technique, il est éditorial. Il faut le lever tôt.

### 3.3 Ordre écarté n° 2 : « d'abord le plus démonstratif »

```text
génération multi-plateformes et vidéo d'abord → conversation et mémoire ensuite
```

| Pour | Contre |
|---|---|
| Démonstration impressionnante rapidement | Un générateur sans mémoire produit du contenu générique : c'est la démonstration que **le produit ne sert à rien** |
| La chaîne vidéo est validée tôt | Elle dépend de médias que personne n'a encore fournis ; on testerait sur des fichiers factices |

**Écarté** : la mémoire est le différenciateur
([`03-modele-de-donnees.md`](03-modele-de-donnees.md) §6). Un générateur sans mémoire est un
générateur parmi mille.

---

## 4. Détail des douze étapes

### 4.1 Étape 1 — Fondations exécutables

| Rubrique | Contenu |
|---|---|
| **Objectif** | Avoir un monorepo qui démarre, migre sa base, exécute un job et journalise son coût — sans aucune fonctionnalité métier |
| **Fonctionnalités** | Aucune pour l'utilisateur. Un écran de diagnostic affiche : base migrée, worker actif, clé IA présente, budget du jour |
| **Modules** | `apps/api`, `apps/worker`, `apps/web` (coquille), `packages/{core,database,queue,shared,config,ai}`, `prompts/`, `scripts/check-env.ts`, `scripts/verify.sh` |
| **Dépendances** | Aucune. C'est l'étape qui crée les contrats de [`02-architecture.md`](02-architecture.md) §9 |
| **Critères de sortie** | `pnpm verify` passe ; la base se crée depuis zéro ; un job `noop` s'exécute, s'écrit dans `jobs`/`job_events`, et une ligne `llm_calls` porte un coût calculé ; l'application refuse de démarrer si une clé requise manque |
| **Tests** | Unitaires (calcul de coût, rédaction des journaux), intégration (réservation de job, migrations), canari |
| **Risques** | **Le plus gros risque de l'étape : la file SQLite.** La réservation atomique (`BEGIN IMMEDIATE`) doit être écrite et testée maintenant, pas après. Second risque : les modules natifs (`better-sqlite3`) sur un PC modeste |
| **Complexité** | **Élevée — 6 à 8 j.** Le contrat `Queue` et le modèle d'erreurs sont les deux pièces à ne pas bâcler |
| **Interdits** | Pas d'authentification complète, pas de panneau de réglages, pas de design, pas de Redis, pas de CI distante |

**Tables créées à cette étape (13)** : `users`, `app_settings`, `llm_providers_config`, `projects`,
`project_goals`, `project_facts`, `project_skill_facts`, `style_profiles`, `audience_profiles`,
`jobs`, `job_events`, `llm_calls`, `prompt_versions`.

**Le critère de sortie le plus important de tout le plan est ici** : si la file n'est pas fiable à
l'étape 1, tout ce qui s'appuie dessus sera fragile.

---

### 4.2 Étape 2 — Conversation et mémoire

| Rubrique | Contenu |
|---|---|
| **Objectif** | Discuter de son projet et voir la mémoire du projet se construire, avec un coût par échange visible |
| **Fonctionnalités** | Écran de conversation (texte et note vocale simple), questions de suivi, `project_facts` et `project_skill_facts` créés avec approbation explicite, historique, résumés automatiques |
| **Modules** | `packages/core/conversation`, `packages/core/projects`, `packages/ai` (orchestrateur + agent `interviewer`), `prompts/conversation/`, `apps/api` (REST + SSE), `apps/web/routes/conversation` |
| **Dépendances** | Étape 1 (base, file, provider) |
| **Critères de sortie** | Une conversation de 10 échanges reste sous un coût mesuré connu ; un fait extrait n'est **jamais** écrit sans approbation ; un résumé remplace les vieux messages sans perte d'information sur les faits ; l'écran affiche la progression en temps réel et la reprend après reconnexion |
| **Tests** | Intégration (pipeline conversation), agents (`interviewer` sur cas de référence), contexte minimal, SSE reprenable, coûts |
| **Risques** | **Le contexte qui gonfle** : sans contrainte explicite, l'historique complet est envoyé et le budget explose. Second risque : écrire des faits faux (l'utilisateur valide trop vite) |
| **Complexité** | **Élevée — 5 à 7 j.** Le paquet de mémoire et la validation des écritures sont le cœur |
| **Interdits** | Pas d'embeddings ni de RAG à cette étape. Pas de multi-projets simultanés dans l'interface. Pas de mémoire automatique non validée |

**Tables créées (4)** : `conversations`, `messages`, `conversation_summaries`, `master_briefs`.

**La règle non négociable de cette étape :** le modèle ne **décide** pas d'écrire ; il **propose**
une écriture (`EditPlan`) que le domaine applique après validation
([`05-pipelines.md`](05-pipelines.md) §3).

---

### 4.3 Étape 3 — Sujets, angles et entrée média

| Rubrique | Contenu |
|---|---|
| **Objectif** | Transformer une conversation en matière exploitable : fiche maître, sujets, angles, et entrée de médias (note vocale transcrite localement) |
| **Fonctionnalités** | Fiche maître générée et corrigeable, 2 à 4 angles proposés avec leur promesse, upload d'un fichier ou d'une note vocale, transcription locale, mesure du coût réel par appel |
| **Modules** | `packages/core/editorial`, `packages/media` (ingestion + `Transcriber` whisper), `packages/ai` (agent `strategist`), `prompts/editorial/`, `apps/web/routes/review` |
| **Dépendances** | Étape 2 (conversation, mémoire) |
| **Critères de sortie** | Une note vocale de 5 min produit une transcription exploitable **sans réseau** ; un brief maître est lisible et modifiable ; **20 appels réels ont été mesurés** et la table de coûts est renseignée avec des prix vérifiés ⚠️ ; décision **D2** tranchée |
| **Tests** | Intégration (transcription, génération de brief), agents (`strategist`), coûts (mesure réelle), uploads hostiles |
| **Risques** | **La transcription locale est le premier vrai risque matériel** : whisper sur un PC modeste prend du temps réel. Second risque : un brief maître trop long qui pollue tous les appels suivants |
| **Complexité** | **Moyenne — 5 à 7 j.** Le travail est surtout du réglage de prompt et de taille de contexte |
| **Interdits** | Pas de montage vidéo. Pas d'embeddings. Pas de génération de contenu final (c'est l'étape 4). Pas de sélection automatique d'angle |

**Tables créées (5)** : `message_attachments`, `content_subjects`, `subject_angles`,
`media_assets`, `transcripts`.

**Décision à trancher avant cette étape** : **D2** — Whisper `small` par défaut ou `medium`
([`02-architecture.md`](02-architecture.md) §15). La réponse dépend de la mesure réelle, pas d'un
avis : c'est pour cela que l'étape 3 inclut explicitement la mesure des coûts sur 20 appels.

---

### 4.4 Étape 4 — Génération éditoriale

| Rubrique | Contenu |
|---|---|
| **Objectif** | Produire un contenu multi-plateformes à partir d'un angle choisi, avec versions, affirmations extraites et coût connu |
| **Fonctionnalités** | Génération pour les plateformes du projet dans **un seul appel structuré**, réécriture avec consigne, versions comparables, écran de comparaison de versions |
| **Modules** | `packages/core/editorial`, `packages/ai` (agent `platform_writer`), `prompts/editorial/`, `apps/web/routes/review` |
| **Dépendances** | Étape 3 (sujets, angles, mémoire) |
| **Critères de sortie** | Un contenu produit pour 4 plateformes en **un seul appel** ; chaque sortie valide son schéma Zod ou est réparée ; les longueurs respectent les limites par plateforme ⚠️ ; chaque version est conservée avec son `context_fingerprint` ; le marquage IA est présent ; aucune affirmation n'est « vérifiée » à ce stade (les `content_claims` restent `verified = false`) |
| **Tests** | Unitaires (schémas, longueurs), agents (fixtures valides / invalides / hallucinées), coûts, contexte minimal |
| **Risques** | **L'étape la plus lourde du plan.** Risque n° 1 : la sortie structurée multi-plateformes échoue souvent et coûte des réparations. Risque n° 2 : le modèle invente des faits plausibles — c'est exactement le risque produit principal |
| **Complexité** | **Élevée — 8 à 10 j.** Prévoir de découper en deux si le schéma de sortie résiste |
| **Interdits** | Pas de critique ni de validation (étape 5). Pas de publication. Pas d'optimisation de performance (c'est l'étape 11) |

**Tables créées (8)** : `content_items`, `content_versions`, `content_claims`,
`content_review_notes`, `video_renders`, `errors`, `system_health`, `notifications`.

**Pourquoi `video_renders` et `errors` apparaissent ici :** le contenu et ses rendus sont **un seul
domaine** ; scinder la table plus tard demanderait une migration avec des données. Le principe est
celui du §1.3.

---

### 4.5 Étape 5 — Qualité, comptes et publication manuelle

| Rubrique | Contenu |
|---|---|
| **Objectif** | Valider éditorialement et factuellement un contenu, connecter les comptes, et **le publier réellement** au niveau C (paquet manuel) avec un statut suivi |
| **Fonctionnalités** | Critique et vérification factuelle (verdict + notes), écran d'approbation obligatoire, connexion des comptes (jetons chiffrés), paquet manuel prêt à coller par plateforme, statut `published` horodaté avec le texte exact, niveau C pour **toutes** les plateformes |
| **Modules** | `packages/core/review`, `packages/ai` (agents `critic`, `fact_checker`), `packages/publishing` (contrat `PlatformConnector`, capacités, `validateContent`, paquet manuel), `packages/config` (chiffrement des jetons), `apps/web/routes/review` |
| **Dépendances** | Étape 4 (contenu généré) |
| **Critères de sortie** | Aucun contenu ne peut être publié sans approbation explicite (**invariant vérifié par test**) ; un paquet manuel se publie en **moins de 60 s** ; les jetons sont chiffrés au repos ; le statut de publication est horodaté avec le texte exact ; décision **D1** tranchée (1, 2 ou 3 plateformes en V1) |
| **Tests** | Connecteurs (conformité partagée, paquet manuel), intégration (approbation, publication manuelle), sécurité (jetons chiffrés, canari), agents (`critic`, `fact_checker`) |
| **Risques** | **Le risque est de croire que le niveau C est un échec.** C'est la fonctionnalité qui rend le produit utilisable immédiatement. Second risque : le `critic` qui refuse tout, ce qui rend la boucle inutilisable |
| **Complexité** | **Élevée — 6 à 8 j.** La conception du contrat `PlatformConnector` doit être bonne du premier coup |
| **Interdits** | Pas de publication par API (étape 8). Pas de niveau A ou B. Pas d'OAuth complet pour les plateformes qui n'en ont pas besoin |

**Tables créées (5)** : `project_platforms`, `platform_accounts`, `publications`,
`publication_attempts`, `manual_packages`.

**Fin de la V1. C'est le point d'arrêt le plus important du plan :** à partir d'ici, si le projet
s'arrête, l'utilisateur a un outil utile. Le §1.4 l'a posé comme critère de décision.

---

### 4.6 Étape 6 — Médias et sauvegarde

| Rubrique | Contenu |
|---|---|
| **Objectif** | Traiter des médias volumineux sans casser le disque, et garantir qu'une perte de base ne fait perdre aucun contenu |
| **Fonctionnalités** | Import de vidéos et d'images, inventaire d'assets, découpage de clips, **restauration d'une sauvegarde** vérifiée, politique de rétention appliquée |
| **Modules** | `packages/media` (ingestion, `FFmpegRunner` en `spawn` sans shell, inventaire), `scripts/backup.ts`, `packages/core` (adaptation multi-plateformes) |
| **Dépendances** | Étape 5 (contenus, plateformes) |
| **Critères de sortie** | Un fichier de 2 Go est importé sans bloquer l'interface ; un clip est extrait avec `-ss`/`-to` sans réencodage inutile ; **une sauvegarde restaurée sur une base vide produit un système fonctionnel** ; la politique de rétention libère réellement de l'espace ; décision **D3** tranchée (adaptation multi-plateformes : LLM validée ou humaine) |
| **Tests** | Intégration (import, extraction, restauration), unitaires (construction des arguments FFmpeg, chemins), sécurité (`spawn` sans shell, chemins hostiles), DB (migrations sur base peuplée) |
| **Risques** | **FFmpeg est la source d'échecs la plus imprévisible du projet** : codec absent, fichier corrompu, mémoire insuffisante. Second risque : le disque qui se remplit sans avertissement |
| **Complexité** | **Moyenne — 4 à 5 j.** Le contrat `FFmpegRunner` est volontairement sans DSL ([`02-architecture.md`](02-architecture.md) §9.6) |
| **Interdits** | Pas de rendu vidéo complet (étape 7). Pas de montage « intelligent » automatique. Pas de suppression automatique de médias sans confirmation |

**Aucune table créée à cette étape.** Le domaine média est modélisé depuis l'étape 3
(`media_assets`, `transcripts`) et l'étape 4 (`video_renders`).

**Le test de restauration est explicitement rattaché à cette étape** parce qu'une sauvegarde jamais
restaurée n'existe pas ([`03-modele-de-donnees.md`](03-modele-de-donnees.md) §16.2). Il doit être
exécuté au moins trois fois avant d'être considéré comme fiable.

---

### 4.7 Étape 7 — Vidéo (et schéma de la veille)

| Rubrique | Contenu |
|---|---|
| **Objectif** | Produire un short vertical sous-titré à partir d'une vidéo source, et poser le schéma complet de la veille |
| **Fonctionnalités** | Rendu 9:16, sous-titres brûlés depuis la transcription, sélection de séquence assistée, aperçu avant validation, plan de rendu modifiable (`media_planner`), publication toujours en niveau C |
| **Modules** | `packages/media` (rendu, incrustation de sous-titres, plan de montage), `packages/ai` (agent `media_planner`), `prompts/media/`, `packages/core/editorial` (rendus rattachés à un contenu) |
| **Dépendances** | Étape 6 (ingestion, FFmpeg, transcription) |
| **Critères de sortie** | Un short est rendu **hors requête HTTP** (job), la progression est visible, l'échec est explicable, le fichier est retrouvable, un rendu interrompu reprend sans repartir de zéro ; les tables de veille sont créées et migrées |
| **Tests** | Unitaires (construction du graphe FFmpeg, découpage des sous-titres), intégration (rendu complet sur un fichier court), jobs (reprise d'un rendu interrompu), sécurité (chemins, `spawn`) |
| **Risques** | **L'étape la plus longue et la plus imprévisible du plan.** Le rendu vidéo dépend du matériel, des codecs et de la mémoire. Le risque de s'enliser est réel : il faut un fichier de test court et un critère de sortie limité à **un** format |
| **Complexité** | **Élevée — 8 à 12 j.** Si le rendu dépasse 12 jours, le critère de sortie doit être réduit (un seul format, sans transition), pas l'étape allongée |
| **Interdits** | Pas de transitions, pas d'effets, pas de musique automatique, pas de détection de « moments forts » par LLM. Pas de publication par API à partir de la vidéo |

**Tables créées (2)** : `news_sources`, `news_items`. C'est le **seul écart apparent du plan**, et il
est assumé : l'étape 7 est celle où l'on écrit la couche d'**ingestion externe** (téléchargement avec
délai de garde, hachage, déduplication, rétention, comptabilité d'espace disque). Les tables de
veille dépendent exactement de ces mécanismes ; les créer maintenant évite une seconde migration
qui toucherait le même code. Le pipeline de veille, lui, arrive à l'**étape 10**.

---

### 4.8 Étape 8 — Publication par API et budget

| Rubrique | Contenu |
|---|---|
| **Objectif** | Publier par API là où c'est possible (niveau A/B), avec idempotence stricte et plafond de dépense opposable |
| **Fonctionnalités** | Publication par API pour les plateformes acquises, reprise après « erreur ambiguë » sans doublon, repli automatique en niveau C, plafonds (jour/semaine/mois/projet) avec veto avant appel, mode économie, écran de coût et prévision |
| **Modules** | `packages/publishing` (connecteurs A/B, `publish`/`verifyPublished`, idempotence), `packages/config` (budgets, `estimateCost`), `apps/worker` (handler `publish_content`), collecte de métriques planifiée |
| **Dépendances** | Étape 5 (comptes, niveau C), étape 7 (contenus v1 complets) |
| **Critères de sortie** | **Aucun doublon après 20 tests de reprise forcée** (c'est le test critique n° 1 de [`09-tests-et-qualite.md`](09-tests-et-qualite.md) §4) ; un dépassement de budget **retient** le job au lieu de le détruire ; un contenu refusé par l'API est explicable en une phrase ; décision **D4** tranchée (collecte quotidienne ou toutes les 6 h) |
| **Tests** | Connecteurs (conformité partagée à tous), intégration (publication idempotente, reprise, erreur ambiguë), coûts (veto avant envoi), sécurité (jetons, permissions) |
| **Risques** | **Le doublon de publication est le pire défaut possible du produit** : il est public et irréversible. Second risque : les API changent sans prévenir (versions, quotas, refus silencieux) |
| **Complexité** | **Élevée — 6 à 9 j.** L'idempotence et la vérification après envoi sont non négociables |
| **Interdits** | Pas de niveau A pour une plateforme non acquise. Pas de rattrapage automatique de quota. Pas de publication rétroactive en masse |

**Tables créées (4)** : `budget_limits`, `learnings`, `metric_snapshots`, `performance_patterns`.

**Pourquoi les tables d'analytics apparaissent ici et pas à l'étape 11 :** à partir de l'étape 8, le
système agit **seul vers l'extérieur**. C'est le moment où les garde-fous (budgets) et les tables qui
recevront les mesures futures sont posés — la collecte commence, l'**analyse** arrive à l'étape 11.
Un système qui collecte avant d'analyser ne perd rien ; l'inverse est impossible.

---

### 4.9 Étape 9 — Calendrier et planification

| Rubrique | Contenu |
|---|---|
| **Objectif** | Faire partir une publication à l'heure prévue, sans que personne ne clique |
| **Fonctionnalités** | Calendrier hebdomadaire, créneaux par plateforme, `scheduled_for` par publication, file d'attente visible, déplacement d'un créneau, annulation, rappel si un créneau approche sans contenu approuvé |
| **Modules** | `packages/core/scheduling`, `apps/worker/scheduler.ts` (job `promote_scheduled`), `apps/web/routes/dashboard` |
| **Dépendances** | Étape 8 (publication par API et repli manuel) |
| **Critères de sortie** | Un contenu planifié part à l'heure dite, à la minute près ; un contenu non approuvé **ne part pas** et déclenche une notification ; un arrêt du worker pendant la fenêtre de tir ne fait **ni perdre ni dupliquer** la publication (test critique n° 2 de [`09-tests-et-qualite.md`](09-tests-et-qualite.md) §4) ; les fuseaux horaires sont gérés côté base, pas côté navigateur |
| **Tests** | Intégration (fenêtre de tir, horloge simulée), jobs (reprise après arrêt dans la fenêtre), unitaires (calcul des créneaux, changements d'heure) |
| **Risques** | **La fenêtre de tir et l'idempotence se rencontrent ici** : une publication planifiée reprise après un arrêt est le scénario qui produit un doublon si l'idempotence de l'étape 8 est mal faite. Second risque : les changements d'heure, souvent oubliés |
| **Complexité** | **Faible — 2 à 3 j.** C'est l'étape la moins risquée une fois la publication fiable |
| **Interdits** | Pas de « meilleur moment pour publier » calculé par le modèle (c'est l'étape 11, et seulement avec des données). Pas de calendrier partagé multi-utilisateurs |

**Aucune table créée :** `scheduled_for` existe déjà sur `publications` depuis l'étape 5, et le job
`promote_scheduled` est un handler, pas un schéma.

---

### 4.10 Étape 10 — Veille et exploitation continue

| Rubrique | Contenu |
|---|---|
| **Objectif** | Alimenter le système en idées d'actualité sans intervention, et survivre à une semaine complète de fonctionnement sans surveillance |
| **Fonctionnalités** | Sources RSS/Atom ajoutées et testées, collecte périodique, scoring **local** avant tout appel LLM, résumés et « pourquoi ça compte pour ce projet », mise à l'écart d'une actualité, expiration automatique, désactivation automatique d'une source morte ; politique de rétention et de sauvegarde des médias volumineux |
| **Modules** | `packages/news` (collecte, normalisation, déduplication, scoring), `packages/ai` (agent `news_curator`, **jamais** sur une actualité non retenue par le scoring local), `apps/worker` (job `fetch_news`), `apps/web/routes/dashboard` |
| **Dépendances** | Étape 9 (fonctionnement planifié), étape 7 (tables de veille) |
| **Critères de sortie** | Le système tourne **7 jours** sans intervention : aucun job perdu, aucune source morte en boucle, aucun disque plein ; chaque actualité affichée a une **source vérifiable** ; le coût de la veille reste sous le plafond hebdomadaire ; décision **D5** tranchée (sauvegarde des médias : snapshot complet ou base et médias séparés) |
| **Tests** | Intégration (collecte normale, flux mort, flux mal formé, doublons), unitaires (scoring, normalisation d'URL, expiration), coûts (scoring gratuit en local), agents (`news_curator` sur cas de référence) |
| **Risques** | **Le risque est l'usure, pas la panne** : une source qui échoue en silence, des données qui vieillissent, un disque qui se remplit de 3 %. C'est aussi l'étape qui révèle les défauts des étapes 1 et 8 : c'est **voulu** |
| **Complexité** | **Moyenne — 4 à 6 j.** Le scoring local est déterministe et testable ; le reste est du réglage |
| **Interdits** | Pas de lecture intégrale d'articles par LLM (coût). Pas de scraping de sites qui l'interdisent. Pas de veille « temps réel ». Pas de réentraînement |

**Aucune table créée** : le schéma de veille date de l'étape 7 (§1.3).

---

### 4.11 Étape 11 — Analytics et apprentissage

| Rubrique | Contenu |
|---|---|
| **Objectif** | Mesurer ce qui marche et le réinjecter dans la production, sans jamais inventer de causalité |
| **Fonctionnalités** | Collecte des métriques par publication, tableau de bord de performance, corrélations lisibles (`performance_patterns`), apprentissages proposés (`learnings`) et **validés** avant d'influencer un prompt, recommandation de créneaux et de formats |
| **Modules** | `packages/core/analytics`, `packages/ai` (agent `analyst` — **interprète** des chiffres, ne les produit pas), `apps/worker` (job `collect_metrics`), `apps/web/routes/analytics` |
| **Dépendances** | Étape 10 (fonctionnement continu), étape 8 (tables de métriques) |
| **Critères de sortie** | Chaque chiffre affiché est traçable à une source et à une date ; un `learning` non validé **n'entre dans aucun prompt** ; le tableau de bord distingue explicitement corrélation et causalité ; décision **D6** tranchée (mode démo avec données fictives, oui ou non) |
| **Tests** | Intégration (collecte, indisponibilité d'une source), unitaires (calculs, agrégations, fenêtres temporelles), agents (`analyst` : ne doit pas inventer de chiffre), coûts, sécurité (aucune donnée de performance n'est fabriquée) |
| **Risques** | **Le risque principal est l'illusion statistique** : avec 30 publications, toute corrélation est du bruit. L'agent `analyst` doit être contraint de dire « pas assez de données » |
| **Complexité** | **Moyenne — 4 à 6 j.** Le plus dur n'est pas la collecte, c'est de ne pas raconter n'importe quoi |
| **Interdits** | Pas de prédiction de performance. Pas de A/B testing automatique. Pas de modification automatique des prompts (toujours validée) |

**Aucune table créée** : `metric_snapshots`, `performance_patterns` et `learnings` datent de
l'étape 8.

---

### 4.12 Étape 12 — Consolidation et portabilité

| Rubrique | Contenu |
|---|---|
| **Objectif** | Rendre le système déplaçable (cloud, autre machine) et vérifier que rien n'a été cassé par onze étapes |
| **Fonctionnalités** | Restauration complète documentée, migration SQLite → PostgreSQL **testée**, stockage de médias derrière un driver (`LocalStorage` / `S3Storage`), conteneurs `api` et `worker`, revue de sécurité, suite `live` complète, documentation à jour |
| **Modules** | `packages/database` (dialecte PostgreSQL), `packages/media` (driver de stockage), `Dockerfile` × 2, `docker-compose`, `scripts/`, `docs/` |
| **Dépendances** | Les onze étapes précédentes |
| **Critères de sortie** | La même suite de tests passe sur SQLite **et** sur PostgreSQL ; l'application redémarre sur une base restaurée sans intervention manuelle ; aucune logique métier n'est modifiée par la migration (le domaine ignorait le dialecte — c'est la validation de [`02-architecture.md`](02-architecture.md) §16.10) ; les secrets ne sont jamais dans l'image |
| **Tests** | Suite complète sur les deux dialectes, restauration, sécurité (revue, canari, permissions), E2E |
| **Risques** | **Découvrir trop tard une dépendance à SQLite** : requêtes brutes, `RETURNING`, verrous, types de dates. Le risque est faible **parce que** Drizzle a été choisi pour cela — mais il doit être vérifié, pas supposé |
| **Complexité** | **Moyenne — 5 à 8 j.** C'est une étape de vérification plus que de construction |
| **Interdits** | Pas de multi-utilisateur, pas de multi-tenant, pas de facturation. Pas de migration de données réelles sans sauvegarde vérifiée |

**Aucune table créée.**

**Cette étape n'existe pas pour « faire du cloud »** : elle existe pour **mesurer** si la frontière
posée à l'étape 1 a tenu. Si le passage à PostgreSQL demande de toucher `packages/core`, alors une
règle d'architecture a été violée — et on l'apprend à l'étape 12 au lieu de l'apprendre en production.

---

## 5. Récapitulatif : tables créées, décisions à trancher

### 5.1 Les 41 tables réparties sur les étapes

Ce tableau est la contrepartie exacte de [`03-modele-de-donnees.md`](03-modele-de-donnees.md) §3 :
**chaque table est créée à l'étape indiquée, sans exception**.

| Étape | Tables créées | Nombre | Cumul |
|---|---|---|---|
| 1 | `users`, `app_settings`, `llm_providers_config`, `projects`, `project_goals`, `project_facts`, `project_skill_facts`, `style_profiles`, `audience_profiles`, `jobs`, `job_events`, `llm_calls`, `prompt_versions` | 13 | 13 |
| 2 | `conversations`, `messages`, `conversation_summaries`, `master_briefs` | 4 | 17 |
| 3 | `message_attachments`, `content_subjects`, `subject_angles`, `media_assets`, `transcripts` | 5 | 22 |
| 4 | `content_items`, `content_versions`, `content_claims`, `content_review_notes`, `video_renders`, `errors`, `system_health`, `notifications` | 8 | 30 |
| 5 | `project_platforms`, `platform_accounts`, `publications`, `publication_attempts`, `manual_packages` | 5 | 35 |
| 6 | — | 0 | 35 |
| 7 | `news_sources`, `news_items` | 2 | 37 |
| 8 | `budget_limits`, `learnings`, `metric_snapshots`, `performance_patterns` | 4 | 41 |
| 9 | — | 0 | 41 |
| 10 | — | 0 | 41 |
| 11 | — | 0 | 41 |
| 12 | — | 0 | 41 |

**Ce que ce tableau démontre :** 30 des 41 tables (73 %) existent avant la fin de la V1. C'est
volontaire — un produit qui parle, génère, valide et publie couvre déjà l'essentiel du modèle de
données. Les onze tables restantes concernent l'ingestion externe, l'argent et la mesure.

### 5.2 Les six décisions ouvertes, rattachées à leur étape

Ces décisions viennent de [`02-architecture.md`](02-architecture.md) §15. Chacune doit être
**tranchée par écrit** (format contexte / options / décision / conséquences) dans
[`11-risques-decisions-et-limites.md`](11-risques-decisions-et-limites.md) **avant** l'étape
concernée — jamais pendant, jamais après.

| # | Décision | À trancher avant | Pourquoi pas avant |
|---|---|---|---|
| D1 | Nombre de plateformes de la V1 (1, 2 ou 3) | Étape 5 | La réponse dépend de ce que les connecteurs permettent réellement, et du temps disponible |
| D2 | Transcription : `small` ou `medium` par défaut | Étape 3 | Il faut la mesure réelle sur 20 appels, faite à l'étape 3 |
| D3 | Adaptation multi-plateformes : LLM validée ou réécriture humaine | Étape 6 | La réponse dépend de la qualité observée à l'étape 4 |
| D4 | Fréquence de collecte analytics (quotidien ou 6 h) | Étape 8 | Dépend du coût réel de l'API de la plateforme et du quota disponible |
| D5 | Sauvegarde des médias : snapshot complet ou séparé | Étape 10 | Dépend du volume réellement accumulé après une semaine d'exploitation |
| D6 | Mode démo avec données fictives | Étape 11 | Dépend du temps restant et de l'usage prévu (démonstration à un tiers) |

**La colonne « pourquoi pas avant » est la plus importante du tableau.** Une décision tranchée trop
tôt est une décision prise sans information : c'est exactement le mécanisme qui produit un plan
qu'on ne suit pas.

---

## 6. Ce qu'il ne faut à aucune étape

Cette liste est volontairement courte — le détail des refus est dans
[`07-securite-secrets-auth.md`](07-securite-secrets-auth.md) §12,
[`08-jobs-observabilite-couts.md`](08-jobs-observabilite-couts.md) §13 et
[`09-tests-et-qualite.md`](09-tests-et-qualite.md) §15. Ici figurent les refus **transversaux**, ceux
qui doivent rester vrais du début à la fin :

| # | Interdit permanent | Pourquoi |
|---|---|---|
| 1 | **Pas de multi-utilisateur** | Chaque fonctionnalité multi-utilisateur coûte du temps sur les permissions, les conflits et les migrations. Le produit est personnel ([`01-vision-produit.md`](01-vision-produit.md) §2) |
| 2 | **Pas de publication sans approbation** | L'invariant le plus important du produit. Il est testé dès l'étape 5 et jamais relâché |
| 3 | **Pas de donnée fabriquée affichée** | Aucun chiffre de performance, aucune actualité, aucun fait de mémoire ne peut être inventé. Un affichage vide est toujours préférable ([`09-tests-et-qualite.md`](09-tests-et-qualite.md) §12) |
| 4 | **Pas d'embeddings ni de RAG** | Le contexte explicite suffit largement à cette échelle. Le jour où il ne suffit plus, la décision sera prise sur une mesure, pas par anticipation |
| 5 | **Pas de file externe (Redis, BullMQ, RabbitMQ)** | La file vit dans la table `jobs` ([`08-jobs-observabilite-couts.md`](08-jobs-observabilite-couts.md) §1) |
| 6 | **Pas de CI distante** | La vérification est locale ([`09-tests-et-qualite.md`](09-tests-et-qualite.md) §13). Pas de GitHub Actions, pas de secrets dans un service tiers |
| 7 | **Pas de moteur de workflow visuel** | Les pipelines sont du code typé ([`05-pipelines.md`](05-pipelines.md) §1) |
| 8 | **Pas de second runtime** | Pas de Python, pas de Java, pas de Go. Un seul langage : TypeScript ([`02-architecture.md`](02-architecture.md) §5) |
| 9 | **Pas de compte utilisateur cloud obligatoire** | L'application démarre sans connexion à un service tiers, sauf pour le LLM |
| 10 | **Pas de fonctionnalité sans test du chemin d'échec** | Une fonctionnalité qui n'a jamais été vue échouer n'est pas terminée ([`09-tests-et-qualite.md`](09-tests-et-qualite.md) §14) |

---

## 7. Synthèse

### 7.1 Les quatre jalons de revue

Il n'y a pas de revue à chaque étape : il y en a **quatre**, aux points où une décision structurante a
été prise et où un retour en arrière coûterait cher.

| Jalon | Après l'étape | Question posée | Décision possible |
|---|---|---|---|
| **J1** | 5 (fin de la V1) | Le contenu produit est-il **utilisable tel quel**, ou faut-il le réécrire entièrement ? | Continuer / revoir la stratégie de prompts / arrêter le projet |
| **J2** | 6 | La sauvegarde restaurée donne-t-elle un système réellement fonctionnel ? | Continuer la V2 / refaire la stratégie de stockage avant d'aller plus loin |
| **J3** | 9 (fin de la V2) | Le système a-t-il tourné **une semaine** sans que l'utilisateur corrige quelque chose à la main ? | Continuer la V3 / stabiliser avant d'ajouter |
| **J4** | 12 (fin) | La migration PostgreSQL a-t-elle laissé `packages/core` intact ? | Terminer / corriger les violations de frontière |

**Le jalon J1 est le seul qui peut arrêter le projet.** Et c'est précisément pour cela qu'il est placé
tôt : découvrir après onze étapes que le contenu généré n'est pas bon serait la pire issue possible.

### 7.2 Les trois tests critiques, rattachés à leur étape

[`09-tests-et-qualite.md`](09-tests-et-qualite.md) §4 impose trois tests écrits avant toute
fonctionnalité. Le plan indique où ils arrivent :

| Test critique | Étape où il doit exister | Ce qu'il empêche |
|---|---|---|
| Publication non dupliquée (reprise forcée) | **8** (et son socle à l'étape 1 : reprise de job) | Un doublon public et irréversible |
| Reprise après crash du worker | **1** (socle), vérifié à **9** sur la fenêtre de tir | Une publication perdue ou faite deux fois |
| Refus de budget **avant** l'envoi | **8** | Une dépense que l'utilisateur n'a pas autorisée |

### 7.3 Les huit décisions structurantes de ce plan

| # | Décision | Conséquence |
|---|---|---|
| 1 | Trois versions (V1 cœur, V2 industrialisation, V3 autonomie) | Chaque version est un produit utilisable, pas une couche technique |
| 2 | **La publication manuelle (niveau C) dès l'étape 5** | Le produit est utile avant toute validation d'API externe |
| 3 | La mémoire avant la génération (étape 2 avant étape 4) | Le différenciateur est en place avant l'amplification |
| 4 | La table d'abord, le pipeline ensuite (§1.3) | Une seule migration par domaine, jamais une migration par fonctionnalité |
| 5 | La vidéo après les textes | La partie la plus imprévisible ne retarde pas la première publication |
| 6 | Les tables d'argent et de mesure à l'étape 8 | Les garde-fous arrivent **avant** que le système agisse seul vers l'extérieur |
| 7 | Les décisions D1–D6 tranchées juste avant leur étape, par écrit | Aucune décision prise sans information, aucune décision orale |
| 8 | Quatre jalons de revue seulement, dont un peut arrêter le projet | Le plan reste suivi parce qu'il est vérifié à des moments choisis |

### 7.4 Trois questions, trois réponses

**« Pourquoi l'étape 12 si l'objectif est local ? »**
Parce que la portabilité est le **test** de la frontière posée à l'étape 1
([`02-architecture.md`](02-architecture.md) §16.10). Un domaine qui ne sait pas migrer est un domaine
qui a laissé fuiter SQLite, un chemin de fichier ou un verrou de processus dans sa logique métier.
C'est un test, pas une fonctionnalité.

**« Que se passe-t-il si une étape prend deux fois plus de temps ? »**
Le critère de sortie se **réduit**, l'étape ne s'allonge pas. C'est écrit aux étapes 4 et 7, qui sont
les plus lourdes. Un plan dont les étapes s'allongent indéfiniment n'est plus un plan.

**« Pourquoi ne pas commencer par ce qui se voit ? »**
Parce que ce qui se voit sans mémoire est exactement ce que le produit doit remplacer
([`01-vision-produit.md`](01-vision-produit.md) §5). Le §3.3 détaille cet ordre écarté.

### 7.5 Ce que ce plan n'est pas

| Ce n'est pas | Pourquoi |
|---|---|
| Une estimation contractuelle | Les charges sont des ordres de grandeur pour comparer les étapes, pas un engagement de délai |
| Un engagement de fonctionnalités | Chaque étape peut voir son périmètre réduit si son critère de sortie l'exige |
| Un remplacement de [`05-pipelines.md`](05-pipelines.md) | Ce document ordonne le travail ; il ne décrit pas les pipelines, qui restent la référence technique |
| Une liste de tâches | Le découpage en tâches d'une journée est fait au moment d'attaquer l'étape, pas douze semaines avant |

---

**Suite de la lecture**

- Décisions, options et conséquences → [`11-risques-decisions-et-limites.md`](11-risques-decisions-et-limites.md)
- Pipelines détaillés → [`05-pipelines.md`](05-pipelines.md)
- Définition de « terminé » → [`09-tests-et-qualite.md`](09-tests-et-qualite.md) §14
- Modèle de données et étape de création → [`03-modele-de-donnees.md`](03-modele-de-donnees.md) §3









