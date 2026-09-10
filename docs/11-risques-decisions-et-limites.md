# 11 — Risques, décisions et limites

> Répond aux sections **S** (« ce qui doit attendre »), **T** (« risques majeurs : techniques,
> coûts, APIs, produit ») et **U** (« décisions à prendre avant le code ») du
> [cahier des charges](00-cahier-des-charges.md), ainsi qu'aux questions **35 à 38** de sa
> section 48 (trois plus gros risques techniques, trois plus gros risques produit, décisions
> réversibles, décisions coûteuses).
>
> Ce document est le **registre** : il ne remplace aucun autre document, il rassemble ce qui est
> dispersé ailleurs — les décisions prises, celles qui restent ouvertes, les risques qui demeurent
> malgré tout, et ce que le produit **ne fera volontairement pas**.

---

## 1. Comment lire ce document

### 1.1 Le format d'une décision

Toute décision de ce projet est écrite selon le même format. Ce n'est pas un formalisme : une
décision dont on ne se rappelle pas les **options écartées** sera reprise trois mois plus tard, sans
mémoire des raisons, et probablement annulée à tort.

```text
Contexte   — pourquoi la question se pose (le fait, pas l'opinion)
Options    — ce qui a été envisagé, y compris l'option « ne rien faire »
Décision   — ce qui est retenu, en une phrase affirmative
Conséquences — ce que cela coûte, ce que cela interdit, ce qu'il faudra assumer ensuite
```

### 1.2 Les trois états d'une décision

| État | Où elle vit | Combien de temps elle est valable |
|---|---|---|
| **Prise** (verrouillée) | §2 de ce document, + le document qui la détaille | Jusqu'à ce qu'une décision de remplacement explicite la remplace |
| **Ouverte** | §3 (D1 à D6) | Jusqu'à l'étape du [plan](10-plan-de-developpement-12-etapes.md) qui la requiert |
| **Refusée** | §6 (« ce qui doit attendre ») | Jusqu'à sa condition de réexamen, écrite noir sur blanc |

**Une décision n'est jamais supprimée.** Une décision remplacée reste visible avec la mention
« remplacée par D-xxx ». C'est ce qui distingue un registre d'une liste de courses.

### 1.3 Les trois niveaux d'irréversibilité

C'est la distinction qui compte pour arbitrer vite : **ce qui coûte cher à changer mérite une
discussion, le reste ne mérite pas de débat.**

| Niveau | Coût du changement | Exemples | Règle appliquée |
|---|---|---|---|
| **Facile** — quelques heures | Réglage, configuration, prompt | Modèle LLM utilisé par un agent, seuils de scoring, textes des prompts, composants d'interface | On décide vite, on mesure, on ajuste. Aucune réunion |
| **Coûteux** — quelques jours | Migration avec données, refonte d'un contrat | Ajout d'une colonne sur une table peuplée, changement de format de journal, contrat `PlatformConnector` | On écrit la décision avant de coder, on teste la migration sur une base peuplée |
| **Très coûteux** — réécriture | Fondations | Le choix de `packages/core` sans infrastructure, la frontière du domaine, le modèle de données de la mémoire, l'absence de multi-utilisateur | On ne les change pas. On les **vérifie** (étape 12) |

---

## 2. Les décisions prises

Chaque ligne suit le format du §1.1, condensé en colonnes. Le détail technique est dans le document
cité, jamais ici : ce document garde la **décision**, l'autre garde la **spécification**.

### 2.1 Architecture, monorepo, portabilité

Source : [`02-architecture.md`](02-architecture.md) (§3, §5, §6, §7, §9, §14).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **Monolithe modulaire** : un déployable, `packages/core` comme seule couche qui décide | Un utilisateur, un disque, un poste. Le produit doit rester compréhensible par une personne | Microservices · architecture hexagonale complète avec 12 couches · services séparés par domaine | Un crash du worker ne doit pas casser l'interface → ils sont **deux processus**, mais un seul code |
| **Trois applications** : `web`, `api`, `worker` | L'interface ne doit pas dépendre de la durée d'un rendu vidéo | Un seul serveur qui fait tout · un serveur + un worker dans le même processus | Deux processus à lancer, deux journaux à lire — c'est le prix de l'isolation |
| **Un domaine qui ignore l'infrastructure** : `core` définit des ports, les paquets les implémentent | Le passage au cloud ne doit toucher aucune règle métier | Appeler directement Drizzle / FFmpeg / `fetch` depuis le domaine | Indirection supplémentaire (interfaces + implémentations) sur chaque accès externe |
| **TypeScript strict, un seul langage, `pnpm` workspaces** | Un seul développeur, un seul runtime à installer | Un backend Python (whisper) · Turborepo/Nx · npm/yarn workspaces | whisper et FFmpeg restent des **binaires appelés par `spawn`**, pas des services à maintenir |
| **SPA React + Vite, pas de SSR** | Application privée, aucun enjeu SEO | Next.js · Remix · HTML rendu côté serveur | Pas de partage d'URL publique, pas de préchargement — aucun besoin réel |
| **Local d'abord, cloud possible** | Le PC doit suffire ; l'utilisateur veut voir ses données chez lui | Cloud dès le départ · hybride base locale / calcul cloud | Sauvegardes à la charge de l'utilisateur ; le poste doit être allumé pour que la file tourne |
| **Pas de Docker en V1** | `pnpm dev` doit suffire | Docker Compose d'emblée · Kubernetes | Risque « ça marche chez moi » assumé : un seul environnement, c'est aussi ce qui le rend reproductible ; les conteneurs arrivent à l'étape 12 |

### 2.2 Modèle de données

Source : [`03-modele-de-donnees.md`](03-modele-de-donnees.md) (§1, §2, §17, §18).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **SQLite (better-sqlite3, WAL) + Drizzle ORM** | Zéro serveur à maintenir ; un fichier à sauvegarder | PostgreSQL d'emblée · Prisma · Kysely | SQLite écrit mal en concurrence → **un seul writer** (le worker) et `BEGIN IMMEDIATE` sur les réservations |
| **41 tables, 11 domaines, aucune table « au cas où »** | Chaque table doit avoir une fonctionnalité qui la lit | Schéma « complet » anticipant des besoins futurs | Une nouvelle fonctionnalité implique parfois une migration — assumé, testé sur base peuplée |
| **UUID v7 en `TEXT`, ms epoch en `INTEGER`, montants en `micro_usd` entier** | Le passage à PostgreSQL doit être un travail de dialecte, pas de logique | Flottants pour l'argent ou les dates · séquences auto-incrémentées | Un peu plus verbeux à lire dans la base ; exactitude garantie |
| **Aucune suppression physique sur les contenus et la mémoire** (`deleted_at`) | Un contenu supprimé peut être la seule trace d'une erreur | `DELETE` définitif | La base grossit ; la rétention s'applique par politique, jamais par un `DROP` |
| **Aucun `_json` sans schéma Zod** | Un JSON libre non validé est un bug silencieux | JSONB documenté en commentaire | Chaque colonne JSON coûte un schéma à maintenir |
| **Le garde-fou anti-hallucination est en base, pas dans le code applicatif** : `content_claims.risk='eleve'` non vérifié bloque l'approbation, via un déclencheur | Un garde-fou uniquement applicatif peut être contourné par un nouveau chemin de code | Contrôle dans la route API · contrôle dans l'agent | La contrainte gêne parfois (test à adapter), mais elle survit à tous les refactorings |

### 2.3 Orchestrateur, agents et prompts

Source : [`04-orchestrateur-et-agents-ia.md`](04-orchestrateur-et-agents-ia.md) (§1, §4, §6, §9, §12).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **L'orchestrateur est du code déterministe, jamais un LLM** | Un orchestrateur LLM rend le coût et le comportement imprévisibles | Un agent « chef d'orchestre » qui décide des appels · LangChain/LlamaIndex comme couche de contrôle | Chaque nouvelle route de pipeline s'écrit à la main — plus verbeux, mais débogable |
| **Huit agents, pas douze** | Un agent n'existe que si le **jugement** diffère, pas si le format de sortie diffère | Un agent par plateforme · un agent par étape du pipeline | `platform_writer` gère 5 plateformes en un appel ; ajouter une plateforme = un prompt, pas un agent |
| **`critic` et `fact_checker` toujours distincts de l'écrivain** | Un agent ne peut pas se vérifier lui-même | Un seul agent « écris et vérifie » | Un appel LLM supplémentaire par contenu — c'est le prix de la crédibilité |
| **`critic` interdit de réécrire, `analyst` interdit d'inventer des chiffres, `news_curator` interdit de découvrir** | Autoriser ces trois comportements revient à transformer un juge en auteur et un analyste en romancier | Laisser chaque agent « aider » au-delà de son rôle | Les verdicts sont parfois frustrants pour l'utilisateur ; les boucles restent bornées et lisibles |
| **Contexte minimal obligatoire, `MemoryPack` figé pendant un job** | Envoyer tout le contexte coûte cher et rend les résultats non comparables | Envoyer l'historique complet · un `MemoryPack` recalculé à chaque appel | Il faut **choisir** ce qui entre dans le contexte, et le tester (empreinte stable) |
| **Aucun RAG, aucune base vectorielle, aucun agent autonome** | À cette échelle, la mémoire structurée et FTS5 couvrent le besoin réel | Embeddings + recherche sémantique · boucle d'agent avec outils | Le jour où la similarité sémantique manque vraiment, il faudra en faire la démonstration par une mesure |
| **Aucune écriture en base par un LLM** : le modèle propose un `EditPlan` en JSON, le domaine valide et écrit | Un modèle qui écrit directement peut corrompre la mémoire du produit | Donner l'accès base à l'agent · écrire puis corriger | Chaque écriture assistée coûte un aller-retour de validation humaine |
| **Tout coût est attribuable** : projet, job, agent, version de prompt, empreinte de contexte | Sans attribution, ni budget ni diagnostic ne sont possibles | Un compteur global de dépense | Une ligne `llm_calls` par appel, pour toujours |

### 2.4 Pipelines

Source : [`05-pipelines.md`](05-pipelines.md) (§1, §2, §10, §11, §12).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **Un pipeline est du code typé, pas un graphe déclaratif** | Un moteur de workflow ajoute une couche, un format, un débogueur et une abstraction à maintenir | n8n · Temporal · un DSL de graphe maison | Ajouter une étape demande une modification de code et un test — assumé |
| **L'étape atteinte est persistée ; un job interrompu reprend là où il s'est arrêté** | Un crash de worker en pleine transcription ne doit pas coûter un second appel payant | Tout recommencer au début du pipeline · ne rien persister | Il faut écrire du code idempotent à **chaque** étape, sans exception |
| **L'état d'un pipeline vit dans la table métier, pas dans une table de workflow** | Deux sources de vérité pour le même état finissent toujours par diverger | Une table `workflow_runs` générique | Chaque domaine porte ses propres états, avec ses propres contraintes |
| **La publication est déclenchée par un état en base (`approved`), jamais par un appel HTTP direct** | Le déclencheur doit survivre à un redémarrage | Publier depuis la route API · publier depuis le navigateur | L'utilisateur voit un léger décalage entre son clic et le départ du job |
| **Concurrence bornée à ce que la machine supporte** : un seul FFmpeg, un seul whisper à la fois | Deux encodages simultanés saturent un PC modeste et échouent tous les deux | Concurrence illimitée · file par type de ressource | Le débit maximal est plafonné par le matériel, pas par le code |
| **Chaque étape a un délai de garde ; aucune ne peut bloquer indéfiniment** | Un job bloqué consomme un worker et masque les vraies erreurs | Attendre indéfiniment · tuer au bout d'un temps fixe unique | Un délai mal réglé déclenche un échec évitable — à mesurer, pas à supposer |
| **Le mode économie ne coupe jamais la vérification factuelle ni la critique** | Ce sont exactement les deux étapes qui protègent la crédibilité du produit | Couper la critique pour économiser · réduire les deux vérifications de moitié | Le mode économie réduit la fréquence et la longueur, jamais la sûreté |

### 2.5 Connecteurs et publication

Source : [`06-connecteurs-et-publication.md`](06-connecteurs-et-publication.md) (§2, §3, §8, §9, §10, §12, §13).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **Un contrat unique `PlatformConnector` ; aucun nom de plateforme dans `packages/core`** | Le domaine ne doit pas être modifié quand une plateforme change d'API | Un `if (platform === 'linkedin')` dans le pipeline · un service par plateforme | Une indirection de plus, et l'obligation de tout passer par `capabilities_json` |
| **Trois niveaux de publication (A automatisé, B brouillon distant, C paquet manuel)** | Toutes les plateformes ne permettent pas l'automatisation, et leurs CGU changent | Automatiser partout · publier à la main partout | Trois chemins à tester et à expliquer dans l'interface |
| **Le niveau C est implémenté pour *toutes* les plateformes, sans exception** | C'est le niveau qui garantit que le workflow n'est jamais bloqué | Ne faire le niveau C que là où l'API manque | Un écran de plus à maintenir — c'est le filet de sécurité permanent |
| **Niveau retenu en V1 : LinkedIn A, YouTube B, Reddit C, TikTok C** | Aligner l'ambition sur ce que les API autorisent réellement à un particulier | X automatique · TikTok automatisé · Instagram automatisé | Décision **D1** à confirmer à l'étape 5 ; les CGU de chaque plateforme sont marquées ⚠️ à revérifier |
| **Validation du contenu *avant* envoi, depuis `capabilities_json`** | Une publication refusée après envoi laisse un état ambigu et un contenu tronqué | Valider après le refus · faire confiance à l'API | Les règles de format doivent être tenues à jour dans chaque connecteur |
| **`ambiguous` = décision humaine, jamais de rejeu automatique** | Une réponse perdue ne prouve pas que la publication a échoué | Réessayer · considérer l'échec comme acquis | Un contenu peut rester « à vérifier » tant que l'utilisateur n'a pas regardé la plateforme |
| **Une limite de débit reporte une publication, elle ne la fait jamais échouer** | Être banni pour avoir insisté n'est pas acceptable | Réessayer immédiatement · contourner la limite | Le calendrier peut glisser après plusieurs reports |
| **Aucune automatisation de navigateur, aucun scraping de publication** | Fragile, contraire aux CGU, casse à chaque refonte d'interface | Selenium/Playwright pour publier | Certaines plateformes resteront en niveau C indéfiniment — c'est assumé |

### 2.6 Sécurité, secrets, entrées non fiables

Source : [`07-securite-secrets-auth.md`](07-securite-secrets-auth.md) (§3, §4, §5, §6, §8, §9, §11, §13).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **Écoute sur `127.0.0.1` ; `0.0.0.0` refusé au démarrage** | Un serveur accessible au réseau sur un poste personnel est une erreur de configuration coûteuse | Écouter partout avec authentification · tunnel obligatoire | L'accès depuis un autre appareil demande une configuration explicite |
| **OAuth entièrement local, avec `state` + PKCE, identifiants propres à chaque installation** | Aucun serveur public, donc aucun secret partagé entre installations | Un serveur d'authentification central · le flux « device » de chaque plateforme | Pas d'application distribuée : chaque utilisateur enregistre sa propre application côté plateforme |
| **Trois natures de secrets séparées** : `.env`, clés cryptographiques, jetons chiffrés en base | Mélanger les trois fait fuiter les clés avec les jetons | Tout dans `.env` · tout en base · un gestionnaire de secrets externe | Trois endroits à sauvegarder, à documenter et à expliquer |
| **Enveloppe `enc:v1:key_version:nonce:ciphertext:tag`, AES-256-GCM** | Il faut pouvoir changer d'algorithme et faire tourner la clé sans casser les données | Chiffrement ad hoc · chiffrer seulement quelques colonnes « sensibles » | Chaque lecture de jeton paie un déchiffrement — négligeable au volume concerné |
| **Le chiffrement protège la fuite de la base, pas un poste compromis — et on l'écrit** | Promettre plus que la réalité est la meilleure façon de perdre la confiance | Ne rien dire · laisser croire à une protection totale | Une limite assumée, écrite dans l'interface et dans la documentation |
| **Rédaction au point de passage unique + test canari obligatoire en CI** | Un seul oubli de rédaction suffit à écrire un jeton dans un log | Relire le code · interdire les logs | Un test qui échoue à chaque nouveau chemin de journalisation |
| **Contenu externe = donnée ; l'agent qui le lit n'a aucun outil** | Une page Web qui contient une instruction est une attaque par injection | Faire confiance au contenu · filtrer par expressions régulières | Certains contenus légitimes avec des balises seront ignorés |
| **`spawn(binaire, args)`, jamais de shell ; `EditPlan` validé puis compilé** | Une chaîne de commande construite à partir d'une entrée utilisateur est une porte ouverte | `exec` avec concaténation · scripts temporaires | Un peu plus de code pour construire les arguments — c'est testé unitairement |
| **Marquage interne systématique de tout contenu assisté par IA** | Les obligations de divulgation évoluent ⚠️ et la donnée doit exister avant d'en avoir besoin | Marquer seulement quand la loi locale l'exige | Un champ et un affichage de plus, présents dès la première version |

### 2.7 Jobs, observabilité, coûts

Source : [`08-jobs-observabilite-couts.md`](08-jobs-observabilite-couts.md) (§1, §2, §4, §5, §8, §9, §14).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **La file vit dans la table `jobs` ; pas de Redis en V1** | Une dépendance système de plus pour un volume de jobs trivial | Redis + BullMQ · un courtier de messages · un fichier de file | La file est limitée par SQLite : **un seul worker**, débit modeste, assumé |
| **Réservation atomique avec `BEGIN IMMEDIATE`, `attempt` incrémenté à la réservation** | Sans transaction immédiate, deux workers réservent le même job | `SELECT` puis `UPDATE` · verrous applicatifs | Les transactions d'écriture sont exclusives : c'est le prix de la simplicité |
| **Lease 60 s + heartbeat 10 s ; `reclaimExpired` remet en file ce qui a été perdu** | Un crash doit être visible et rattrapable, pas silencieux | Lease très long · aucun lease | Un job légitimement long doit battre le heartbeat, sinon il est repris à tort |
| **Un retry n'est jamais appliqué à un effet de bord non confirmé** | Reposter un contenu déjà publié coûte plus cher que dix appels LLM | Retry générique sur toutes les erreurs · retry illimité | Certaines erreurs exigent une décision humaine — c'est voulu |
| **Un crash n'est pas un échec du job, et un dépassement de budget n'est pas une erreur du job** | Confondre les deux fausse tous les diagnostics | Un seul état `failed` | Plus d'états à comprendre (`cancelled`, reprise sans tentative supplémentaire) |
| **Un dépassement de budget retient le job (`queued`) au lieu de l'annuler** | Le travail peut repartir le lendemain, avec un budget neuf | Annuler le job · dépenser quand même | Rien ne part tant que l'utilisateur n'a pas augmenté le plafond : c'est un choix de sûreté |
| **Tout montant en `micro_usd` entier ; contrôle du budget *avant* l'appel** | Contrôler après coup n'est pas contrôler, c'est constater | Flottants · contrôle a posteriori · plafond mensuel uniquement | Chaque appel doit être estimé avant d'être fait, avec une table de tarifs à maintenir ⚠️ |
| **Cinq niveaux d'observabilité, cinq identifiants de corrélation, SSE reprenable par `sequence`** | « Pourquoi ça a échoué ? » doit se répondre sans lire un log brut | Un fichier de log et `grep` · une interface de traces externe | Une table `job_events` volumineuse, purgée par rétention |
| **Le mode économie réduit la fréquence et la longueur, jamais les garde-fous** | La contrainte de 5 $/semaine ne doit pas dégrader la crédibilité | Couper les vérifications pour tenir le budget | Le mode économie peut rendre le produit **plus lent**, jamais moins sûr |

### 2.8 Tests et qualité

Source : [`09-tests-et-qualite.md`](09-tests-et-qualite.md) (§1, §3, §4, §6, §12, §13, §14, §16).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **Le test est placé au niveau le plus bas qui détecte la panne** | Un E2E pour chaque règle métier rend la suite lente et instable | Tout tester en E2E · tout tester en unité | Il faut choisir, à chaque fois, le bon niveau — c'est un jugement, pas une règle automatique |
| **Quatre outils : Vitest, Playwright, MSW, SQLite fichier** | Un cinquième outil, c'est une cinquième façon de tomber en panne | Jest · Cypress · une base en mémoire · Docker pour les tests | Pas de tests isolés dans un conteneur jetable : les tests utilisent un fichier SQLite réel |
| **Trois tests avant tout le reste** : publication non dupliquée, reprise après crash, refus de budget avant envoi | Ce sont les trois pannes qui détruisent la confiance | Commencer par les tests de schéma et d'interface | Trois tests difficiles à écrire arrivent en premier, avant tout confort |
| **Aucun test ne parle au monde extérieur par défaut ; la suite `live` est séparée et manuelle** | Un test qui dépend du réseau échoue sans raison — ou pire, coûte de l'argent | Mocker partout sauf les appels LLM · tout tester en réel | La suite `live` (~10 tests) n'est jamais exécutée automatiquement : c'est un risque assumé |
| **Les prompts sont testés par propriétés** (schéma, longueur, fidélité), pas par sortie exacte | Une sortie exacte change à chaque version de modèle et ne teste rien de solide | Comparer à une sortie de référence · ne pas tester les prompts | Une régression subtile de ton peut passer : les tests par propriétés ne jugent pas le style |
| **La CI est locale** : pré-commit < 15 s et `scripts/verify.sh` | Pas de secrets ni de code privé dans un service distant | GitHub Actions · un runner auto-hébergé | La vérification dépend de la discipline de l'utilisateur : rien ne l'empêche de pousser sans avoir lancé `verify.sh` |
| **« Non testé » doit être visible comme tel, dans un chapitre dédié** | Un trou de test caché est plus dangereux qu'un trou de test déclaré | Ne pas en parler | Une dette assumée et écrite, à relire à chaque fin de version |

### 2.9 L'ordre de construction

Source : [`10-plan-de-developpement-12-etapes.md`](10-plan-de-developpement-12-etapes.md) (§1, §3, §7).

| Décision | Contexte | Options écartées | Conséquences assumées |
|---|---|---|---|
| **Douze étapes groupées en trois versions utilisables** (V1 : 1–5, V2 : 6–9, V3 : 10–12) | Chaque version doit être un produit qui marche, pas une couche technique | Un enchaînement strictement technique · un seul jet | Ce ne sont pas des jalons de communication mais des points d'arrêt possibles |
| **La publication manuelle (niveau C) arrive dès l'étape 5** | Attendre une validation d'API bloquerait tout le produit sur une dépendance externe | Publier d'abord par API · attendre l'accès à toutes les plateformes | La V1 publie à la main : c'est un choix de délai, pas un aveu d'échec |
| **La mémoire avant la génération** (étape 2 avant étape 4) | Un générateur sans mémoire produit exactement le contenu que le produit doit remplacer | Générer d'abord pour démontrer · construire toute la base d'abord | La première démonstration impressionnante arrive plus tard |
| **La table d'abord, le pipeline ensuite** | Une migration par fonctionnalité est un risque permanent de casser des données | Créer chaque table au moment de son pipeline | Quelques tables restent vides pendant plusieurs étapes — c'est assumé et documenté |
| **Quatre jalons de revue, dont un (J1) peut arrêter le projet** | Revoir chaque étape dilue l'attention ; ne jamais revoir laisse dériver | Une revue à chaque étape · aucune revue formelle | Le jalon J1 (fin de V1) est un vrai point d'arrêt, y compris d'arrêt du projet |
| **Si une étape déborde, c'est le critère de sortie qui se réduit, pas l'étape qui s'allonge** | Un plan dont les étapes s'allongent n'est plus un plan | Allonger · ajouter des jours « tampon » partout | Certaines fonctionnalités prévues seront reportées d'une version — c'est prévu pour |

---

## 3. Les décisions ouvertes (D1 à D6)

Ces six décisions viennent de [`02-architecture.md`](02-architecture.md) §15. Elles sont **assumées
comme ouvertes** : les trancher maintenant serait décider sans information. Chacune indique l'étape
qui la requiert et le **critère** qui permettra de choisir.

| # | Décision | Étape | Option A | Option B | Ce qui tranchera |
|---|---|---|---|---|---|
| D1 | Nombre de plateformes en V1 | 5 | 1 (LinkedIn) | 2 (LinkedIn + Reddit) / 3 (+ X) | Le temps de mise en place des connecteurs, mesuré à l'étape 5 |
| D2 | Modèle de transcription par défaut | 3 | `small` (rapide, moins précis) | `medium` (plus lent, plus juste) | Le résultat sur 20 transcriptions réelles, chronométré |
| D3 | Adaptation multi-plateformes | 6 | Réécriture LLM soumise à validation | L'utilisateur réécrit lui-même | La qualité observée à l'étape 4 sur des contenus réels |
| D4 | Fréquence de collecte analytics | 8 | Quotidien | Toutes les 6 h | Les quotas réels de l'API et l'utilité d'une fraîcheur de 6 h |
| D5 | Sauvegarde des médias volumineux | 10 | Snapshot complet | Base et médias séparés | Le volume réellement accumulé après une semaine |
| D6 | Mode « démo » avec données fictives | 11 | Oui (démontrable à un tiers) | Non (charge de travail) | Le temps restant et l'existence d'un besoin de démonstration |

### 3.1 D1 — Nombre exact de plateformes de la V1

| Rubrique | Contenu |
|---|---|
| **Contexte** | Chaque plateforme coûte : un connecteur, un jeu de règles de format, un prompt dédié, un test de conformité et une vérification des CGU. Trois plateformes multiplient par trois le travail de l'étape 5 |
| **Option A — 1 plateforme (LinkedIn)** | Le plus rapide à finir. Conséquence assumée : le produit ne démontre pas la promesse « un contenu, plusieurs plateformes », qui est l'une de ses raisons d'être |
| **Option B — 2 plateformes (LinkedIn + Reddit)** | Compromis : une plateforme à API et une plateforme à paquet manuel, donc les deux chemins sont exercés. Conséquence : l'étape 5 s'allonge |
| **Option C — 3 plateformes (+ X)** | La plus démonstrative sur l'adaptation. Conséquence : trois jeux de contraintes à valider, et X est la plateforme la plus volatile en termes de conditions d'accès ⚠️ |
| **Décision** | **Ouverte** |
| **Critère** | Le connecteur LinkedIn est terminé et testé **avant** d'ouvrir Reddit. Si l'étape 5 dépasse son estimation, on reste à 2 plateformes et le niveau C est déjà implémenté pour les autres |
| **À consigner dans** | Ce document, §2 (la décision y est ajoutée le jour où elle est tranchée), au moment où le connecteur LinkedIn passe ses tests de conformité |

### 3.2 D2 — Transcription locale : `small` par défaut ou `medium` ?

| Rubrique | Contenu |
|---|---|
| **Contexte** | La transcription tourne en local sur un PC modeste. Le modèle détermine la qualité de tout ce qui suit : un mauvais transcript produit un mauvais contenu |
| **Option A — `small` par défaut** | Rapide (souvent proche du temps réel), exploitable en français. Conséquence : homophones et noms propres techniques mal reconnus, corrections manuelles fréquentes |
| **Option B — `medium` par défaut** | Nettement meilleur sur le vocabulaire technique. Conséquence : plusieurs fois le temps de calcul, un job qui occupe le worker beaucoup plus longtemps |
| **Option C — `small` par défaut, `medium` en option « qualité »** | Le meilleur compromis apparent, au prix d'un chemin de code supplémentaire et de deux formats de sortie à tester |
| **Décision** | **Ouverte** |
| **Critère** | Mesure sur **20 extraits réels** : temps de traitement, nombre de corrections manuelles nécessaires. Si `small` demande plus de 10 % de corrections, on passe à `medium` |
| **À consigner dans** | Ce document, §2 (la décision y est ajoutée le jour où elle est tranchée), avec les chiffres mesurés à l'étape 3 |

### 3.3 D3 — Adaptation multi-plateformes : réécriture assistée ou manuelle ?

| Rubrique | Contenu |
|---|---|
| **Contexte** | Le même fond doit produire un texte court pour LinkedIn, un texte structuré pour Reddit, une accroche pour TikTok. Chaque plateforme a ses codes, et un texte mal adapté se voit immédiatement |
| **Option A — réécriture LLM, validée par l'utilisateur** | Gain de temps net, cinq variantes produites en un appel. Conséquence : un ton qui peut devenir uniforme, une validation humaine indispensable, un coût par contenu |
| **Option B — l'utilisateur réécrit lui-même** | Le ton reste le sien, aucun coût d'appel. Conséquence : c'est exactement le travail que le produit devait supprimer ; la promesse de départ tombe |
| **Option C — réécriture LLM pour la structure, l'utilisateur pour la voix** | Le modèle propose un plan et des accroches, l'utilisateur écrit le corps. Conséquence : la frontière entre les deux est difficile à tenir dans l'interface |
| **Décision** | **Ouverte** |
| **Critère** | À l'étape 4, un contenu assisté doit être comparé à un contenu écrit à la main, côte à côte. Si l'assisté est jugé « générique » à la lecture, c'est l'option A qui est abandonnée, pas l'agent qui est amélioré indéfiniment |
| **À consigner dans** | Ce document, §2 (la décision y est ajoutée le jour où elle est tranchée), avec les deux contenus en pièce jointe |

### 3.4 D4 — Fréquence de collecte des statistiques

| Rubrique | Contenu |
|---|---|
| **Contexte** | Les statistiques de publication ne servent à quelque chose que si l'on peut les comparer. Une collecte trop rare rend les courbes plates ; trop fréquente, elle épuise les quotas d'API |
| **Option A — quotidien** | Une collecte par jour et par plateforme : lisible, sobre, suffisant pour un cycle de publication hebdomadaire. Conséquence : pas de réaction possible sur les premières heures d'une publication |
| **Option B — toutes les 6 h** | Détecte les décollages rapides. Conséquence : 4× le nombre d'appels, des quotas atteints plus vite, et une précision sur les données qui dépend des fenêtres réelles de chaque API ⚠️ |
| **Option C — quotidien + rafale sur 24 h après publication** | Le meilleur des deux mondes, mais deux mécanismes de planification à écrire et à tester |
| **Décision** | **Ouverte** |
| **Critère** | Les quotas réels de l'API des plateformes déployées, mesurés à l'étape 8. Si le plafond quotidien tolère 4 appels sans risque de suspension, l'option B passe devant |
| **À consigner dans** | Ce document, §2 (la décision y est ajoutée le jour où elle est tranchée), avec les quotas relevés |

### 3.5 D5 — Sauvegarde : snapshot complet ou base et médias séparés ?

| Rubrique | Contenu |
|---|---|
| **Contexte** | La base SQLite fait quelques mégaoctets, mais les vidéos et les audios peuvent peser des dizaines de gigaoctets. Sauvegarder tout en un bloc devient vite impossible à copier ou à stocker ailleurs |
| **Option A — snapshot complet** | Un seul fichier ou dossier à copier, une seule commande à retenir, restauration triviale. Conséquence : un snapshot devient énorme et lent ; sauvegarder chaque jour revient à recopier des médias qui ne changent pas |
| **Option B — base et médias séparés** | La base se sauvegarde en quelques secondes, plusieurs fois par jour ; les médias suivent un rythme plus lent. Conséquence : une restauration demande deux étapes et une convention de nommage des fichiers à respecter |
| **Option C — base souvent, médias à la demande** | Une sauvegarde légère en continu et un export manuel des médias quand l'utilisateur en a besoin. Conséquence : après un sinistre, certains médias peuvent manquer — mais jamais les données qui décrivent le travail |
| **Décision** | **Ouverte** |
| **Critère** | Le volume réellement accumulé après une semaine d'usage (étape 10). Sous 2 Go, l'option A suffit largement ; au-delà, l'option B est décidée de fait |
| **À consigner dans** | Ce document, §2 (la décision y est ajoutée le jour où elle est tranchée), avec le volume mesuré |

### 3.6 D6 — Mode « démonstration » avec données fictives

| Rubrique | Contenu |
|---|---|
| **Contexte** | Le produit ne se montre pas s'il est vide. Un mode démo permet de présenter les écrans remplis sans exposer les vraies données. Mais c'est du code qui ne sert qu'à la démonstration |
| **Option A — mode démo** | Le produit est présentable à un tiers en cinq minutes. Conséquence : un jeu de données à maintenir à chaque évolution du schéma, et un risque de confusion avec les données réelles |
| **Option B — pas de mode démo** | Aucune charge de travail supplémentaire, aucune confusion possible. Conséquence : toute présentation exige d'avoir publié pour de vrai, ce qui n'est pas toujours possible |
| **Option C — projet de démonstration créé par commande, données réelles factices** | Plus simple qu'un mode complet : un script qui remplit un projet avec des contenus plausibles. Conséquence : le script doit être mis à jour à chaque migration, mais il ne s'exécute que sur demande |
| **Décision** | **Ouverte** |
| **Critère** | Le temps restant à l'étape 11 et l'existence réelle d'un besoin de démonstration à un tiers. **Par défaut : non** — une décision ouverte qui ne se tranche pas retombe sur l'option la moins coûteuse |
| **À consigner dans** | Ce document, §2 (la décision y est ajoutée le jour où elle est tranchée), avec la raison de l'abandon ou de la mise en œuvre |

> **Règle des décisions ouvertes.** Une décision ouverte **ne bloque jamais** l'étape qui la requiert :
> elle est tranchée **par écrit juste avant** l'étape concernée, jamais pendant et jamais après. Si
> aucune mesure n'existe encore au moment voulu, c'est l'option la moins coûteuse qui s'applique, et
> elle est écrite comme telle.

---

## 4. Les risques majeurs

Un risque n'est retenu ici que s'il peut **empêcher une version d'exister** ou **coûter cher** en
temps ou en argent. Chaque ligne indique le signal qui le rend visible, et la parade — qui est
toujours un choix, jamais une promesse.

Échelle : **Prob.** et **Impact** vont de 1 (faible) à 3 (élevé). Un produit ≥ 6 est un risque à
traiter en priorité, pas à surveiller.

### 4.1 Risques techniques

| Risque | Prob. | Impact | Signal d'apparition | Parade |
|---|---|---|---|---|
| **SQLite supporte mal la concurrence d'écriture** | 2 | 3 | `SQLITE_BUSY` dans les journaux dès que l'interface écrit pendant qu'un job tourne | Un seul writer (le worker), `BEGIN IMMEDIATE` sur les réservations, WAL, délai d'attente explicite ; le passage à PostgreSQL reste un travail de dialecte |
| **Reprise de job incorrecte** (job repris alors qu'il avait en réalité terminé) | 2 | 3 | Un contenu publié deux fois, ou une vidéo encodée deux fois, visible dans les journaux de la plateforme | Le test « reprise après crash » est écrit **avant** la fonctionnalité (étape 1) ; les étapes à effet de bord persistant leur résultat avant l'action |
| **Hallucination factuelle publiée** | 2 | 3 | Un chiffre ou un nom qui n'existe pas dans le contenu final ; un `content_claims.risk='eleve'` validé sans vérification | Le contrôle est en base (déclencheur), `fact_checker` est un agent distinct, la publication reste manuelle par défaut |
| **Dérive des coûts d'appels LLM** | 2 | 2 | Le budget hebdomadaire atteint avant la fin de la semaine, de façon répétée | Plafond dur, contrôle *avant* l'appel, `maxTokens` par agent, mode économie qui ne coupe jamais les garde-fous |
| **PC insuffisant pour whisper ou FFmpeg** | 3 | 2 | Un job de transcription qui dure plus d'une heure, un worker qui sature le disque ou la mémoire | Choix du modèle mesuré (D2), un seul job lourd à la fois, délais de garde, mode « transcript fourni par l'utilisateur » |
| **Perte de données locales** (disque, mauvaise manipulation) | 2 | 3 | Aucun signal avant coup : c'est précisément le risque | Sauvegarde décidée à l'étape 10 (D5), suppressions logiques, migrations testées sur base peuplée et restauration testée |
| **Migration cassant une base existante** | 2 | 3 | Une colonne absente au démarrage, une donnée tronquée après migration | Toute migration est testée sur une base peuplée et rejouable ; jamais de perte de colonne sans étape de copie |
| **Injection par contenu externe** (une page Web qui contient des instructions) | 2 | 2 | Le modèle produit soudain un texte qui ressemble à une consigne plutôt qu'à un contenu de source | Contenu externe traité comme donnée, agent de lecture sans outils, balises, aucune écriture en base par un LLM |
| **Fuite d'un jeton dans un journal** | 1 | 3 | Le test canari de rédaction qui échoue en CI | Rédaction au point de passage unique, test canari obligatoire, jetons chiffrés en base plutôt qu'en clair dans un fichier |

### 4.2 Risques de coûts

| Risque | Prob. | Impact | Signal d'apparition | Parade |
|---|---|---|---|---|
| **Les tarifs des modèles changent** ⚠️ | 3 | 2 | Un écart entre le coût estimé et la facture réelle de l'opérateur | Table de tarifs isolée dans un seul module (`pricing`) : une seule modification ; le coût est mesuré et comparé chaque mois |
| **Le budget de 5 $/semaine ne suffit pas** | 3 | 2 | Le plafond atteint avant la moitié des contenus prévus | Mode économie, réduction du nombre de variantes, mais **jamais** de coupe sur la vérification factuelle ni sur la critique |
| **Le coût du rendu vidéo local est sous-estimé** (temps CPU, échecs) | 2 | 2 | Une vidéo de 3 minutes qui prend plus de 30 minutes, deux essais avant un rendu acceptable | Modèle vidéo choisi après mesure (étape 7), résolution et durée par défaut modestes, rendu en une seule passe |
| **Dépense « fantôme » : annuler un job après que l'appel LLM est parti** | 2 | 1 | Un `llm_calls` sans job associé, ou l'inverse | L'annulation est constatée après l'appel, jamais annoncée avant ; l'attribution garde la trace de l'appel réellement facturé |

### 4.3 Risques liés aux plateformes et aux API

| Risque | Prob. | Impact | Signal d'apparition | Parade |
|---|---|---|---|---|
| **Validation d'application refusée ou longue** (LinkedIn, YouTube) | 3 | 3 | Le formulaire de demande reste sans réponse, ou une réponse demande des informations que le projet n'a pas | Le niveau C (paquet manuel) est développé **pour toutes** les plateformes, sans exception : le produit reste utilisable même sans aucune validation |
| **CGU interdisant ou limitant l'automatisation** ⚠️ | 3 | 2 | Un avertissement de la plateforme, une publication supprimée, un compte restreint | Un niveau de publication par plateforme, revérification documentée avant chaque ajout de connecteur, aucune automatisation de navigateur |
| **Changement d'API cassant un connecteur** | 3 | 2 | Une erreur de format ou de version au premier appel, un champ qui disparaît | Version d'API épinglée dans `capabilities_json`, tests de conformité par connecteur (§2.5), un connecteur cassé n'affecte pas les autres |
| **Limites de débit atteintes pendant une rafale** | 3 | 1 | Des réponses 429 dans les journaux du connecteur | Report de la publication (jamais un échec), espacement des appels, nom `job` conservé pour un rejeu unique |
| **Réponse perdue : le contenu est peut-être publié** | 2 | 2 | Un post visible sur la plateforme qu'aucun enregistrement ne mentionne | État `ambiguous`, jamais de rejeu automatique, l'utilisateur tranche ; c'est le seul chemin qui exige une décision humaine sur la publication |
| **Statistiques non comparables entre plateformes** (définitions différentes de « vue ») ⚠️ | 3 | 1 | Deux plateformes avec des ordres de grandeur incompatibles pour un même contenu | Les chiffres bruts sont stockés par plateforme, la comparaison n'affiche jamais un total unique trompeur |

### 4.4 Risques produit et personnels

Ces risques ne sont pas techniques, et ce sont ceux qui font habituellement mourir un projet solo.

| Risque | Prob. | Impact | Signal d'apparition | Parade |
|---|---|---|---|---|
| **Le projet ne dépasse jamais la V1** | 3 | 3 | V1 terminée mais non utilisée sur de vrais contenus pendant plusieurs semaines | Le jalon **J1** (fin de V1) est le point de décision : continuer **seulement** si la V1 a servi au moins deux fois en réel |
| **Sur-ingénierie : construire plus d'infrastructure que de produit** | 3 | 3 | Deux semaines passées sur la file de jobs, aucun contenu publié | La règle du plan « la table d'abord, le pipeline ensuite » et les critères de sortie binaires de chaque étape (§2.9) |
| **Le produit n'est pas meilleur que l'écriture manuelle** | 2 | 3 | L'utilisateur réécrit systématiquement les contenus générés | C'est l'objet même de **D3** : si le contenu assisté est jugé générique, c'est la réécriture assistée qui est abandonnée, pas le produit entier |
| **Le ton uniforme** (tout se ressemble après trois semaines) | 2 | 2 | Une file de contenus interchangeables | `critic` juge explicitement la répétition, la mémoire évite de republier une idée déjà traitée, la voix de marque est une donnée du projet |
| **Le volume de publication dépasse la capacité d'attention** (trop de contenus à valider) | 2 | 2 | Une file de contenus « en attente » qui ne se vide pas | Rythme hebdomadaire plafonné, mode économie, la validation en un seul écran |
| **Dérive de périmètre** (ajouter un agent, une plateforme, une idée « pendant qu'on y est ») | 3 | 2 | Une étape qui produit deux fonctionnalités nouvelles non prévues | Les dix **interdits permanents** de [`10-plan-de-developpement-12-etapes.md`](10-plan-de-developpement-12-etapes.md) §6, et la règle « c'est le critère de sortie qui se réduit, pas l'étape qui s'allonge » |
| **Lassitude** : l'automatisation de contenu devient un second travail | 2 | 3 | Le worker tourne mais personne ne valide plus rien | Le produit est conçu pour **produire moins**, pas plus : c'est un choix assumé dès la conception ↴ |

> **Sur la lassitude.** Un outil d'automatisation de contenu peut créer l'effet inverse de celui
> recherché : une file qui se remplit plus vite qu'elle ne se vide. La parade n'est pas technique —
> elle est dans le rythme : un nombre de contenus **plafonné par semaine**, et la possibilité
> explicite de ne rien publier une semaine sans que rien ne se casse.

---

## 5. Les limites assumées

Une limite assumée n'est pas un oubli : c'est un choix écrit, avec la **condition qui le ferait
changer**. Une limite sans condition de réexamen est soit une décision définitive, soit un aveu
déguisé — dans les deux cas, elle doit être écrite.

### 5.1 Limites de produit

| Limite | Ce qui n'est pas fait | Pourquoi | Condition de réexamen |
|---|---|---|---|
| **Un seul utilisateur** | Pas de comptes, pas de rôles, pas de partage, pas de collaboration | Multiplier les utilisateurs multiplie les contraintes (concurrence d'écriture, permissions, quotas par personne) sans servir l'usage réel | Un second utilisateur **réel** demande l'accès — pas une hypothèse |
| **Local d'abord, jamais hébergé en V1** | Pas de service en ligne, pas d'accès distants, pas de comptes clients | Le poste suffit et les données restent chez l'utilisateur | Le poste devient un frein mesuré : jobs qui ne tournent pas parce que la machine est éteinte, plusieurs semaines de suite |
| **Pas d'application mobile** | Aucune application iOS ou Android ; l'interface est utilisée sur le poste | Une application mobile signifie une synchronisation, donc un serveur, donc tout ce qui a été écarté ci-dessus | Jamais en V1–V3 ; la question ne se pose qu'après une décision explicite sur l'hébergement |
| **Un seul fuseau horaire, une seule langue d'interface** | Pas de traduction de l'interface, pas de gestion de fuseaux | Un seul utilisateur, un seul lieu | Un usage réel dans une autre langue |
| **Deux langues de contenu visées** (français d'abord, anglais ensuite) | Pas de support de langues supplémentaires | whisper et les agents sont réglés pour ces deux langues ; en ajouter sans les tester produirait du contenu médiocre | Un besoin réel et documenté, avec des tests de qualité derrière |
| **Pas de collaborative editing ni de temps réel partagé** | Pas de curseurs partagés, pas de coédition | Un seul utilisateur : le besoin n'existe pas | Aucune : ce serait un autre produit |
| **Pas de RAG ni de recherche sémantique** | Pas d'embeddings, pas de base vectorielle | À cette échelle, la mémoire structurée et la recherche plein texte couvrent le besoin | Une mesure démontre que les recherches par mots-clés ratent des souvenirs utiles, de façon répétée |
| **Pas de promesse sur les API des plateformes** | Aucun engagement de niveau A ou B ; aucune garantie de validation d'application | Les plateformes décident, pas le projet | Aucune : c'est une dépendance externe, pas une limite technique |

### 5.2 Limites techniques

| Limite | Ce qui n'est pas fait | Pourquoi | Condition de réexamen |
|---|---|---|---|
| **Un seul worker, un seul writer en base** | Pas de workers parallèles, pas de montée en charge | SQLite et un PC personnel : le débit est plafonné par le matériel | Le passage à PostgreSQL est fait (il est prévu) et le volume le justifie |
| **Pas de Docker ni de Kubernetes en V1** | Pas de conteneurs, pas d'orchestration | `pnpm dev` doit suffire pour un poste unique | L'étape 12 (ou une demande d'installation par un tiers) |
| **Pas de GPU requis, aucun rendu en 4K** | Pas d'accélération matérielle obligatoire, pas de rendu haute résolution par défaut | Un PC modeste doit exécuter le produit ; le 4K sans GPU est un piège | Un rendu confirmé comme trop lent **et** l'usage réel de la haute résolution |
| **Pas de Chromium ni d'automatisation de navigateur** | Aucun Playwright/Selenium en production (Playwright sert uniquement aux tests d'interface) | Fragile, contraire aux CGU de publication, casse à chaque refonte | Aucune : c'est un interdit permanent |
| **Le chiffrement protège la base, pas le poste** | Pas de protection contre un poste compromis, pas de chiffrement de bout en bout | Une clé présente sur la machine ne protège pas la machine | Aucune : c'est une limite de nature, elle est documentée dans l'interface |
| **Pas de sauvegarde automatique avant l'étape 10** | Aucune copie de sécurité pendant les étapes 1 à 9 | La sauvegarde est décidée par la mesure (D5), pas par une intuition | Acquisition formelle de la fonctionnalité à l'étape 10 |
| **Pas de tests de charge, pas d'objectifs de performance** | Aucun budget de latence contractuel | Un utilisateur ne produit pas de charge | Aucune : sans enjeu, ces tests seraient décoratifs |
| **Pas de vérification juridique des CGU** ⚠️ | Les conditions des plateformes sont citées et datées, jamais interprétées | Le projet n'a pas de compétence juridique et ne prétend pas en avoir | Une utilisation commerciale, ou une question juridique réelle |
| **Pas de conformité réglementaire certifiée** (RGPD, AI Act, etc.) | Aucune certification, aucune revendication de conformité | Le produit est personnel, local, mono-utilisateur | Un usage pour des tiers : la question change entièrement de nature |

---

## 6. Ce qui doit attendre

C'est la section « refusée » du §1.2. Rien ici n'est un « peut-être » : ce sont des fonctionnalités
identifiées, jugées légitimes, et **volontairement écartées** du périmètre. Chacune porte la
condition qui la ferait revenir — une fonctionnalité « pour plus tard » sans condition est une
fonctionnalité qu'on ajoutera au mauvais moment.

| Ce qui attend | Pourquoi maintenant non | Ce qui le ferait revenir | Cible |
|---|---|---|---|
| **Second utilisateur / multi-tenant** | Toute la conception repose sur un seul utilisateur : un écrivain unique en base, pas de permissions, pas de quotas par personne | Un second utilisateur **réel** et régulier, pas une hypothèse de croissance | Jamais en V1–V3 |
| **Hébergement / version en ligne** | Contredit « local d'abord » et ouvre d'un coup : authentification, hébergement, coûts fixes, conformité | Une décision explicite, écrite, avec le coût mensuel assumé | Après V3, décision séparée |
| **Application mobile** | Implique une synchronisation, donc un serveur, donc l'hébergement ci-dessus | La même décision d'hébergement, plus tard | Sans objet en V1–V3 |
| **RAG, embeddings, recherche sémantique** | La mémoire structurée et le plein texte couvrent le besoin à cette échelle ; une base vectorielle à maintenir pour un gain non démontré | Une mesure : des souvenirs utiles introuvables par mots-clés, de façon répétée | V3+ si la mesure existe |
| **Agent autonome avec outils** (qui décide seul d'appeler d'autres agents) | Rend le coût et le comportement imprévisibles ; l'orchestrateur déterministe est la garantie de compréhension | Jamais sous cette forme : la demande portera probablement sur des boucles **bornées**, pas sur de l'autonomie | Sans objet |
| **Automatisation de navigateur pour publier** | Contraire aux CGU, fragile, casse à chaque refonte d'interface | Aucune condition : interdit permanent (§5.2) | Jamais |
| **Publication automatique sur X, TikTok, Instagram** | Accès refusés ou instables pour un particulier ⚠️, et automatiser là où la plateforme ne l'autorise pas met le compte en risque | Une voie d'accès officielle, stable, documentée, et une revue des CGU de la plateforme | À revoir plateforme par plateforme |
| **Collaboration, commentaires, partage de contenus** | Un seul utilisateur : le besoin n'existe pas | Un second utilisateur qui en fait la demande explicite | Sans objet |
| **Analytique avancée** (attribution, cohortes, prédiction de performance) | Les volumes réels (quelques contenus par semaine) ne permettent aucune conclusion statistique honnête | Plusieurs mois de données réelles avec un volume suffisant | V3+ |
| **Publication d'un article long / blog intégré** | Le produit est conçu pour des contenus courts ; un CMS est un autre produit | Un usage réel : publier du texte long depuis l'outil plutôt qu'ailleurs | V3+ si répété |
| **Choix du modèle LLM par contenu, en interface** | Multiplie les chemins testés et les coûts surprise ; le mode économie couvre le besoin réel | Un besoin exprimé de comparer deux modèles sur un même contenu | Après la première version en usage |
| **Support d'autres langues que français et anglais** | Les prompts et les tests de qualité n'existent que pour ces deux langues | Un besoin réel **et** des tests de qualité pour la nouvelle langue | Après V3 |
| **Mode démo avec données fictives** | Ne sert qu'à la démonstration : charge de travail de maintenance non nulle | Décision **D6** : un besoin de présentation à un tiers | Étape 11, si D6 = oui |
| **PostgreSQL** | Le passage est prévu dans la conception, mais rien ne le justifie à cette échelle | Un volume ou une concurrence que SQLite ne tient plus, mesuré | Après V3 |
| **Docker, déploiement, CI distante** | Un poste, un environnement : la complexité ne se rembourse pas | Une installation par un tiers, ou un environnement différent du poste de développement (étape 12) | V3 |
| **Facturation, licence, quota par utilisateur** | Il n'y a pas d'utilisateur payant ; ce serait du code mort | Un passage à un usage commercial, décision séparée | Sans objet en V1–V3 |
| **Support technique, télémétrie, remontée d'erreurs automatique** | Contredit « les données chez moi » et n'a pas d'utilisateur à qui profiter | Aucune condition en usage personnel | Sans objet |

> **Règle de report.** Une ligne de ce tableau ne sort de ce chapitre que par une **décision
> explicite** ajoutée au §2, avec son étape et ses conséquences. « On verra plus tard » n'est pas
> une décision : c'est une ligne de ce tableau qui n'a pas été écrite.

---

## 7. Synthèse

### 7.1 Le registre en chiffres

| Élément | Nombre | Où | Rythme de mise à jour |
|---|---|---|---|
| Décisions prises et verrouillées | 67 | §2 | À chaque décision nouvelle, jamais en lot |
| Décisions ouvertes, avec critère et étape | 6 | §3 (D1–D6) | Tranchées une par une, juste avant l'étape concernée |
| Risques majeurs identifiés | 26 | §4 | Revus à chaque jalon (J1 à J4) |
| Limites assumées, avec condition de réexamen | 17 | §5 | Réexaminées seulement si la condition écrite se présente |
| Fonctionnalités volontairement reportées | 17 | §6 | Une ligne ne sort que par une décision ajoutée au §2 |

Ce ne sont pas des indicateurs de qualité. C'est une indication de **taille** : le nombre de
décisions écrites est le seul moyen de savoir, six mois plus tard, ce qui a été tranché et pourquoi.

### 7.2 Les cinq décisions non négociables

Ce sont les décisions de niveau « très coûteux » (§1.3). Elles ne se discutent pas à l'étape 12 :
elles se **vérifient**. Si l'une d'elles est fausse, ce n'est pas une décision à changer, c'est une
partie du produit à refaire.

| Décision | Ce qu'elle protège | Comment on la vérifie |
|---|---|---|
| **`packages/core` n'importe aucune infrastructure** | La portabilité : passer au cloud ne doit toucher aucune règle métier | Un test de dépendances interdit tout import d'I/O depuis `core` (étape 12) |
| **Trois applications, un seul domaine** | L'interface ne peut pas être bloquée par un job long | L'interface reste utilisable pendant une transcription et un rendu vidéo |
| **Un seul writer en base, `BEGIN IMMEDIATE` sur les réservations** | L'intégrité des données et l'absence de double publication | Le test « publication non dupliquée » et la revue des transactions |
| **Mémoire structurée, aucun RAG, aucun agent autonome** | La prévisibilité du coût et la compréhension du comportement | Une revue annuelle : le besoin de similarité sémantique est-il démontré par une mesure ? |
| **Mono-utilisateur, local, données chez l'utilisateur** | Le périmètre, donc la faisabilité | Toute conversation qui propose un compte, un hébergement ou une synchronisation revient à cette ligne |

### 7.3 Les trois risques à surveiller en permanence

Ce ne sont pas les plus probables, ce sont ceux qui font le plus de dégâts si on ne les voit pas
venir : un risque à impact 3 dont le signal est facile à rater.

| Risque | Seuil d'alerte | Ce qu'on fait au seuil |
|---|---|---|
| **Double publication** (reprise de job sur un effet de bord) | **Une seule** occurrence, jamais tolérable | Arrêt des publications automatiques, revue du chemin fautif, test de non-régression écrit avant la correction |
| **Hallucination factuelle validée** | Un fait erroné publié, ou un `risk='eleve'` approuvé sans vérification | Revue de la porte de sortie (le déclencheur en base), et non du prompt : c'est la porte qui a manqué |
| **Dérive du budget d'appels LLM** | Deux semaines consécutives au plafond, ou un écart de plus de 20 % avec l'estimation | Passage en mode économie, revue de la taille des contextes envoyés, puis choix mesuré du modèle par agent |

### 7.4 Les six décisions ouvertes et leur échéance

| # | Décision | Échéance | Critère (rappel) |
|---|---|---|---|
| D1 | Nombre de plateformes de la V1 | Étape 5 | Le temps réel de mise en place du premier connecteur |
| D2 | Modèle de transcription par défaut | Étape 3 | 20 transcriptions réelles, chronométrées et corrigées |
| D3 | Adaptation multi-plateformes assistée ou manuelle | Étape 6 (mesurée à l'étape 4) | Comparaison côte à côte avec un contenu écrit à la main |
| D4 | Fréquence de collecte des statistiques | Étape 8 | Les quotas réels observés sur les API déployées |
| D5 | Sauvegarde : un bloc ou deux | Étape 10 | Le volume accumulé après une semaine d'usage réel |
| D6 | Mode démonstration | Étape 11 | Le temps restant et un besoin de démonstration réel (défaut : non) |

**Aucune de ces six décisions ne doit être tranchée aujourd'hui.** Les trancher sans la mesure
reviendrait à choisir au hasard, puis à défendre le hasard.

### 7.5 Trois questions directes

**« Pourquoi écrire tout ça avant de coder ? »**
Parce que les décisions les plus coûteuses de ce projet — pas de multi-utilisateur, pas de RAG, un
orchestrateur déterministe, la mémoire avant la génération — se prennent **avant** la première ligne
de code, et se paient sinon par une réécriture. Ce document ne remplace pas le code : il empêche de
le réécrire.

**« Qu'est-ce qui reste vraiment incertain ? »**
Six décisions (D1–D6) et une dépendance externe entière : l'accès aux API des plateformes. Le reste
est soit tranché, soit explicitement refusé. C'est volontaire : l'inconnu doit être **nommé**, pas
dissous dans une formulation prudente.

**« Quel est le seul risque qui peut tuer le projet ? »**
Pas la technique. C'est « le projet ne dépasse jamais la V1 » (§4.4) : une suite de jobs qui tourne,
une base propre, et aucun contenu réellement publié. C'est exactement pour cela que le jalon **J1**
existe, et qu'il peut arrêter le projet.

### 7.6 Tenir ce registre

| Règle | Détail |
|---|---|
| **On écrit la décision avant de coder** | Surtout pour les décisions « coûteuses » : ajout de colonne, changement de contrat, format de journal |
| **Une décision n'est jamais supprimée** | Elle est remplacée, avec la mention « remplacée par D-xxx » et la raison |
| **Une décision ouverte a une échéance et un critère** | Sinon ce n'est pas une décision ouverte, c'est une inquiétude |
| **Seules les décisions très coûteuses méritent un débat** | Les autres sont mesurées, ajustées, et écrites après coup |
| **Une limite sans condition de réexamen est incomplète** | Soit c'est définitif (et on l'écrit), soit c'est provisoire (et on dit ce qui la lèverait) |
| **Le registre est relu aux quatre jalons** | J1 (fin de V1), J2 (fin de V2), J3 (fin de V3), J4 (vérification finale) — c'est le seul moment où l'on rouvre les décisions très coûteuses |

---

**Documents liés :** [`00-cahier-des-charges.md`](00-cahier-des-charges.md) ·
[`01-vision-produit.md`](01-vision-produit.md) ·
[`02-architecture.md`](02-architecture.md) ·
[`03-modele-de-donnees.md`](03-modele-de-donnees.md) ·
[`04-orchestrateur-et-agents-ia.md`](04-orchestrateur-et-agents-ia.md) ·
[`05-pipelines.md`](05-pipelines.md) ·
[`06-connecteurs-et-publication.md`](06-connecteurs-et-publication.md) ·
[`07-securite-secrets-auth.md`](07-securite-secrets-auth.md) ·
[`08-jobs-observabilite-couts.md`](08-jobs-observabilite-couts.md) ·
[`09-tests-et-qualite.md`](09-tests-et-qualite.md) ·
[`10-plan-de-developpement-12-etapes.md`](10-plan-de-developpement-12-etapes.md) ·
[`README.md`](README.md)














