# Mise en œuvre — étape 9 : calendrier éditorial et planification

Ce document décrit ce qui est réellement livré à l'étape 9. Le calendrier
organise des versions déjà approuvées et réutilise sans raccourci le pipeline de
publication idempotent de l'étape 8. Il ne collecte aucune actualité.

## 1. Modèle et responsabilités

Deux tables sont ajoutées par la migration `0008_foamy_chameleon.sql` :

- `calendar_slots` conserve l'intention humaine : version, compte, plateforme,
  instant canonique, fuseau, rigidité, état et liens vers publication/job ;
- `calendar_change_proposals` conserve une suggestion et sa décision. Créer une
  proposition ne modifie jamais le créneau.

Les sources de vérité sont séparées volontairement :

| Question | Source autoritative |
| --- | --- |
| Quand et avec quelle rigidité publier ? | `CalendarSlot` |
| Quel est l'état de l'effet distant ? | `Publication` et ses tentatives |
| Quand et comment exécuter/reprendre ? | `Job` et son lease |

Le statut du créneau est une projection utile à l'écran (`scheduled`, `due`,
`publishing`, `published`, `manual_required`, `cancelled`, `missed`, `failed`).
Le worker la synchronise avec les transitions de publication. Cette projection
ne remplace ni l'historique des tentatives ni la machine de la file.

Une annulation est logique : le créneau et la publication sont conservés, le job
encore en attente est annulé, et la version de contenu n'est pas supprimée.

## 2. Rigidités

- `LOCKED` interdit même la création d'une proposition de déplacement ;
- `FLEXIBLE` accepte une proposition, mais seule son acceptation la rend réelle ;
- `EVERGREEN` suit la même règle à cette étape et indique qu'un déplacement futur
  sera généralement moins risqué.

Il n'existe aucun déplacement automatique. L'API métier sait créer, lister,
accepter ou refuser une `CalendarChangeProposal`, ce qui prépare l'adaptatif sans
implémenter l'étape 10.

## 3. Date locale et fuseau

L'interface accepte `YYYY-MM-DD`, `HH:mm` et un identifiant IANA configurable
(`Europe/Paris` par défaut dans l'environnement courant). Le domaine convertit
ce triplet vers un epoch en millisecondes, stocké comme instant canonique, tout
en conservant le fuseau du créneau pour la restitution.

La conversion ne dépend ni du fuseau du processus ni d'un pays codé en dur. Les
offsets non entiers, comme `Asia/Kolkata`, sont couverts. Une heure inexistante
ou répétée lors d'un changement d'heure est refusée plutôt que résolue
silencieusement. L'utilisateur choisit alors une autre heure non ambiguë.

## 4. Création et modification d'un créneau

`POST /api/calendar/slots` vérifie avant l'enregistrement :

1. que la version existe, est la version approuvée courante et n'est pas archivée ;
2. que le compte appartient au projet et correspond à la plateforme du contenu ;
3. que la date locale existe, se convertit et se trouve dans le futur ;
4. que cette version n'est pas déjà active pour ce compte.

L'API crée une `Publication` avec sa clé d'idempotence de l'étape 8, un job
`publish_content` futur, puis le `CalendarSlot` qui les référence. Déplacer un
créneau met à jour le même slot, la même publication et le même job. Changer la
rigidité, annuler et publier maintenant sont également persistés.

## 5. Scheduler et jobs dus

Le job garde `scheduledFor`/`availableAt` dans la file existante. À chaque tour,
le worker procède dans cet ordre :

1. reprendre les leases expirés ;
2. classer les créneaux échus en `due` ou `missed` ;
3. promouvoir les jobs dont l'heure est atteinte ;
4. réserver atomiquement les jobs exécutables ;
5. exécuter le handler idempotent de l'étape 8.

La file refuse donc un job futur lors du `claim`. À l'heure exacte, le même job
devient disponible ; les leases, la clé de déduplication et le verrou de
publication continuent de garantir une seule exécution distante.

Un report décidé par le frein de budget ou un connecteur crée un nouveau job de
retry avec une clé propre. Le calendrier remplace alors sa référence par ce
nouveau job : annulation, déplacement et publication immédiate restent cohérents
après le report.

## 6. Redémarrage et retard

La politique retenue est simple et déterministe :

- retard de 0 à 15 minutes inclus : le slot passe `due` et le pipeline normal
  peut l'exécuter ;
- retard supérieur à 15 minutes : le slot passe `missed`, le job futur est
  annulé et aucune publication distante n'est tentée.

Après un redémarrage, le premier tour applique cette règle depuis SQLite. Un
créneau `missed` expose « Publier maintenant » et peut aussi être replanifié.
Il n'y a donc pas de publication silencieuse vingt minutes après l'heure prévue.

## 7. Conflits et cadence

Un avertissement apparaît quand un autre créneau actif se trouve à moins de
30 minutes : il distingue le même compte d'une simultanéité multi-comptes. Il
n'empêche pas la décision humaine.

La cadence recommandée est configurable par plateforme (1/jour par défaut pour
LinkedIn, TikTok, YouTube et Reddit, borne 1–20). Un dépassement produit un
message, jamais un refus. Les calculs de jour utilisent le fuseau du créneau.

## 8. Publication immédiate

« Publier maintenant » ne crée ni nouvelle publication ni second job. La même
publication revient à `planned`, le même job à `queued`, et son échéance devient
immédiate. Le worker reprend ensuite exactement le handler, les verrous, les
budgets, les niveaux A/B/C et les règles d'ambiguïté de l'étape 8.

## 9. Interface calendrier et dashboard

Le calendrier propose Aujourd'hui, Demain et Cette semaine, cette dernière étant
un horizon glissant de sept jours afin que demain reste visible le dimanche. Chaque carte affiche
l'heure locale, la plateforme, le contenu, le projet, le compte, la rigidité,
le statut, les conflits et les actions utiles. Le formulaire permet de choisir
projet, version approuvée, compte compatible, date, heure et rigidité.

La vue Aujourd'hui résume le nombre de publications prévues, la prochaine
échéance, les retards, conflits, contenus à valider et contenus approuvés non
planifiés, puis ouvre le calendrier en un clic.

Les grilles se replient en cartes verticales ; les actions font au moins 44 px de
haut. Le parcours navigateur contrôle 360 px, 390 px et la largeur desktop, sans
débordement horizontal.

## 10. Mise à jour SSE

`GET /api/events/calendar` émet un snapshot puis `calendar_changed` lorsque la
révision du calendrier avance. Le navigateur invalide alors les requêtes TanStack
concernées. Il n'effectue aucun polling agressif du calendrier ; le contrôle
léger de révision est maintenu côté serveur et la connexion est fermée proprement
quand la vue est démontée.

Les transitions `due`, `publishing`, succès, échec, modification et annulation
écrivent toutes `updated_at`, ce qui déclenche l'invalidation.

## 11. Tests réalisés

Les tests unitaires couvrent la conversion Paris/Kolkata, les trous et ambiguïtés
DST, conflits, rigidités et cadence. Les tests d'intégration couvrent création,
refus métier, déplacement, annulation, propositions acceptée/refusée, `LOCKED`,
horloge contrôlée, absence d'exécution anticipée, promotion exacte, retard,
`missed`, redémarrage logique, publication immédiate et absence de doublon.

Le parcours E2E utilise un connecteur scripté : version approuvée → demain 10 h
→ `FLEXIBLE` → semaine → déplacement à 11 h → publication immédiate → `published`,
avec une seule tentative et un seul job. Aucun appel réseau de publication réel
n'est effectué.

## 12. Bugs corrigés pendant l'étape

- un retry de publication pouvait conserver dans le calendrier la référence de
  l'ancien job ; le nouveau job est désormais enregistré ;
- la vue recharge désormais aussi le fuseau et les cadences après sauvegarde ;
- le parcours E2E cible le projet par identifiant stable et non par un libellé
  accessible susceptible d'être recalculé pendant le rendu.

## 13. Décisions et limites

- SQLite reste le coordinateur local : pas de Redis ni de service scheduler ;
- le worker doit tourner pour promouvoir et exécuter ; une machine arrêtée suit
  la politique de retard au prochain démarrage ;
- le déplacement rapide est un formulaire embarqué, pas du glisser-déposer ;
- les conflits et cadences sont consultatifs ;
- une sortie niveau B/C devient `manual_required`, elle n'est pas présentée comme
  publiée ;
- une ambiguïté distante reste une décision humaine, conformément à l'étape 8 ;
- le fuseau est une préférence utilisateur globale, tout en restant copié sur
  chaque slot pour préserver son interprétation historique ;
- le SSE signale une invalidation, pas un journal d'événements durable ;
- aucune veille, aucun RSS, scraping, scoring de news, remplacement automatique,
  RAG, embedding, analytique d'apprentissage, promotion payante ou cloud n'est
  ajouté.

## 14. Ce qu'il ne faut PAS construire à ce stade

Ne pas ajouter l'Agent News, une ingestion RSS/web, un Viral Pattern Engine, un
déplacement autonome, un moteur d'optimisation analytique, du RAG, des embeddings
ou une infrastructure cloud. L'étape 9 livre uniquement le calendrier et ses
primitives humaines.
