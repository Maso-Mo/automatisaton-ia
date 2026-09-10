# 06 — Connecteurs et publication

> Répond aux sections 12, 20, 21 et aux questions 25, 27, 28, 35 du
> [cahier des charges](00-cahier-des-charges.md). S'appuie sur
> [`03-modele-de-donnees.md`](03-modele-de-donnees.md) §11 (tables de publication) et
> [`05-pipelines.md`](05-pipelines.md) §8 (pipeline de publication).

---

> ## ⚠️ Avertissement de lecture
>
> **Ce document contient des informations dont la véracité dépend du monde extérieur** :
> quotas d'API, politiques de contenu, conditions d'utilisation, formats acceptés, coûts des
> API payantes. Toutes les informations de cette nature sont marquées `⚠️ À VÉRIFIER`.
>
> Elles étaient vraies au moment de la rédaction, **elles ne le seront probablement plus au
> moment de l'implémentation**. Le cahier des charges le demande explicitement : ces contraintes
> doivent être recontrôlées avant d'écrire le connecteur correspondant, pas supposées.
>
> **Ce qui ne change pas** : l'architecture (contrat, niveaux A/B/C, idempotence, gestion de
> l'ambiguïté). C'est la partie de ce document qui a de la valeur durable.

---

## 1. Principes

| # | Principe | Conséquence |
|---|---|---|
| 1 | **Un connecteur par plateforme, derrière un contrat unique** | Aucune plateforme n'entre dans le domaine : `packages/core` ne connaît que `PlatformConnector` |
| 2 | **Trois niveaux de publication, jamais un seul** | Une plateforme qui refuse l'automatisation ne bloque pas le produit (niveau C) |
| 3 | **Validation avant envoi, pas après** | Une erreur de format détectée localement ne coûte rien et ne consomme pas de quota |
| 4 | **`ambiguous` est un résultat de première classe** | On ne devine jamais si une publication est passée |
| 5 | **Aucun jeton dans un log, une requête journalisée ou un prompt** | `redactSecrets()` appliqué par le client HTTP, pas par le connecteur |
| 6 | **Une limite de débit se respecte, elle ne se contourne pas** | Pas de rotation de comptes, pas de ruse de client. `rate_limit_reset_at` est respecté |
| 7 | **Ce que la plateforme permet est une donnée, pas une croyance** | `capabilities_json` est copié au moment de la connexion et comparé à la réalité |
| 8 | **Le repli manuel est toujours disponible** | Même quand tout fonctionne, l'utilisateur peut toujours copier-coller |

### 1.1 Pourquoi le principe 3 (valider avant d'envoyer) est structurant

Un POST refusé pour cause de format coûte : un tour de réseau, un quota, une tentative comptée,
une entrée d'erreur dans l'historique, et souvent une attente de 5 minutes. La même vérification
faite localement coûte **zéro**. Toutes les contraintes connues de la plateforme (longueur du
titre, du corps, nombre de hashtags, taille du fichier, format vidéo) sont donc vérifiées **en
amont**, dans `validateContent()`, et affichées dans l'interface d'édition.

**Conséquence produit** : l'éditeur doit **empêcher** la saisie invalide, pas prévenir après
coup. Un compteur de caractères qui vire au rouge à 3 000 signes sur LinkedIn vaut mieux qu'un
rejet d'API découvert dix minutes plus tard.

---

## 2. Matrice des capacités

> ⚠️ **À VÉRIFIER intégralement** avant l'implémentation de chaque connecteur. Pour chaque
> cellule, vérifier la documentation officielle **du jour** et la consigner dans le connecteur
> (avec la date de vérification en commentaire).

| Capacité | LinkedIn | Reddit | TikTok | YouTube |
|---|---|---|---|---|
| Publication directe (texte) | oui ⚠️ | oui ⚠️ | non (vidéo seule) | non (vidéo seule) |
| Brouillon distant | oui ⚠️ | non | non | oui ⚠️ (privé) |
| Publication vidéo | oui ⚠️ | non | oui ⚠️ | oui ⚠️ |
| Publication image | oui ⚠️ | oui ⚠️ (via lien ou upload) | non | non |
| Planification côté plateforme | limitée ⚠️ | non | oui ⚠️ | oui ⚠️ |
| Métriques via API | oui ⚠️ (portée restreinte) | limitée ⚠️ | oui ⚠️ | oui ⚠️ |
| Clé d'idempotence supportée | à vérifier ⚠️ | non | à vérifier ⚠️ | à vérifier ⚠️ |
| Revue côté plateforme | non | modération a posteriori ⚠️ | oui ⚠️ | non |
| OAuth | oui | oui | oui | oui |

**Niveau de publication retenu en V1 pour chaque plateforme** :

| Plateforme | Niveau V1 | Justification |
|---|---|---|
| LinkedIn | **A** (avec repli B) | API la plus ouverte des quatre pour un usage personnel |
| YouTube | **B** (brouillon/privé) puis publication manuelle | L'upload vidéo via API est possible mais la publication publique doit rester une décision humaine |
| Reddit | **C** (paquet local) | Les règles d'auto-promotion sont strictes et variables selon les subreddits ; l'automatisation est un risque de bannissement |
| TikTok | **C** (paquet local + fichier vidéo) | Accès API restreint, contenu automatisé souvent pénalisé ⚠️ |

**Ce tableau est un choix de prudence, pas un aveu d'échec.** Le niveau C garantit que le
produit fonctionne **entièrement** dès la V1, sans dépendre d'un accès API qu'on n'a pas encore.

---

## 3. Le contrat, au-delà de l'interface

L'interface `PlatformConnector` est définie dans
[`02-architecture.md`](02-architecture.md) §9.2. Cette section précise **les obligations
comportementales** que chaque implémentation doit respecter — c'est ce qui rend l'abstraction
utilisable plutôt que décorative.

### 3.1 Obligations de comportement

| Obligation | Détail |
|---|---|
| **`validateContent()` vérifie localement les règles connues** | Longueurs, types MIME, tailles, nombre de hashtags : tout est vérifié depuis `capabilities_json`, sans appel réseau |
| **`publish()` est idempotent de son point de vue** | Le connecteur vérifie d'abord l'état distant si un identifiant existe déjà |
| **`publish()` ne lève jamais d'exception pour un échec métier** | Un refus de la plateforme est un `PublishResult`, pas une exception. Les exceptions sont réservées aux bugs |
| **Toute réponse brute est conservée** | `response_json` dans `publication_attempts`, avec les jetons rédigés |
| **`fetchMetrics()` ne renvoie que des métriques réellement mesurées** | Aucune estimation silencieuse. Une métrique indisponible est absente, pas à 0 |
| **`buildManualPackage()` fonctionne toujours** | Même si le connecteur sait publier, le repli manuel est implémenté |

### 3.2 Le rapport de validation

```ts
export interface ValidationReport {
  ok: boolean;
  issues: {
    field: 'title' | 'body' | 'hashtags' | 'media' | 'cta' | 'other';
    severity: 'blocking' | 'warning';
    message: string;          // message destiné à l'utilisateur, pas un code
    limit?: number;           // ex. 3000
    actual?: number;          // ex. 3412
  }[];
  warnings: string[];         // ex. « r/… exige un flair »
}
```

**`message` est écrit pour l'utilisateur, en français, avec les chiffres.** « Le texte fait
3 412 caractères ; la limite est 3 000 » est exploitable. « VALIDATION_FAILED: body.too_long »
ne l'est pas.

### 3.3 Le client HTTP partagé

Tous les connecteurs passent par un client commun (`packages/publishing/http-client.ts`) qui
assure :

| Service | Détail |
|---|---|
| Rédaction des secrets | `redactSecrets()` sur toute requête et réponse journalisée |
| Timeouts explicites | 30 s pour un POST de publication, 10 s pour un GET |
| Retry contrôlé | 5xx et erreurs réseau uniquement, backoff exponentiel + jitter, **jamais** sur un POST non idempotent sans clé |
| Lecture de `Retry-After` | Alimente directement `rate_limit_reset_at` |
| Détection d'ambiguïté | Timeout ou réponse illisible **après** envoi → `outcome: 'ambiguous'`, pas d'exception |
| Corrélation | `request_id` local ajouté à chaque appel, présent dans les logs et la table des tentatives |

**La détection d'ambiguïté est le point technique le plus délicat de tout le produit.** La règle
est simple à énoncer : *si on ne peut pas prouver que l'action a échoué avant d'être envoyée, on
ne rejoue pas*. C'est l'inverse du réflexe habituel (« ça a échoué, je réessaie »).

---

## 4. LinkedIn

> ⚠️ **Tout ce chapitre doit être revérifié** : politique d'accès à l'API, portées OAuth,
> quotas, longueurs maximales, règles d'authenticité du contenu.

### 4.1 Ce que le produit prépare (niveau A, avec repli B)

| Élément | Contrainte cible ⚠️ |
|---|---|
| Hook | Première ligne visible avant « voir plus » : elle doit tenir seule |
| Corps | Longueur maximale à vérifier (de l'ordre de 3 000 caractères) ⚠️ |
| Hashtags | 3 à 5, en fin de post, jamais en début |
| Média | 1 image ou 1 vidéo, jamais plus |
| CTA | Optionnel et non commercial : une question ou une invitation à partager une expérience |

### 4.2 Contraintes éditoriales (pas seulement techniques)

Le prompt LinkedIn (cf. [`04-orchestrateur-et-agents-ia.md`](04-orchestrateur-et-agents-ia.md) §4.3)
interdit explicitement :

- le faux storytelling (« J'ai failli tout arrêter… ») qui n'est pas advenu ;
- la fausse expertise (affirmer une maîtrise que `project_skill_facts` ne contient pas) ;
- les listes creuses de conseils génériques que personne n'applique ;
- les crochets d'accroche trompeurs (« Ce secret va changer votre carrière »).

**Pourquoi ces interdits sont dans le prompt et pas seulement dans le critique** : le `critic`
les vérifie, mais l'écrivain doit les connaître. Un modèle qui ne sait pas ce qui est interdit le
produit quand même — et on paie ensuite une régénération.

### 4.3 Portée et cycle de vie du jeton

```text
1. OAuth 2.0 (code d'autorisation) — le secret client n'est jamais exposé au navigateur
2. Portées demandées : profil de base + publication     ⚠️ (à confirmer selon le produit voulu)
3. access_token (courte durée) + refresh_token (longue durée), chiffrés en base
4. Rafraîchissement AVANT expiration (fenêtre de 24 h), jamais en réaction à une erreur 401
5. Un rafraîchissement échoué → connection_state='expired' + notification, aucun retry en boucle
```

**On rafraîchit avant l'expiration, pas après l'échec.** Rafraîchir à la première erreur 401
signifie que la publication en cours échoue — souvent au pire moment, et cela produit un
`ambiguous` si la requête était un POST.

---

## 5. Reddit

> ⚠️ **Tout ce chapitre doit être revérifié** : politique d'API, règles d'auto-promotion,
> exigences sur l'âge du compte et le karma, quotas par OAuth.

### 5.1 Décision V1 : niveau C (paquet local)

**Pourquoi pas la publication automatique en V1**, bien que l'API existe :

| Risque | Détail |
|---|---|
| Bannissement | Reddit sanctionne lourdement la promotion automatisée non déclarée ; un bannissement de compte est irréversible et coûte cher à l'utilisateur |
| Règles par subreddit | Chaque subreddit a ses propres règles (auto-promotion, liens, format de titre, flair obligatoire). Aucune API ne les expose de façon fiable ⚠️ |
| Culture de la plateforme | Un texte qui « sent » la promotion est rejeté par les lecteurs avant tout modérateur |
| Ratio d'auto-promotion | Les règles communautaires exigent en général une majorité de contributions non promotionnelles ⚠️ (valeur exacte variable, à vérifier) |

### 5.2 Ce que le produit prépare

Le paquet Reddit (niveau C) contient :

| Élément | Détail |
|---|---|
| Subreddit choisi | **Sélectionné par l'utilisateur.** Le produit ne propose jamais un subreddit à sa place |
| Titre | Format non promotionnel : question ou affirmation factuelle |
| Corps | Texte utile, transparent sur le fait que l'auteur travaille sur le sujet |
| Flair | Champ **à renseigner par l'utilisateur** : non devinable depuis le contenu |
| Liens | Marqués explicitement comme autorisés ou non, sans jugement automatique |
| Avertissement | « Ce post mentionne votre projet : vérifiez la règle d'auto-promotion du subreddit » |

**Proposer un subreddit** sur la base d'une similarité lexicale serait une erreur fréquente et
coûteuse en réputation. Le produit peut **lister** les subreddits déjà utilisés par le projet,
jamais en inventer un nouveau.

### 5.3 Le `critic` a des règles Reddit dédiées

`prompts/critic/rules-reddit.md` (cf. [`04-orchestrateur-et-agents-ia.md`](04-orchestrateur-et-agents-ia.md) §4.4) impose un
verdict plus sévère sur Reddit que sur les autres plateformes :

| Signal détecté | Verdict |
|---|---|
| Ton trop commercial ou « je vous présente mon produit » | `revise` |
| Absence d'apport utile hors promotion | `reject` |
| Titre qui promet un résultat non étayé | `revise` + claim marqué |
| Mention de lien externe vers un contenu propre | `revise` + avertissement explicite |

**Pourquoi une sévérité asymétrique** : le coût d'un mauvais post Reddit n'est pas un mauvais
post, c'est un compte signalé. Sur LinkedIn, un post médiocre est oublié ; sur Reddit, il peut
fermer la plateforme à l'utilisateur.

---

## 6. TikTok

> ⚠️ **Tout ce chapitre doit être revérifié** : existence et conditions d'accès à l'API de
> publication, traitement du contenu généré par IA, politiques de sous-titres automatiques.

### 6.1 Décision V1 : niveau C (paquet local)

| Contrainte | Détail |
|---|---|
| Accès API | L'accès à la publication est restreint et soumis à validation ⚠️ ; on ne construit pas un produit qui en dépend |
| Contenu automatisé | Les plateformes de vidéo courte pénalisent ou étiquettent le contenu manifestement automatisé ⚠️ (politique variable) |
| Nature du contenu | Une vidéo générée sans intention humaine visible a peu de chances de performer ; le produit doit aider à publier **le contenu de l'utilisateur**, pas à en fabriquer un faux |

### 6.2 Ce que le produit prépare

| Élément | Détail |
|---|---|
| Hook | Les 2 premières secondes : phrase dite **et** texte affiché |
| Script | Découpé en segments avec durée cible et indication de ce qui est montré |
| Sous-titres | Fichier `.srt` généré depuis la transcription (cf. [`05-pipelines.md`](05-pipelines.md) §5) |
| Vidéo | Fichier vertical 9:16 rendu par FFmpeg (cf. [`05-pipelines.md`](05-pipelines.md) §6) |
| Description | Courte, avec 3 à 5 hashtags |
| CTA | Un seul, à la fin, non commercial |

**Le produit ne génère jamais de voix de synthèse en V1.** Le script est destiné à être dit par
l'utilisateur. C'est une limite assumée : une voix synthétique sur TikTok est immédiatement
identifiable et dégrade la perception du contenu.

### 6.3 Le sous-titre est un livrable, pas un détail

Le fichier `.srt` produit depuis la transcription est éditable dans l'interface. Il est nécessaire
pour TikTok (où la majorité des visionnages se fait sans son) et pour l'accessibilité.

**Corriger un sous-titre coûte 2 minutes ; régénérer une vidéo pour un sous-titre fautif, 40.**

---

## 7. YouTube

> ⚠️ **Tout ce chapitre doit être revérifié** : quota quotidien d'upload, statut initial des
> vidéos envoyées par API, formats et codecs acceptés, champs obligatoires.
>
> Le quota d'upload par API est **la contrainte structurante** de ce connecteur : il limite le
> nombre de vidéos envoyées par jour, indépendamment de tout le reste. À vérifier **avant** de
> promettre « deux vidéos longues par semaine » (cf. cahier des charges §12).

### 7.1 Décision V1 : niveau B (brouillon distant)

| Étape | Comportement |
|---|---|
| Envoi | La vidéo est envoyée par API **en visibilité privée ou non répertoriée** |
| Titre, description, tags, miniature | Envoyés avec la vidéo |
| Chapitres | Envoyés dans la description (format horodaté) |
| Sous-titres | Envoyés comme piste de sous-titres si le format est accepté ⚠️ |
| Publication publique | **Jamais automatique.** L'utilisateur ouvre YouTube Studio et publie |

**Pourquoi le niveau B et pas A** : une vidéo longue est un objet engageant, coûteux à produire,
dont la publication publique est un acte éditorial. Envoyer puis laisser l'utilisateur appuyer sur
« Publier » conserve la décision là où elle doit être.

### 7.2 Deux formats, deux pipelines

| | Shorts | Vidéo longue |
|---|---|---|
| Durée cible | < 60 s ⚠️ (seuil à revérifier) | 5–15 min |
| Format | Vertical 9:16 | Horizontal 16:9 |
| Pipeline | [`05-pipelines.md`](05-pipelines.md) §6 | [`05-pipelines.md`](05-pipelines.md) §6 |
| Chapitres | Non pertinents | Obligatoires à partir de 3 sections (lisibilité) |
| Production | Automatisable de bout en bout depuis la transcription | Le plan de montage est proposé, l'exécution reste principalement manuelle en V1 |

**La vidéo longue est le seul pipeline dont le rendu automatique n'est pas visé en V1.** Le
produit prépare le plan (séquences écran, démonstrations, B-roll), les chapitres, la description
et la miniature — mais le montage final reste humain. C'est honnête : un montage long automatisé
sur la base d'une transcription donne un résultat médiocre, et le temps gagné est perdu à corriger.

---

## 8. Le niveau C : le paquet manuel

> Table : `manual_packages` (cf. [`03-modele-de-donnees.md`](03-modele-de-donnees.md) §11.4).
> Détail du pipeline : [`05-pipelines.md`](05-pipelines.md) §8.3.

### 8.1 Le critère de réussite

**Publier à la main depuis un paquet doit prendre moins de 60 secondes.** C'est le seul critère
qui compte. Un paquet qui exige de recopier trois paragraphes depuis l'interface ne vaut rien.

### 8.2 Contenu du paquet

| Élément | Forme | Usage |
|---|---|---|
| Texte final | Fichier `.md` + bouton « copier » | Collage direct |
| Titre | Bouton « copier » séparé | Champs distincts sur les plateformes |
| Hashtags | Bouton « copier » séparé | Format variable selon la plateforme |
| Média principal | Fichier à son chemin final, bouton « ouvrir le dossier » | Upload manuel |
| Miniature | Fichier image, format cible | YouTube |
| Sous-titres | Fichier `.srt` | TikTok, YouTube |
| Checklist | Liste à cocher | Flair Reddit, règles du subreddit, relecture |
| Lien direct | Lien vers le formulaire de création de la plateforme | Gagner 30 secondes |

### 8.3 Ce qui rend un paquet bon ou mauvais

| Bon paquet | Mauvais paquet |
|---|---|
| Les fichiers sont nommés `linkedin-2026-03-14-titre.md` | `output.txt` |
| Le bouton « copier » copie **exactement** ce qui doit être collé | Le bouton copie le markdown avec ses `**` |
| La checklist rappelle le flair et les règles | Une checklist générique de trois lignes |
| Le média est déjà au bon format et à la bonne durée | Un fichier source qu'il faut réencoder manuellement |
| La création du paquet est journalisée et retrouvable | Le paquet existe dans un dossier temporaire |

**Le paquet est un artefact persistant**, pas un écran. Il est stocké, listé, réutilisable, et il
reste consultable après publication — ce qui permet de savoir ce qui a été publié à la main.

### 8.4 Le paquet est toujours disponible, même en niveau A

Même quand la publication automatique fonctionne, l'utilisateur peut demander le paquet manuel.
Trois cas d'usage réels :

1. **La plateforme est en panne** — le paquet permet de publier quand même.
2. **L'utilisateur veut modifier avant de publier** — corriger sur la plateforme est plus rapide que
   de relancer un cycle de régénération.
3. **L'utilisateur veut publier depuis son téléphone** — ce qui est le cas normal pour TikTok.

---

## 9. Erreurs, quotas et idempotence

### 9.1 Table des erreurs et de la réaction attendue

| Erreur | `outcome` | Réaction automatique | Verdict |
|---|---|---|---|
| 400 / champ invalide | `rejected_by_platform` | **Aucune** | Bug de validation locale à corriger ; le cas est remonté au tableau de bord |
| 401 / jeton refusé | `auth_error` | 1 rafraîchissement, puis `connection_state='expired'` | Pas de retry en boucle |
| 403 / portée insuffisante | `auth_error` | Aucune | Configuration à refaire par l'utilisateur |
| 429 / limite de débit | `rate_limited` | Report à `rate_limit_reset_at` | Réessayer honnêtement, plus tard |
| 5xx | `server_error` | 3 tentatives, backoff | Erreur de la plateforme, pas la nôtre |
| Timeout **avant** envoi | `timeout` | 1 tentative | Sans risque : rien n'est parti |
| Timeout **après** envoi | **`ambiguous`** | **Aucune** | Décision humaine obligatoire |
| Réponse illisible / HTML d'erreur | **`ambiguous`** | **Aucune** | On ne sait pas si c'est passé |
| Refus explicite de la plateforme | `rejected_by_platform` | Aucune | Message à l'utilisateur, pas une erreur technique |

**La distinction « timeout avant / après envoi » est implémentée, pas supposée.** Le client HTTP
enregistre l'horodatage du dernier octet du corps de requête envoyé ; si le timeout survient après,
l'appel est ambigu. C'est la seule façon de ne pas confondre « rien n'est parti » et « peut-être
parti ».

### 9.2 Idempotence, plateforme par plateforme

| Plateforme | Clé transmise ? | Vérification après échec | Repli |
|---|---|---|---|
| LinkedIn | à vérifier ⚠️ | Recherche des posts récents du compte, comparaison de contenu | Décision humaine |
| YouTube | à vérifier ⚠️ | Recherche dans les vidéos de la chaîne, dans l'ordre antéchronologique | Décision humaine |
| Reddit | non | Sans objet (niveau C) | — |
| TikTok | non | Sans objet (niveau C) | — |

**Quand la clé ne peut pas être transmise, elle sert localement** : elle alimente la vérification
et le journal. Cela ne supprime pas la fenêtre d'ambiguïté, cela la réduit et la rend traitable.

### 9.3 Ce que le produit ne fait jamais pour « rattraper » un échec

| Ruse | Pourquoi jamais |
|---|---|
| Rejouer un POST ambigu « pour voir » | Doublon public, non supprimable proprement |
| Créer un second compte pour contourner une limite | Violation explicite des conditions d'utilisation |
| Réessayer immédiatement après un 429 | Aggrave la sanction, souvent jusqu'au blocage durable ⚠️ |
| Modifier le contenu pour passer un filtre | Contourne une décision de la plateforme |
| Publier sur une autre plateforme « à la place » | L'utilisateur a approuvé une cible précise |

**Chaque ligne de ce tableau est une décision produit, pas une limite technique.** Toutes sont
faisables ; aucune n'est acceptable.

---

## 10. Comptes et jetons, du point de vue du connecteur

> Le chiffrement, le stockage et la gestion des secrets sont traités dans
> [`07-securite-secrets-auth.md`](07-securite-secrets-auth.md). Ici : **ce que le connecteur
> attend** et **ce qu'il ne doit jamais faire**.

### 10.1 Cycle de vie d'un compte

```text
disconnected ──connecter──▶ connected ──expiration──▶ expired ──reconnecter──▶ connected
                               │                        │
                               ├──révocation──▶ revoked │
                               └──429 répété──▶ rate_limited ──attente──▶ connected
```

| État | Signification pour le pipeline de publication |
|---|---|
| `connected` | Publication possible |
| `expired` | Publication **bloquée** ; rafraîchissement automatique tenté une fois, sinon notification |
| `revoked` | Publication bloquée ; l'utilisateur doit refaire le parcours OAuth |
| `rate_limited` | Publication **reportée** à `rate_limit_reset_at`, pas annulée |
| `disconnected` | Compte configuré mais jamais utilisé ou volontairement déconnecté |

**`rate_limited` reporte, il n'annule pas.** Une publication planifiée pendant une fenêtre bloquée
change d'heure ; elle ne devient pas un échec. C'est visible dans l'interface (« reportée à 14 h
32 — limite de la plateforme ») et cela évite à l'utilisateur de croire à une perte de contenu.

### 10.2 Les quatre règles du connecteur vis-à-vis des jetons

| Règle | Raison |
|---|---|
| **Le connecteur ne stocke rien lui-même** | Il reçoit un jeton déchiffré, l'utilise, le rend. Aucune copie dans un module, un cache ou une closure persistante |
| **Le jeton n'entre jamais dans un log, même en debug** | `redactSecrets()` est appliqué par le client HTTP, pas par appelant — un appelant peut oublier |
| **Le jeton n'est jamais envoyé à un LLM** | Aucun prompt ne contient de jeton ; aucune trace d'appel LLM ne peut en contenir |
| **Un rafraîchissement est sérialisé par compte** | Deux rafraîchissements simultanés sur le même compte avec un `refresh_token` rotatif invalident le compte ⚠️ |

**La quatrième règle est un piège classique** : deux jobs qui rafraîchissent le même compte en
parallèle, et le second jeton révoque le premier. Un verrou par `platform_account_id` suffit.

### 10.3 Test de connexion obligatoire

`authenticate()` est appelé au moment de la connexion **et** périodiquement. Le test doit appeler
une ressource réelle et non un point de santé :

| Ce qui est testé | Ce qui n'est pas un test valable |
|---|---|
| Lecture du profil du compte lui-même | Un `GET /me` qui ne renvoie qu'un identifiant sans vérifier les portées |
| Présence des portées nécessaires à la publication | Le succès d'un échange de code OAuth |
| Capacités réelles, comparées à `capabilities_json` | Un appel qui ne fait qu'échanger un jeton |

**Un compte qui se « connecte » mais ne peut pas publier est le pire état possible** : l'utilisateur
croit que tout va bien jusqu'à la première publication planifiée. C'est pour cela que
`capabilities_json` est copié **au moment de la connexion** et comparé ensuite.

---

## 11. Ajouter une plateforme plus tard

Le cahier des charges l'exige : « Le produit doit être conçu de manière extensible afin d'ajouter
d'autres plateformes plus tard » (§11). Voici la procédure exacte, et ce qu'elle coûte.

### 11.1 Les six points de contact

| # | Point de contact | Fichier | Effort |
|---|---|---|---|
| 1 | Nouveau `PlatformId` | `packages/core/platforms.ts` | 1 ligne |
| 2 | Implémentation du connecteur | `packages/publishing/{plateforme}/` | Le vrai travail |
| 3 | Capacités déclarées | `capabilities.ts` du connecteur | 15 min, après vérification ⚠️ |
| 4 | Contraintes de format | `validateContent()` | 1–2 h selon la plateforme |
| 5 | Prompt `platform_writer` pour cette plateforme | `packages/prompts/platforms/{plateforme}.md` | 1–2 h + réglages |
| 6 | Règles `critic` spécifiques | `packages/prompts/critic/rules-{plateforme}.md` | 1 h |

### 11.2 Ce qui ne change PAS

| Élément | Pourquoi |
|---|---|
| Le schéma de données | `platform_accounts`, `publications`, `publication_attempts`, `manual_packages` sont génériques |
| Le pipeline de publication | [`05-pipelines.md`](05-pipelines.md) §8 ne dépend d'aucune plateforme |
| Les niveaux A/B/C | Une nouvelle plateforme choisit simplement son niveau |
| Le paquet manuel | Il est produit pour toute plateforme |
| Les tableaux de bord | Alimentés par les mêmes tables |
| Les tests d'intégration | Écrits contre l'interface `PlatformConnector`, pas contre une plateforme |

**C'est le test réel de l'abstraction** : si ajouter une plateforme oblige à modifier le schéma ou
le pipeline, l'abstraction a échoué. Le contrôle est simple : `packages/core` ne doit contenir
**aucune** mention d'un nom de plateforme en dur, seulement le type `PlatformId`.

### 11.3 Le test qui garantit l'extensibilité

```ts
// Un connecteur factice implémente le contrat sans réseau : il doit suffire
// à faire tourner le pipeline de publication de bout en bout.
const fakeConnector: PlatformConnector = createFakeConnector('test_platform');
```

Si le pipeline de publication tourne de bout en bout avec un connecteur factice, l'abstraction tient.
Si un test exige un appel réseau réel, l'abstraction fuit. Ce test est obligatoire en CI
(cf. [`09-tests-et-qualite.md`](09-tests-et-qualite.md)).

---

## 12. Ce qu'il ne faut PAS construire (maintenant)

| Tentation | Pourquoi c'est refusé |
|---|---|
| **Un scraper / automatisation de navigateur** (Playwright en production) | Contourne les conditions d'utilisation, casse à chaque changement d'interface, et le compte de l'utilisateur est en jeu. Si une plateforme refuse l'API, la réponse est le niveau C |
| **Une publication « au mieux » sur toutes les plateformes à la fois** | L'utilisateur a approuvé une cible précise. Élargir silencieusement la diffusion est une trahison de la confiance |
| **Un point d'entrée HTTP public ou un webhook** | Impose un serveur exposé. Incompatible avec l'exécution locale, qui est une contrainte du cahier des charges |
| **La publication programmée côté plateforme comme mécanisme principal** | Chaque plateforme gère différemment la planification et les échecs ; le produit planifie **en local** et déclenche |
| **Un cache partagé des jetons entre comptes** | Un jeton par compte, point. Aucun raccourci |
| **La gestion de plusieurs comptes sur la même plateforme pour pondérer les postes** | Aucun besoin utilisateur, coût de gestion multiplié, et cela ressemble à du spam organisé |
| **La recherche automatique de subreddits, groupes ou communautés** | Erreur fréquente, coût en réputation réel (cf. §5.2) |
| **L'upload de vidéos de plus de 2 Go par API** | Les plateformes limitent, le PC modeste limite, le besoin n'existe pas. La vidéo longue passe par le niveau B ou C |
| **Un mode « auto-publish sans approbation »** | Invariant n°1 du produit, sans exception |
| **L'analyse de sentiment des commentaires de la plateforme** | Effet de mode, aucun signal exploitable démontré pour ce produit |

Passer en revue cette liste avant chaque nouvelle intégration évite de reconstruire, deux ans plus
tard, exactement ce que le cahier des charges interdit.

---

## 13. Synthèse

### 13.1 Les sept décisions de ce document

| # | Décision | Formulée |
|---|---|---|
| 1 | Un contrat unique `PlatformConnector`, aucune plateforme dans le domaine | §3 |
| 2 | Trois niveaux de publication (A/B/C), le niveau C toujours implémenté | §8 |
| 3 | Validation **avant** envoi, depuis `capabilities_json` | §3.1, §3.2 |
| 4 | Niveau V1 : LinkedIn A, YouTube B, Reddit C, TikTok C | §2 |
| 5 | `ambiguous` = décision humaine, jamais de rejeu | §3.3, §9.1 |
| 6 | La limite de débit reporte, elle n'annule pas | §10.1 |
| 7 | Ajouter une plateforme n'exige aucune modification du schéma ni du pipeline | §11 |

### 13.2 Ce que les connecteurs garantissent au produit

| Promesse | Mécanisme |
|---|---|
| « Le workflow n'est jamais bloqué parce qu'une plateforme refuse l'automatisation » | Niveau C disponible pour toutes les plateformes (§8) |
| « Je veux voir le contenu avant qu'il parte » | État `approved` + niveau B pour YouTube (§7.1) |
| « Je ne veux pas publier deux fois » | `uq_publication_version_account` + `idempotency_key` + `ambiguous` sans retry (§9) |
| « Dis-moi pourquoi ça a échoué » | `publication_attempts` avec requête et réponse rédigées (§9.1) |
| « Ne me fais pas bannir » | Reddit et TikTok en niveau C, aucun scraper, aucun contournement (§5, §6, §9.3) |
| « Ça doit marcher sur mon PC » | Aucun serveur public, aucun webhook, OAuth en local (§12) |
| « Je pourrai ajouter Mastodon plus tard » | Six points de contact, aucun changement du modèle de données (§11) |

### 13.3 Liste de vérification avant d'écrire un connecteur

À faire **avant** la première ligne de code, pour chaque plateforme, en cochant :

| # | À vérifier | Où le consigner |
|---|---|---|
| 1 | L'API de publication existe-t-elle encore et est-elle accessible à un particulier ? | En-tête du connecteur, avec la date ⚠️ |
| 2 | Quelles portées OAuth exactement, et comment les faire approuver ? | `capabilities.ts` + commentaire daté |
| 3 | Quels quotas (par jour, par heure) et quelle politique en cas de dépassement ? | Constante + `rate_limit_reset_at` |
| 4 | Longueurs maximales (titre, corps, description, nombre de hashtags) | `validateContent()` |
| 5 | Formats média acceptés (codecs, dimensions, durée, poids) | `validateContent()` |
| 6 | Une clé d'idempotence est-elle acceptée ? | Stratégie de vérification (§9.2) |
| 7 | Quel est le statut initial d'un contenu envoyé par API (public, privé, brouillon) ? | Niveau A ou B |
| 8 | Les conditions d'utilisation autorisent-elles l'automatisation de ce type de contenu ? | **Bloquant.** Si non → niveau C |
| 9 | Comment les erreurs sont-elles structurées (codes, messages) ? | Table de correspondance des erreurs |
| 10 | Peut-on récupérer des métriques, et lesquelles ? | `fetchMetrics()` + [`05-pipelines.md`](05-pipelines.md) §9 |

**Le point 8 est bloquant, pas consultatif.** Aucune fonctionnalité ne justifie d'enfreindre les
conditions d'utilisation d'une plateforme au nom de l'utilisateur : c'est son compte qui serait
suspendu, et sa responsabilité qui serait engagée.

### 13.4 Les invariants non négociables

1. Aucune publication sans version de contenu `approved` et gelée.
2. Aucun rejeu automatique d'un résultat ambigu.
3. Aucun jeton dans un log, un prompt ou une trace d'appel.
4. Aucun contournement d'une limite ou d'un refus de plateforme.
5. Le niveau C est implémenté pour **toutes** les plateformes, sans exception.
6. Une limite de débit reporte une publication, elle ne la fait jamais échouer.
7. `packages/core` ne connaît aucun nom de plateforme.

---

*Fin du document. Les quatre plateformes et leurs trois niveaux de publication sont spécifiés ;
l'isolation des secrets et l'authentification sont traitées dans
[`07-securite-secrets-auth.md`](07-securite-secrets-auth.md), et l'enchaînement réel des appels
dans [`05-pipelines.md`](05-pipelines.md) §8.*







