# Mise en œuvre — étape 10 : veille, news et adaptation éditoriale

Ce document décrit ce qui est effectivement livré. La veille découvre et classe des
actualités vérifiables, puis propose une adaptation éditoriale et, si l'utilisateur le
demande, un déplacement de calendrier. Elle ne publie rien et ne modifie jamais un créneau
sans décision humaine.

## 1. Audit et réemploi

Les tables `news_sources` et `news_items`, créées à l'étape 7, sont conservées. La migration
`0009` les enrichit sans les remplacer par un nouveau modèle : catégories de source,
identifiant externe, composantes de score, explication, urgence, vérification, affirmations
et suggestion. Un test applique cette migration à une base étape 9 déjà peuplée et vérifie
les clés étrangères ainsi que la conservation des lignes.

Le calendrier de l'étape 9 est également réutilisé. Une news produit un
`CalendarChangeProposal` existant ; aucun second système de planification n'a été créé.

## 2. Providers et sources

`NewsProvider<T>` impose trois opérations : `fetchLatest`, `normalize` et `healthCheck`.
Deux implémentations gratuites sont actives :

- RSS et Atom, parsés avec `fast-xml-parser` ;
- endpoint HTTP public retournant un tableau JSON ou `{ items: [...] }`.

Le transport `fetch` est injectable. Les tests et le parcours E2E utilisent donc des réponses
locales, sans Internet. Le provider WEB refuse volontairement le scraping HTML. Une recherche
web future pourra implémenter le même contrat si elle est configurée et autorisée, sans rendre
une API payante obligatoire.

Une source contient son projet, son nom, son type, son URL, ses catégories et mots-clés, sa
langue, son niveau de confiance, sa fréquence et son état de santé. L'interface permet de
l'ajouter, l'activer, la désactiver, la collecter et de modifier catégories, confiance et
fréquence sans changement de code.

## 3. Collecte et normalisation

Le job `collect_news` lit soit une source demandée, soit les sources actives arrivées à
échéance. Chaque entrée devient une structure normalisée avec provenance, URL canonique,
date, auteur, langue, catégories et empreinte SHA-256. Un mot-clé d'exclusion écarte l'entrée
avant insertion. Une source réussie remet son compteur d'erreurs à zéro ; cinq erreurs
consécutives la désactivent et la rendent visible comme telle.

Le délai de garde est de 10 secondes par source. Son timer est libéré après toute réponse,
y compris en erreur. Une collecte manuelle en échec remonte une erreur transitoire à la file ;
un cycle multi-source continue avec les autres sources.

## 4. Déduplication

La déduplication ne dépend d'aucun modèle :

1. identifiant externe au sein de la source ;
2. URL canonique au sein du projet ;
3. empreinte du titre et du contenu au sein du projet ;
4. similarité Jaccard déterministe des titres, seuil `0,85`, sur les 30 derniers jours.

Les paramètres de campagne et fragments sont retirés des URL, et leurs paramètres restants
sont triés. Deux sources qui relayent le même sujet ne créent ainsi qu'une news. Aucun
embedding, RAG ou rapprochement opaque n'est utilisé.

## 5. Scoring explicable

Le score final est borné de 0 à 100 :

```text
final = 30 % pertinence
      + 20 % fraîcheur
      + 20 % confiance de la source
      + 20 % correspondance projet
      + 10 % correspondance audience
```

La pertinence compare le texte aux catégories de la source et aux termes du projet. La
fraîcheur suit des paliers déterministes de 6 h, 24 h, 72 h et 7 jours. La confiance convertit
le niveau 1–5 en 20–100. Les correspondances projet et audience proviennent du nom, du
positionnement, des objectifs, des faits et des profils d'audience connus. Chaque composante
et chaque terme trouvé sont enregistrés et affichables via « Expliquer ».

Sous 35/100, l'item est conservé en `dismissed` avec le motif : aucune information n'est
silencieusement détruite.

## 6. Vérification et suggestions

La provenance, la date et jusqu'à trois affirmations extraites du résumé sont conservées.
L'état distingue `source_confirmed`, `needs_review`, `confirmed` et `disputed`. L'utilisateur
peut confirmer, marquer à vérifier ou contester depuis le détail. « Source confirmée » signifie
que l'entrée a réellement été récupérée, pas que toutes ses affirmations sont vraies.

« Créer une idée » produit une `EditorialSuggestion` déterministe : angle, plateforme,
urgence, projet, raison et durée de pertinence. Elle passe l'item en `shortlisted`, mais ne crée
ni `ContentVersion`, ni publication, ni contenu final.

## 7. Urgence

- `BREAKING` : score au moins 85 et fraîcheur au moins 90 ; fenêtre proposée de 6 h ;
- `HIGH` : score au moins 70 et fraîcheur au moins 70 ; fenêtre de 24 h ;
- `NORMAL` : cas courant ; fenêtre de 96 h ;
- `EVERGREEN` : catégorie evergreen ou faible fraîcheur ; fenêtre de 30 jours.

Les seuils sont du code testé et non une décision libre d'un LLM.

## 8. Calendrier et validation humaine

Une news peut proposer le déplacement d'un créneau appartenant au même projet. `LOCKED` est
refusé à la route. `FLEXIBLE` et `EVERGREEN` peuvent recevoir une proposition, mais le créneau
reste inchangé jusqu'à l'appel explicite de décision de l'étape 9. Un refus conserve le créneau
initial ; une acceptation applique seulement l'horaire proposé. La news elle-même n'est jamais
publiée automatiquement.

## 9. Jobs, fréquence et reprise

`collect_news` est idempotent, réseau, priorité 6, bail 2 minutes, trois tentatives et backoff
exponentiel de 5 puis 10 minutes. Le worker persiste un seau horaire dans `app_settings` pour
ne programmer qu'un cycle par heure, même après redémarrage. La fréquence réelle reste celle
de chaque source : 12 h par défaut, configurable de 2 à 168 h dans l'API. Le bouton manuel
permet une collecte ponctuelle sans rendre le planificateur agressif.

Les événements du job nomment lecture, erreur de source et bilan. Une révision monotone
persistée alimente le SSE `/events/news`; elle ne dépend pas d'une horloge ou d'une mémoire de
processus. Les items arrivés à expiration ou vieux de 30 jours passent à `expired`.

## 10. Interface et dashboard

La vue « News / Veille » affiche titre, source, date, catégories, score, urgence, projet,
statut de vérification et raison du score. Elle filtre par projet, urgence et catégorie, et
propose Voir, Ignorer, Créer une idée et Proposer dans le calendrier. Les contrôles ont une
hauteur tactile et les grilles se replient sur mobile.

Le dashboard affiche les actualités pertinentes des dernières 24 h, limitées aux scores d'au
moins 60, et ouvre directement la veille.

## 11. Budget et DeepSeek

La collecte, la normalisation, les dates, les URL, la déduplication, le classement et la
suggestion livrée ne consomment aucun jeton. `enrichWithinBudget` fournit le point d'extension
pour résumé, catégorisation ou angle LLM : il estime chaque appel, ne dépasse jamais le solde
transmis et place le reste en attente. Aucun enrichisseur payant n'est activé dans cette étape ;
il n'existe donc aucun chemin susceptible de contourner la comptabilisation de l'étape 8. Si
un enrichisseur DeepSeek est branché plus tard, il devra passer par le recorder et le budget
existants avant d'être enregistré en production.

## 12. Tests et E2E

Les tests couvrent RSS valide et invalide, timeout, santé provider, normalisation et URL
canonique, similarité, toutes les classes d'urgence, cinq composantes de score, suggestion,
budget insuffisant, retry/backoff, fréquence, source désactivée, relecture et doublon
cross-source, reprise par une nouvelle boucle de worker, SSE, migration peuplée, vérification,
`LOCKED`, `FLEXIBLE`, `EVERGREEN`, acceptation et refus.

Le parcours Playwright utilise un RSS local simulé et traverse : source → collecte → news
scorée affichée → idée → proposition sur un créneau flexible → acceptation humaine → heure
mise à jour dans le calendrier. Le contrôle mobile 360/390 px reste dans ce même parcours.

## 13. Bugs corrigés pendant l'étape

- la migration générée référençait des colonnes absentes de l'ancien schéma ; les copies ont
  été rendues ascendantes et l'ordre source/item protège maintenant les clés étrangères ;
- le timer de timeout des providers survivait à une réponse réussie ; il est désormais annulé ;
- le test de reprise construisait initialement la boucle trop tôt ; il instancie maintenant une
  nouvelle boucle après l'enqueue ;
- la configuration permettait l'ajout mais pas l'édition des catégories, de la fréquence et de
  la confiance ; les trois sont maintenant modifiables.

## 14. Décisions et limites

- D5 est tranchée en faveur de sauvegardes séparées : snapshots SQLite fréquents et médias
  immuables sauvegardés de façon incrémentale. Le volume média est potentiellement non borné ;
  le recopier avec chaque snapshot est un coût sans bénéfice. L'implémentation automatique de
  sauvegarde/restauration reste dans la consolidation prévue et ne fait pas partie du pipeline
  de veille.
- Pas de scraping HTML, moteur de recherche intégré ou dépendance à une API news payante.
- Pas de temps réel : une source ne descend pas sous deux heures.
- Pas de Viral Pattern Engine, analytics avancées, embeddings, RAG, analyse de commentaires,
  apprentissage de performance ou publication autonome ; ces sujets restent hors étape 10.
- Le seuil lexical peut manquer deux titres très reformulés. Ce faux négatif est préféré à un
  rapprochement opaque ou coûteux à cette étape.

