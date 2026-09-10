# Cahier des charges complet — Plateforme IA d’automatisation de contenu

## 1. Rôle demandé à Claude

Tu es **architecte logiciel senior**.  
Ta mission n’est **pas de coder l’application maintenant**.

Tu dois concevoir l’architecture complète d’un produit d’automatisation de contenu orienté développement web, IA et projets techniques.

Je veux obtenir :

- l’architecture générale du produit ;
- les modules nécessaires ;
- les responsabilités de chaque module ;
- les flux de données ;
- le modèle de données ;
- l’architecture des agents IA ;
- la gestion de la mémoire ;
- la gestion des coûts IA ;
- les pipelines texte, voix, image et vidéo ;
- le système de validation humaine ;
- la planification ;
- la publication ;
- les analytics ;
- la veille technologique ;
- la sécurité ;
- les secrets/API ;
- les systèmes de retry et de reprise après erreur ;
- la structure du monorepo ;
- la stratégie de tests ;
- la stratégie de déploiement ;
- un découpage clair en phases de développement ;
- les dépendances entre les phases ;
- les risques techniques ;
- les compromis ;
- les fonctionnalités qui doivent être locales, cloud ou hybrides.

Tu dois concevoir **le produit final complet**, puis le découper en phases.

Ne limite pas ta réflexion à une MVP/V1.

La V1 sera définie après l’architecture complète.

---

# 2. Description exacte du produit

Le produit est une **plateforme personnelle d’automatisation de contenu assistée par IA**.

Son utilisateur principal est un développeur qui travaille sur plusieurs projets techniques et veut documenter ce qu’il construit sans devoir lui-même gérer tout le processus éditorial.

L’application doit transformer :

> une conversation naturelle avec l’utilisateur

en :

> idées → questions → angle éditorial → scripts → textes → médias → brouillons → validation → publication → analytics → apprentissage.

L’objectif n’est pas de publier automatiquement du contenu générique.

L’objectif est de construire un **assistant éditorial intelligent capable de comprendre les projets, les expériences, les opinions et les apprentissages de l’utilisateur**, puis de les transformer en contenu intéressant.

---

# 3. Objectifs du produit

Le produit doit permettre à l’utilisateur de :

1. documenter ses projets techniques ;
2. augmenter sa visibilité ;
3. construire une présence publique autour du développement et de l’IA ;
4. attirer des recruteurs ;
5. attirer éventuellement des clients freelance ;
6. créer un réseau professionnel ;
7. rendre visibles ses capacités de raisonnement et sa manière de construire des produits ;
8. transformer ses projets en contenu ;
9. utiliser les actualités tech comme source secondaire de contenu ;
10. réduire drastiquement le temps nécessaire pour produire et publier du contenu ;
11. conserver un contrôle humain avant publication ;
12. apprendre progressivement quels sujets et formats fonctionnent le mieux.

---

# 4. Positionnement éditorial

Le contenu sera principalement orienté vers :

- développement web ;
- frontend ;
- React ;
- TypeScript ;
- JavaScript ;
- Astro ;
- architecture logicielle ;
- outils développeurs ;
- automatisation ;
- agents IA ;
- orchestrateurs IA ;
- LLM ;
- développement assisté par IA ;
- Linux et environnement de développement ;
- retours d’expérience techniques ;
- construction de projets ;
- tests d’outils et technologies ;
- erreurs, limites et leçons apprises.

L’utilisateur ne veut pas devenir un simple compte d’actualité IA.

Les actualités servent seulement de **source secondaire** lorsque :

- elles sont réellement intéressantes ;
- elles sont liées à ses sujets ;
- elles lui permettent d’apporter un angle personnel ;
- il n’a pas de meilleur sujet issu de ses projets.

---

# 5. Projets qui serviront de matière première

L’application doit être capable de conserver une mémoire de nombreux projets.

Exemples actuels :

- application de gestion financière ;
- Hire Stack ;
- site chiens/chats développé avec Astro ;
- site d’apprentissage de l’italien ;
- orchestrateurs IA locaux ;
- orchestrateurs IA destinés au cloud ;
- expériences Codex ;
- expériences DeepSeek ;
- outils autour des agents IA ;
- projets frontend ;
- prototypes ;
- expériences techniques futures.

Le système doit être générique et accepter un nombre indéfini de projets.

---

# 6. Mémoire des projets

Pour chaque projet, le système doit pouvoir conserver progressivement :

- nom ;
- description ;
- problème traité ;
- motivation ;
- objectif ;
- public cible ;
- stack ;
- technologies testées ;
- technologies réellement maîtrisées ;
- technologies principalement utilisées avec assistance IA ;
- architecture ;
- fonctionnalités ;
- décisions techniques ;
- difficultés ;
- erreurs ;
- solutions ;
- compromis ;
- apprentissages ;
- état actuel ;
- prochaines étapes ;
- captures disponibles ;
- vidéos disponibles ;
- URLs ;
- ressources ;
- sujets déjà publiés ;
- angles déjà utilisés ;
- questions déjà posées ;
- résultats des contenus précédents liés au projet.

Cette mémoire doit éviter de redemander les mêmes informations inutilement.

Elle doit également éviter que l’IA invente des faits.

---

# 7. Interaction principale

L’application doit fonctionner comme une conversation.

L’utilisateur ouvre l’application.

L’assistant peut demander :

> De quoi veux-tu parler aujourd’hui ?

L’utilisateur peut répondre par :

- texte ;
- voix.

Exemple :

> Aujourd’hui je veux parler de mon orchestrateur IA. J’ai réussi à faire travailler plusieurs agents ensemble et je veux montrer pourquoi je l’ai construit.

L’IA doit ensuite :

1. comprendre le sujet ;
2. consulter la mémoire pertinente ;
3. détecter les informations manquantes ;
4. poser seulement les questions utiles ;
5. éviter les questions déjà résolues par la mémoire ;
6. déterminer les angles possibles ;
7. signaler si le sujet est trop faible ou trop vague ;
8. suggérer une meilleure approche si nécessaire ;
9. produire une fiche maître du sujet.

---

# 8. Entrée vocale

L’entrée vocale fait partie du produit.

Le système doit permettre :

- enregistrement depuis le navigateur ou l’application ;
- transcription ;
- correction éventuelle ;
- transformation en texte exploitable par l’orchestrateur.

Priorité :

- transcription locale ou très peu coûteuse ;
- faible latence ;
- français supporté correctement ;
- possibilité d’utiliser une API cloud si nécessaire.

La réponse vocale de l’assistant n’est pas obligatoire au départ.

La sortie texte suffit.

---

# 9. Fiche maître du sujet

Après la conversation, l’orchestrateur doit produire une représentation structurée commune.

Exemple conceptuel :

```json
{
  "subject": "",
  "project": "",
  "context": "",
  "why_it_matters": "",
  "problem": "",
  "solution": "",
  "technical_points": [],
  "personal_opinion": "",
  "lessons": [],
  "proofs": [],
  "media_available": [],
  "target_audience": [],
  "possible_angles": [],
  "selected_angle": "",
  "claims_to_verify": [],
  "sensitive_or_uncertain_points": []
}
```

Cette fiche devient la **source de vérité du contenu du jour**.

Les agents spécialisés ne doivent pas relire tout l’historique complet s’ils n’en ont pas besoin.

---

# 10. Orchestrateur IA

Le produit possède un orchestrateur principal.

Son rôle :

- comprendre la demande ;
- récupérer le contexte nécessaire ;
- gérer la conversation ;
- créer la fiche maître ;
- choisir les agents nécessaires ;
- leur fournir un contexte minimal ;
- récupérer leurs résultats ;
- vérifier la cohérence ;
- détecter les contradictions ;
- préparer les brouillons ;
- attendre la validation utilisateur ;
- déclencher la publication seulement après validation.

Schéma conceptuel :

```text
Utilisateur
   ↓
Assistant conversationnel
   ↓
Mémoire / projets / historique
   ↓
Fiche maître
   ↓
Orchestrateur
   ├── Agent stratégie éditoriale
   ├── Agent LinkedIn
   ├── Agent Reddit
   ├── Agent TikTok
   ├── Agent YouTube Shorts
   ├── Agent YouTube long
   ├── Agent hooks/titres
   ├── Agent hashtags
   ├── Agent scripts
   ├── Agent médias
   ├── Agent vérification
   └── Agent analytics
```

Claude doit déterminer si tous ces agents doivent réellement être indépendants ou si certains doivent être regroupés pour réduire la complexité et les coûts.

---

# 11. Plateformes ciblées

Un seul compte par plateforme au départ.

Plateformes :

- LinkedIn ;
- Reddit ;
- TikTok ;
- YouTube Shorts ;
- YouTube vidéos longues.

Le produit doit être conçu de manière extensible afin d’ajouter d’autres plateformes plus tard.

---

# 12. Génération spécifique par plateforme

Le même contenu ne doit pas être copié-collé partout.

Chaque plateforme doit avoir sa propre adaptation.

## LinkedIn

Style :

- professionnel ;
- crédible ;
- accessible ;
- orienté développement ;
- intéressant pour recruteurs, développeurs et clients ;
- pas de jargon inutile ;
- pas de faux storytelling ;
- pas de fausse expertise.

Sortie :

- hook ;
- texte ;
- CTA éventuel ;
- hashtags ;
- média recommandé.

---

## Reddit

Le contenu ne doit pas ressembler à une publicité automatique.

Style :

- communautaire ;
- technique ;
- transparent ;
- utile ;
- conversationnel.

Le système doit considérer :

- subreddit ;
- règles du subreddit ;
- titre ;
- corps ;
- liens autorisés ;
- auto-promotion ;
- flair ;
- risque de spam.

---

## TikTok

Le système doit préparer :

- hook ;
- script ;
- durée ;
- structure ;
- texte affiché ;
- sous-titres ;
- description ;
- hashtags ;
- média ;
- CTA éventuel.

---

## YouTube Shorts

Le système doit préparer :

- hook ;
- script vertical ;
- durée ;
- titre ;
- description ;
- hashtags ;
- sous-titres ;
- montage ;
- média.

---

## YouTube long

Objectif approximatif :

- jusqu’à deux vidéos par semaine lorsque suffisamment de matière existe.

Le système doit préparer :

- idée ;
- angle ;
- titre ;
- structure ;
- script ou plan ;
- chapitres ;
- démonstrations ;
- séquences écran ;
- B-roll éventuel ;
- description ;
- tags ;
- assets nécessaires ;
- proposition de miniature.

La miniature finale peut être réalisée manuellement ou par un designer.

---

# 13. Création vidéo

L’utilisateur doit pouvoir fournir :

- une vidéo face caméra ;
- un enregistrement d’écran ;
- une démonstration d’application ;
- un fichier audio ;
- plusieurs clips ;
- des images.

Le système doit pouvoir automatiser autant que possible :

- découpage ;
- suppression des silences si pertinent ;
- recadrage ;
- conversion verticale ;
- sous-titres ;
- texte à l’écran ;
- transitions simples ;
- zooms ;
- normalisation audio ;
- assemblage ;
- export ;
- prévisualisation.

Priorité aux outils gratuits et locaux.

FFmpeg doit être évalué comme moteur principal.

Éviter de dépendre dès le départ de services coûteux de génération vidéo.

Le système doit pouvoir évoluer plus tard vers des fournisseurs IA vidéo externes.

---

# 14. Images et captures

Le système doit gérer :

- screenshots ;
- captures de sites ;
- images existantes ;
- logos ;
- illustrations ;
- images générées ;
- formats spécifiques aux plateformes.

Il doit pouvoir associer les médias aux projets et les réutiliser.

Il doit éviter d’utiliser plusieurs fois la même image de manière répétitive.

---

# 15. Validation humaine obligatoire

Principe non négociable :

**aucun contenu ne doit être publié sans validation utilisateur.**

Avant publication, l’utilisateur doit pouvoir voir :

- plateforme ;
- texte ;
- titre ;
- hashtags ;
- média ;
- vidéo ;
- miniature ;
- description ;
- date prévue ;
- informations incertaines ;
- éventuels risques détectés.

Actions disponibles :

- approuver ;
- modifier manuellement ;
- demander une modification à l’IA ;
- régénérer ;
- changer d’angle ;
- refuser ;
- reporter ;
- supprimer.

---

# 16. Dashboard

Créer une interface permettant de voir clairement l’état du contenu.

Exemple :

```text
CONTENU DU JOUR

Sujet :
Mon orchestrateur IA

LinkedIn        → prêt
Reddit          → prêt
TikTok          → montage
YouTube Short   → prêt
YouTube long    → non prévu

Vidéo :
[Prévisualiser]

Titre :
...

Description :
...

Hashtags :
...

[Modifier]
[Régénérer]
[Approuver]
[Programmer]
[Refuser]
```

Prévoir également :

- historique ;
- calendrier ;
- projets ;
- idées ;
- brouillons ;
- médias ;
- publications ;
- analytics ;
- dépenses IA ;
- réglages ;
- intégrations.

---

# 17. Calendrier éditorial

Le produit doit disposer d’un calendrier.

Rythme cible potentiel :

- LinkedIn : quotidien ;
- Reddit : jusqu’à quotidien si pertinent ;
- TikTok : quotidien ;
- YouTube Shorts : quotidien ;
- YouTube long : environ 2 fois par semaine.

Important :

Le système ne doit pas publier un contenu faible simplement pour respecter une fréquence.

Il doit pouvoir proposer :

> Aucun sujet ne mérite une publication aujourd’hui.

ou :

> Voici trois idées plus fortes.

---

# 18. Générateur d’idées

Si l’utilisateur dit :

> Je n’ai pas d’idée.

Le système doit exploiter :

- projets existants ;
- fonctionnalités récentes ;
- difficultés rencontrées ;
- erreurs ;
- décisions techniques ;
- comparaisons ;
- apprentissages ;
- contenus qui n’ont jamais été publiés ;
- anciens sujets pouvant avoir une nouvelle perspective ;
- actualités pertinentes.

Exemples :

- pourquoi j’ai choisi Astro pour ce projet ;
- ce que j’ai découvert en utilisant une technologie hors de ma stack habituelle ;
- erreur faite pendant la conception ;
- comment j’utilise plusieurs agents IA ;
- ce que l’IA fait très bien et ce que je dois vérifier ;
- comparaison entre deux outils ;
- démonstration d’une fonctionnalité ;
- retour d’expérience après plusieurs jours ;
- architecture d’un projet ;
- avant/après.

---

# 19. Veille technologique

Le produit doit pouvoir rechercher automatiquement des actualités pertinentes.

Domaines possibles :

- frontend ;
- React ;
- JavaScript ;
- TypeScript ;
- Astro ;
- Node.js ;
- IA ;
- LLM ;
- agents ;
- Codex ;
- DeepSeek ;
- outils développeurs ;
- Linux ;
- open source.

Contraintes :

- ne pas envoyer des dizaines d’articles complets au LLM ;
- récupérer d’abord des métadonnées ;
- filtrer sans LLM lorsque possible ;
- dédupliquer ;
- scorer ;
- n’envoyer que les meilleurs candidats au modèle ;
- résumer uniquement lorsque nécessaire ;
- conserver les sources ;
- ne jamais inventer une news ;
- pouvoir marquer une information comme non vérifiée ;
- vérifier la date ;
- éviter les contenus obsolètes.

Pipeline souhaité :

```text
RSS / API / sources
   ↓
filtrage mécanique
   ↓
déduplication
   ↓
scoring
   ↓
petit modèle
   ↓
1 à 5 news intéressantes
   ↓
validation / choix utilisateur
   ↓
création éventuelle de contenu
```

---

# 20. Publication

Après validation :

```text
Validation
   ↓
Connecteur plateforme
   ↓
Publication / programmation
```

Lorsque la plateforme le permet.

Le produit doit supporter plusieurs stratégies :

### Niveau A — API officielle

Publication via API.

### Niveau B — brouillon distant

Envoyer le contenu dans une boîte de brouillons si la plateforme le permet.

### Niveau C — brouillon local

Préparer :

- texte ;
- titre ;
- hashtags ;
- vidéo ;
- miniature ;
- description.

Puis permettre :

- copier ;
- télécharger ;
- ouvrir la plateforme ;
- publication manuelle.

Le workflow ne doit jamais être bloqué simplement parce qu’une plateforme refuse l’automatisation.

Claude doit vérifier les contraintes actuelles de chaque API au moment de la conception et isoler les intégrations dans des adaptateurs.

---

# 21. Architecture des connecteurs

Prévoir une abstraction du type :

```text
PlatformConnector
├── authenticate()
├── validateContent()
├── createDraft()
├── publish()
├── schedule()
├── fetchMetrics()
└── getCapabilities()
```

Chaque plateforme doit déclarer ses capacités.

Exemple conceptuel :

```json
{
  "directPublish": true,
  "draft": false,
  "schedule": true,
  "analytics": true,
  "videoUpload": true
}
```

Le produit ne doit pas supposer que toutes les plateformes proposent les mêmes possibilités.

---

# 22. Analytics

Le système doit progressivement récupérer les performances.

Mesures possibles :

- impressions ;
- vues ;
- watch time ;
- likes ;
- commentaires ;
- partages ;
- sauvegardes ;
- abonnements ;
- visites de profil ;
- clics ;
- CTR ;
- clics portfolio ;
- messages entrants ;
- leads ;
- contacts recruteurs ;
- contacts clients.

Lorsque l’API ne fournit pas une métrique, le système doit pouvoir permettre une saisie manuelle.

---

# 23. Boucle d’apprentissage

Le produit doit utiliser les résultats pour améliorer les recommandations.

```text
Création
  ↓
Publication
  ↓
Résultats
  ↓
Analyse
  ↓
Patterns
  ↓
Recommandations
  ↓
Nouveau contenu
```

Le système doit pouvoir apprendre :

- sujets performants ;
- hooks performants ;
- longueur ;
- formats ;
- plateformes ;
- heures ;
- types de vidéos ;
- tonalités ;
- CTA ;
- projets qui intéressent le plus.

Mais il ne doit pas tomber dans une optimisation aveugle basée uniquement sur les likes.

Priorité aux signaux réellement utiles :

- visites de profil ;
- clics ;
- contacts ;
- recruteurs ;
- leads ;
- conversations utiles.

---

# 24. Expérimentation et promotion payante

Plus tard, l’utilisateur pourra amplifier certains contenus avec un petit budget publicitaire.

Le système ne doit pas gérer cela automatiquement au départ.

Mais son modèle de données doit permettre de noter :

- contenu organique ;
- contenu promu ;
- montant dépensé ;
- période ;
- impressions payées ;
- conversions ;
- ROI.

L’objectif est de comparer organique et payant.

---

# 25. Gestion des coûts IA

Contrainte majeure.

Le budget IA doit rester faible.

Budget de référence :

- environ 5 USD/semaine pour ce système lorsque possible ;
- ne pas concevoir une architecture où plusieurs agents consomment énormément de contexte inutilement.

Le produit doit enregistrer :

- fournisseur ;
- modèle ;
- tokens input ;
- tokens output ;
- cache ;
- coût ;
- tâche ;
- agent ;
- projet ;
- contenu ;
- date.

Dashboard possible :

```text
Budget semaine : 5.00 $
Dépensé :        1.43 $
Restant :        3.57 $

Conversation :   0.12 $
News :           0.09 $
LinkedIn :       0.07 $
Reddit :         0.06 $
Scripts vidéo :  0.21 $
```

Prévoir :

- quotas ;
- plafond journalier ;
- plafond hebdomadaire ;
- alertes ;
- mode économie ;
- cache ;
- déduplication des appels ;
- modèle moins cher pour tâches simples ;
- modèle plus puissant seulement pour tâches complexes.

---

# 26. Fournisseurs IA

DeepSeek est actuellement envisagé comme fournisseur principal.

Cependant l’architecture ne doit pas dépendre exclusivement d’un seul fournisseur.

Créer une abstraction permettant plus tard :

- DeepSeek ;
- OpenAI ;
- Anthropic ;
- Gemini ;
- modèles locaux ;
- OpenRouter ;
- autres fournisseurs.

Exemple conceptuel :

```text
LLMProvider
├── generate()
├── structuredOutput()
├── estimateCost()
├── capabilities()
└── healthCheck()
```

Claude doit proposer la meilleure abstraction.

---

# 27. Modèles locaux

Le produit doit pouvoir utiliser localement certains modèles lorsque cela réduit les coûts et reste suffisamment fiable.

Tâches candidates :

- transcription ;
- classification ;
- tagging ;
- déduplication ;
- résumés simples ;
- embeddings ;
- recherche sémantique.

Les tâches éditoriales critiques peuvent rester sur un modèle cloud.

Claude doit déterminer ce qui vaut réellement la peine d’être local compte tenu d’un PC relativement modeste.

---

# 28. Base de données

SQLite est une option intéressante pour le départ local.

Mais l’architecture doit permettre un passage vers PostgreSQL si le produit devient cloud ou multi-device.

Claude doit définir :

- schéma ;
- migrations ;
- relations ;
- stockage des messages ;
- projets ;
- sujets ;
- contenus ;
- versions ;
- publications ;
- métriques ;
- médias ;
- jobs ;
- erreurs ;
- coûts IA ;
- intégrations ;
- credentials ;
- calendrier.

---

# 29. Versioning du contenu

Chaque contenu doit conserver ses versions.

Exemple :

```text
LinkedIn post
v1 → généré
v2 → utilisateur demande plus court
v3 → utilisateur modifie manuellement
v4 → approuvé
```

Il doit être possible de savoir :

- ce qui a été généré ;
- ce qui a été modifié ;
- ce qui a été publié.

---

# 30. Médias

Le système doit gérer une bibliothèque de médias.

Types :

- image ;
- screenshot ;
- vidéo ;
- audio ;
- miniature ;
- export final.

Métadonnées :

- projet ;
- sujet ;
- date ;
- format ;
- résolution ;
- durée ;
- tags ;
- source ;
- utilisation ;
- hash ;
- statut.

Prévoir détection de duplicats.

---

# 31. Jobs asynchrones

Certaines opérations peuvent prendre longtemps :

- transcription ;
- montage vidéo ;
- génération ;
- upload ;
- publication ;
- analytics ;
- veille.

Elles ne doivent pas bloquer l’interface.

Prévoir un système de jobs/queue.

Claude doit décider si une vraie queue externe est nécessaire immédiatement ou si une abstraction locale suffit au départ.

Les jobs doivent avoir :

- queued ;
- running ;
- completed ;
- failed ;
- retrying ;
- cancelled.

---

# 32. Reprise après erreur

Le système doit supporter :

- retry ;
- backoff ;
- idempotence ;
- reprise après crash ;
- interruption réseau ;
- quota API ;
- API indisponible ;
- upload échoué ;
- publication ambiguë ;
- expiration OAuth.

Important :

Ne jamais republier accidentellement deux fois le même contenu après un retry.

---

# 33. Sécurité

Le système utilisera des clés API et OAuth.

Prévoir :

- stockage sécurisé ;
- chiffrement des secrets ;
- variables d’environnement ;
- séparation frontend/backend ;
- jamais de clé API sensible exposée dans le navigateur ;
- permissions minimales ;
- rotation ;
- expiration ;
- révocation ;
- protection CSRF ;
- protection XSS ;
- validation des fichiers ;
- contrôle des uploads ;
- limites de taille ;
- sanitation ;
- logs sans secrets.

---

# 34. Authentification

Même si l’application commence en usage personnel, son architecture doit permettre :

- session locale simple ;
- verrouillage ;
- éventuellement compte utilisateur plus tard ;
- OAuth pour plateformes.

Pas besoin de complexifier inutilement la première phase.

---

# 35. Transparence IA

Le produit ne doit pas présenter comme une compétence maîtrisée une technologie utilisée principalement par IA si l’utilisateur ne peut pas la défendre techniquement.

L’IA doit :

- éviter les affirmations fausses ;
- signaler les claims non vérifiés ;
- distinguer expérience, test, utilisation et maîtrise ;
- éviter de créer une fausse expertise ;
- pouvoir demander confirmation.

---

# 36. Qualité éditoriale

Le système doit détecter :

- contenu vide ;
- répétitions ;
- jargon inutile ;
- exagérations ;
- hooks mensongers ;
- clickbait trompeur ;
- fausses métriques ;
- contenu trop proche d’un ancien post ;
- informations non vérifiées ;
- ton trop commercial sur Reddit.

Il doit pouvoir dire :

> Ce sujet n’est pas assez intéressant en l’état.

Et proposer une amélioration.

---

# 37. Anti-spam

Le produit ne doit pas être conçu comme une ferme à spam.

Règles :

- un compte principal par plateforme au départ ;
- validation humaine ;
- pas de publication massive non supervisée ;
- respect des politiques des plateformes ;
- fréquence raisonnable ;
- adaptation à chaque communauté.

L’architecture pourra techniquement supporter plusieurs comptes plus tard, mais ce n’est pas la priorité actuelle.

---

# 38. Stack technique envisagée

Hypothèse de départ :

### Frontend
- React ;
- TypeScript.

### Backend
- Node.js ;
- TypeScript.

### Base
- SQLite local ;
- migration possible vers PostgreSQL.

### IA
- DeepSeek principal ;
- abstraction multi-provider.

### Voix
- transcription locale si viable.

### Vidéo
- FFmpeg.

### Stockage
- fichiers locaux au départ ;
- abstraction vers object storage plus tard.

### Jobs
- système asynchrone.

### News
- RSS ;
- APIs ;
- sources web structurées.

### Publication
- APIs officielles des plateformes lorsque disponibles ;
- fallback brouillons locaux/manuels.

Claude doit challenger ces choix.

Ne les accepte pas automatiquement.

Pour chaque technologie, expliquer :

- pourquoi ;
- alternatives ;
- avantages ;
- inconvénients ;
- coût ;
- complexité ;
- maintenabilité ;
- compatibilité avec le PC local ;
- compatibilité future cloud.

---

# 39. Contraintes matérielles

Le développement et une partie du fonctionnement local auront lieu sur un ordinateur relativement modeste.

Il faut éviter :

- grosses architectures Kubernetes ;
- services inutilement lourds ;
- multiples containers permanents si non nécessaires ;
- modèles locaux trop lourds ;
- traitement vidéo très gourmand sans justification.

L’application doit rester fluide et pragmatique.

---

# 40. Local, cloud ou hybride

Claude doit classifier chaque composant :

- local ;
- cloud ;
- hybride.

Exemples à évaluer :

- frontend ;
- backend ;
- DB ;
- transcription ;
- orchestration ;
- montage ;
- stockage ;
- scheduler ;
- publication ;
- analytics ;
- veille ;
- LLM.

L’objectif final pourrait devenir cloud, mais l’utilisateur doit pouvoir commencer localement.

---

# 41. Architecture extensible

Le système doit pouvoir accueillir plus tard :

- nouvelles plateformes ;
- nouveaux fournisseurs IA ;
- nouveaux formats ;
- plusieurs comptes ;
- plusieurs langues ;
- plusieurs utilisateurs ;
- nouveaux outils vidéo ;
- nouvelles sources de news ;
- nouveaux analytics.

Mais sans surengineering prématuré.

---

# 42. Observabilité

Prévoir :

- logs ;
- erreurs ;
- traces ;
- coûts ;
- durée des jobs ;
- appels LLM ;
- appels API ;
- retries ;
- statut des publications.

Créer une interface permettant de comprendre rapidement pourquoi une opération a échoué.

---

# 43. Tests

Claude doit proposer une vraie stratégie.

Inclure :

- unitaires ;
- intégration ;
- e2e ;
- tests agents ;
- tests outputs structurés ;
- mocks API ;
- tests connecteurs ;
- tests queue ;
- tests retries ;
- tests coûts ;
- tests sécurité ;
- tests uploads ;
- tests DB ;
- tests migration ;
- tests publication idempotente.

Pour les prompts/agents :

prévoir des fixtures et cas de référence.

---

# 44. Structure du repository

Préférence pour un monorepo TypeScript.

Claude doit proposer une structure claire.

Exemple seulement :

```text
apps/
  web/
  api/
  worker/

packages/
  ai/
  database/
  shared/
  media/
  publishing/
  analytics/
  news/
  queue/
  config/
```

Mais Claude doit choisir la meilleure structure et justifier son choix.

---

# 45. Phases de développement

Claude doit construire le plan du produit complet puis fournir un ordre de développement.

Chaque phase doit contenir :

- objectif ;
- fonctionnalités ;
- modules ;
- dépendances ;
- critères de sortie ;
- tests ;
- risques ;
- estimation de complexité ;
- ce qu’il ne faut pas encore construire.

Exemple de logique possible :

```text
Phase 0 — fondations
Phase 1 — conversation + mémoire
Phase 2 — génération éditoriale
Phase 3 — médias
Phase 4 — calendrier
Phase 5 — publication
Phase 6 — news
Phase 7 — analytics
Phase 8 — optimisation
Phase 9 — cloud
```

Ce n’est qu’un exemple.

Claude doit déterminer le meilleur découpage.

---

# 46. Priorité absolue

Ne pas commencer à coder avant d’avoir :

1. architecture ;
2. modèle de données ;
3. flux ;
4. responsabilités ;
5. interfaces critiques ;
6. phases ;
7. risques ;
8. décisions techniques.

---

# 47. Ce que Claude doit éviter

Ne pas :

- générer directement des centaines de fichiers ;
- écrire toute l’application ;
- choisir 25 frameworks inutiles ;
- concevoir une architecture enterprise disproportionnée ;
- ajouter Kubernetes sans justification ;
- multiplier les microservices ;
- multiplier les agents IA uniquement parce que cela semble moderne ;
- envoyer tout le contexte à chaque agent ;
- créer une dépendance forte à un seul fournisseur ;
- ignorer les coûts ;
- ignorer les limitations API ;
- ignorer le fallback manuel ;
- ignorer la reprise après erreur ;
- ignorer la validation humaine.

---

# 48. Questions auxquelles Claude doit répondre

À la fin de son analyse, Claude doit répondre explicitement à ces questions :

1. Quelle architecture générale recommandes-tu ?
2. Monolithe modulaire, services ou autre ?
3. Pourquoi ?
4. Quelles parties doivent être locales ?
5. Quelles parties doivent être cloud ?
6. Quelles parties doivent être hybrides ?
7. React + Node + TypeScript est-il un bon choix ici ?
8. SQLite suffit-il au départ ?
9. Comment migrer proprement vers PostgreSQL ?
10. Comment structurer l’orchestrateur IA ?
11. Combien d’agents distincts sont réellement utiles ?
12. Comment réduire les tokens ?
13. Comment gérer la mémoire ?
14. Faut-il embeddings/RAG ?
15. Si oui, pour quoi exactement ?
16. Quel système de transcription locale utiliser ?
17. Comment traiter les vidéos sans services chers ?
18. Comment gérer FFmpeg proprement ?
19. Quelle queue utiliser ?
20. Comment faire fonctionner la queue localement puis dans le cloud ?
21. Comment stocker les médias ?
22. Comment gérer les OAuth ?
23. Comment isoler les connecteurs de plateforme ?
24. Comment garantir l’idempotence de la publication ?
25. Comment gérer les limitations de chaque API ?
26. Comment organiser le calendrier ?
27. Comment récupérer les analytics ?
28. Comment intégrer les news à très faible coût ?
29. Comment éviter les hallucinations ?
30. Comment tracer le coût de chaque appel IA ?
31. Quelle stratégie de tests adopter ?
32. Quelle structure de monorepo utiliser ?
33. Quel ordre de développement maximise les chances de finir le produit ?
34. Quels composants sont probablement inutiles au départ ?
35. Quels sont les trois plus gros risques techniques ?
36. Quels sont les trois plus gros risques produit ?
37. Quelles décisions sont facilement réversibles ?
38. Quelles décisions seront coûteuses à changer plus tard ?

---

# 49. Format attendu de la réponse de Claude

Produis ta réponse avec cette structure exacte :

## A. Résumé exécutif

Décris le produit et ta recommandation générale.

## B. Hypothèses et inconnues

Sépare clairement :

- faits ;
- hypothèses ;
- inconnues ;
- points à vérifier.

## C. Architecture globale

Inclure un diagramme Mermaid.

## D. Composants

Pour chaque composant :

- rôle ;
- entrées ;
- sorties ;
- dépendances ;
- stockage ;
- erreurs possibles.

## E. Architecture IA

Inclure :

- orchestrateur ;
- agents ;
- modèles ;
- mémoire ;
- contexte ;
- prompts ;
- outputs structurés ;
- gestion coûts.

## F. Modèle de données

Tables/collections principales + relations.

Inclure un diagramme ER Mermaid.

## G. Pipeline conversation

Du vocal/texte jusqu’à la fiche maître.

## H. Pipeline éditorial

De la fiche maître jusqu’aux variantes plateforme.

## I. Pipeline médias

Images, audio, vidéo, FFmpeg.

## J. Pipeline news

Sources → filtre → ranking → validation.

## K. Pipeline publication

Validation → API → fallback → statut.

## L. Pipeline analytics

Récupération → normalisation → analyse.

## M. Sécurité

Secrets, OAuth, fichiers, APIs, permissions.

## N. Gestion des coûts

LLM, médias, stockage et APIs.

## O. Observabilité et erreurs

Logs, retry, idempotence, reprise.

## P. Stack recommandée

Tableau :

| Composant | Technologie | Pourquoi | Alternative | Risque |

## Q. Structure du monorepo

Arborescence proposée.

## R. Plan complet de développement

Phases ordonnées.

Pour chaque phase :

- objectif ;
- livrables ;
- dépendances ;
- critères d’acceptation ;
- tests ;
- risques ;
- complexité.

## S. Ce qui doit attendre

Liste explicite de ce qu’il ne faut pas construire trop tôt.

## T. Risques majeurs

Techniques, coûts, APIs, produit.

## U. Décisions à prendre avant le code

Liste finale des décisions nécessaires.

---

# 50. Règle finale

Le but de ton travail est de produire **un plan suffisamment précis pour qu’un autre agent de développement puisse ensuite construire l’application phase par phase sans devoir réinventer son architecture**.

Mais ne tombe pas dans le surengineering.

La priorité est :

> architecture claire + coûts contrôlés + fonctionnement fiable + évolutivité raisonnable + contrôle humain.

Ne code pas encore l’application.

Commence par comprendre complètement le produit, identifier les zones ambiguës et produire l’architecture complète.
