# 18 — Mise en œuvre de l'étape 8 (publication par API et budget)

> Compte rendu de ce qui est **réellement** livré pour l'étape 8 : `docs/05` §8
> (pipeline de publication), `docs/06` (connecteurs et idempotence), `docs/03`
> §4.4 et §11 (plafonds, publications, tentatives) et le périmètre de `docs/10`
> §4.8. La **collecte de métriques** n'est pas dans cette livraison : seules ses
> tables existent, et c'est dit explicitement (§3 et §12).

## 1. Résultat livré

Un contenu **approuvé** peut être publié par API là où c'est acquis, avec une
idempotence stricte et un plafond de dépense opposable :

```text
contenu approuvé + compte (platform_accounts)
  → POST /content/:contentId/publications   (version approuvée exigée, même projet/plateforme)
  → ligne publications + job publish_content (dédupliqué par publication)
  → worker : état tranché ? → budget ? → verrou en base → validation locale → envoi
  → table de décision (docs/06 §9.1) : publié / brouillon / reporté / échoué
  → POST /publications/:id/decision          (seul chemin de sortie d'une ambiguïté)
```

Cinq garanties structurent cette chaîne, chacune prouvée par un test :

- **aucun doublon après une reprise forcée** : c'est le critère de sortie n° 1 de
  l'étape 8 (docs/10 §4.8). Une seconde exécution du job retrouve une publication
  déjà tranchée et **ne repose pas** la question à la plateforme ;
- **une ambiguïté se vérifie, elle ne se rejoue pas** : `verifyPublished()` d'abord,
  décision humaine si la plateforme ne sait pas répondre (docs/05 §8.3) ;
- **un dépassement de budget retient** la publication (elle est reprogrammée)
  au lieu de la détruire (docs/11 §2.7) ;
- **le niveau de publication est décidé AVANT l'appel** : pas de niveau A pour une
  plateforme non acquise ; sinon, **repli automatique en niveau C** (paquet manuel) ;
- **rien n'écrit jamais un jeton dans un journal** : le client HTTP rédige, et le
  connecteur ne stocke aucun secret (docs/07 §9.1).

## 2. Les trois niveaux, et la décision prise avant l'appel

| Niveau | Moyens | Comportement | Implémentation |
|---|---|---|---|
| **A — API officielle** | OAuth + POST de l'API | Automatique, avec clé d'idempotence | `packages/publishing/src/linkedin.ts` |
| **B — brouillon distant** | API qui crée un brouillon | Automatique jusqu'au brouillon, publication finale manuelle | `createDraft()` LinkedIn (`lifecycleState: DRAFT`) |
| **C — paquet local** | `manual_packages` | Manuel, préparé en un clic | `packages/publishing/src/manual.ts` |

Le niveau n'est **pas** une propriété du produit mais **de la capacité réellement
acquise** par le compte : `resolvePublishMode()` (dans `capabilities.ts`) plafonne
le niveau déclaré par les drapeaux réels (`directPublish`, `draft`), et
`resolveConnectorForAccount()` retombe en niveau C quand l'implémentation manque,
quand le compte n'est pas `connected`, ou quand ses capacités ne permettent pas
d'écrire. C'est l'application directe de l'interdit de docs/10 §4.8 : « pas de
niveau A pour une plateforme non acquise ».

## 3. Données : ce que la migration `0007` ajoute, et pourquoi

docs/10 §4.8 annonce **quatre tables** : `budget_limits`, `learnings`,
`metric_snapshots`, `performance_patterns`. Elles arrivent à l'étape 8 — et pas à
l'étape 11 — parce qu'à partir d'ici le système agit **seul vers l'extérieur** :
les garde-fous (budgets) doivent exister **avant** la première publication, et les
réceptacles des mesures futures ne coûtent rien à créer vides. Un système qui
collecte avant d'analyser ne perd rien ; l'inverse est impossible (docs/10 §4.8).

- **`budget_limits`** — `scope` (`global`/`project`/`task`), `scope_ref`, `period`
  (`day`/`week`/`month`), `limit_micro_usd`, `hard_stop`. Un `CHECK` interdit un
  `scope_ref` vide hors `global`. C'est la table qui rend opposable un plafond
  « 0,50 $/jour pour la publication » ;
- **`learnings`**, **`metric_snapshots`**, **`performance_patterns`** — les trois
  réceptacles de la boucle d'apprentissage (étape 11). Ils sont listés par **nom
  SQL** dans `REQUIRED_TABLE_NAMES` (`packages/database/src/schema/index.ts`) :
  c'est précisément quand une table n'a **aucun** pipeline qui la lit qu'elle peut
  disparaître d'une migration sans que personne ne le voie.

`db:generate` ne produit rien après coup : la migration et l'instantané
(`meta/0007_snapshot.json`) correspondent au schéma.

## 4. Le handler `publish_content` : quatre verrous, dans l'ordre

Le handler (`apps/worker/src/handlers/publish-content.ts`) est dominé par une
seule question : *que se passe-t-il si on ne sait pas si ça a marché ?* Il possède
**quatre verrous**, et l'ordre est ce qui compte :

| Ordre | Verrou | Ce qu'il empêche |
|---|---|---|
| 1 | **État déjà tranché** (`forbidsRemoteCall`) | Reposer la question à la plateforme sur une publication `published`, `manual_required`, `ambiguous` ou `needs_human_decision`. C'est ce qui rend 20 reprises forcées inoffensives |
| 2 | **Budget** (`budgetBrake`) | Dépenser sans autorisation : un plafond atteint **retient** la publication (`status='planned'` + reprogrammation), il ne la détruit pas |
| 3 | **Verrou en base** (`claimForPublish`) | Deux jobs concurrents qui publieraient tous les deux : le passage à `publishing` est un `UPDATE … WHERE status IN ('planned','queued')` **conditionnel** |
| 4 | **Validation locale** (`validateContent`) | Un refus détecté ici coûte zéro quota et zéro tentative distante — et il est explicable en une phrase |

Ce qui n'est **pas** décidé ici : la politique de reprise. Le handler lève une
erreur typée (`TransientError` sur 5xx), et la file applique la règle
(`packages/queue/src/retry-policy.ts`, docs/02 §12). La **table de décision** de
docs/06 §9.1 est écrite en code (`PUBLISH_REACTIONS`, `packages/publishing/src/idempotency.ts`) :
le handler lit `reactionFor(result.outcome)` et exécute, il n'interprète rien.

## 5. Le cas `ambiguous` : vérifier, jamais rejouer

C'est **la** décision la plus importante du pipeline (docs/05 §8.3). Deux
situations y mènent, et les deux passent par `resolveAmbiguity()` :

1. le processus précédent est mort **entre l'envoi et la confirmation** (reprise
   après crash : la publication est restée en `publishing`) ;
2. le connecteur vient de répondre `ambiguous` (timeout après envoi, 2xx sans
   identifiant exploitable).

La règle est unique : **on ne rejoue pas un POST ambigu, on pose la question à la
plateforme** (`verifyPublished()`). Trois issues :

- la plateforme **confirme** le contenu en ligne → réglé `published`, sans republier ;
- la plateforme répond « rien ici » (`verifiable: true, found: false`) → rejouer est
  sans risque de doublon, la publication est reprogrammée ;
- la plateforme **ne sait pas répondre** (`verifiable: false`) → on ne devine pas :
  `status='ambiguous'`, `needs_human_decision=1`, et une **décision humaine** est
  requise (`POST /publications/:id/decision`).

`verifyPublished()` peut donc répondre « je ne sais pas » — c'est une réponse de
première classe : prétendre vérifier serait pire que ne pas vérifier (docs/06 §3.3,
§9.2).

## 6. Le frein de budget : retenir, pas détruire

`evaluateBudgetBrake()` (`packages/analytics/src/limits.ts`) examine **toutes** les
contraintes applicables (global jour/semaine/mois, projet, tâche) et retient la
**plus contraignante**. Un plafond dur (`hard_stop = 1`) **retient** la
publication ; un plafond souple documente sans empêcher.

Dans le handler, un frein déclenché **reprogramme** la publication
(`status='planned'` + `reschedule`) au lieu de la perdre : le travail repart avec
un budget neuf le lendemain (docs/11 §2.7). Le coût estimé d'une publication vient
de `PUBLISH_ESTIMATED_COST_USD` (`0` par défaut : publier par API ne consomme pas
de jeton), donc le frein porte réellement sur les plafonds de projet et de tâche.

## 7. Les connecteurs

`packages/publishing` est de l'**infrastructure** : il ne connaît pas le domaine et
ne décide de rien.

- **`capabilities.ts`** — le contrat `PlatformConnector` **au-delà de l'interface** :
  chaque capacité affirmée porte sa **source** et sa **date** (`verification`), et
  `verifyPublished()` est distinct de `publish()` ;
- **`manual.ts`** — le niveau C de **toutes** les plateformes : un paquet prêt à
  coller (texte + hashtags séparés + checklist). Il ne publie rien par API, par
  construction ;
- **`linkedin.ts`** — niveau A/B. `interpretLinkedInResponse()` est une fonction
  **pure** qui traduit la réponse HTTP en issue métier (docs/06 §9.1) : c'est ce
  qui rend la table d'erreurs testable ligne par ligne, sans publier. La version
  d'API (`LINKEDIN_API_VERSION`) est **exigée à l'exécution**, jamais écrite en
  dur (LinkedIn déprécie ses versions) ;
- **`oauth.ts`** — OAuth 2.0 à code d'autorisation **avec PKCE** : le
  `client_secret` n'apparaît jamais dans l'URL d'autorisation (docs/07 §6.3) ;
- **`http-client.ts`** — client partagé : il enregistre l'horodatage du dernier
  octet envoyé, ce qui distingue « timeout **avant** envoi » (sûr) de « timeout
  **après** envoi » (ambigu). Il rédige tout ce qui sort ;
- **`simulated.ts`** — le connecteur de test, **scriptable et compteur** : il
  enregistre une ligne par contenu réellement publié, ce qui permet d'affirmer
  « une seule publication distante après N exécutions ».

## 8. Idempotence : trois protections qui ne se remplacent pas

Le doublon de publication est le **pire défaut possible** du produit : il est
public et irréversible (docs/10 §4.8). Trois protections le rendent impossible, et
elles opèrent à trois niveaux différents :

1. **`uq_publication_version_account`** — une seule ligne par (version, compte) :
   une contrainte **de base de données**, donc incontournable par un bug applicatif ;
2. **`uq_publication_idempotency`** + clé locale
   (`publicationIdempotencyKey`, `sha256(version + compte + grain de 30 min)`) :
   deux clics rapprochés produisent la même clé, donc la même ligne ;
3. **la table de décision** (`reactionFor`) : un résultat ambigu ne se rejoue pas,
   il se vérifie puis se tranche. C'est la protection qui reste utile quand la
   plateforme n'accepte pas la clé.

Enfin, la file ajoute une quatrième barrière : le job `publish_content` porte une
clé de déduplication `publish:<publicationId>`, donc deux déclenchements rapprochés
produisent **un** job.

## 9. L'API : déclencher, lire, trancher

`apps/api/src/routes/publishing.ts` expose trois routes nouvelles (l'API **enfile**,
le worker **exécute**) :

| Route | Rôle | Refus avant mise en file |
|---|---|---|
| `POST /content/:contentId/publications` | « publier maintenant » : crée la publication et enfile le job (202) | version approuvée courante exigée (409) ; compte du même projet et de la même plateforme (409) |
| `GET /content/:contentId/publications` | lire les publications d'un contenu **et leurs tentatives** | — |
| `POST /publications/:id/decision` | trancher une ambiguïté : `published` / `retry` / `abandon` | la publication doit attendre une décision humaine (409) |

Un `scheduledFor` futur **n'exécute rien à l'avance** : le job est créé avec sa
date (`delayMs`), et le planificateur de l'étape 9 le promeut à l'échéance
(docs/05 §8.4).

## 10. Ce que les tests prouvent, et par quel test

| Garantie | Test |
|---|---|
| Une seule publication distante après une reprise forcée | `tests/integration/publishing-handler.test.ts` — « ne republie pas sur une reprise forcée » |
| Une ambiguïté se vérifie (retrouvé → publié ; non vérifiable → décision humaine) | idem — « le cas ambigu » |
| Un dépassement de budget **retient** au lieu de détruire (aucun appel distant) | idem — « budget » |
| Chaque issue de la table de décision produit l'état attendu (refus, 429, niveau B) | idem — « refus et report », « niveau B » |
| La table d'erreurs LinkedIn, ligne par ligne | `packages/publishing/src/contracts.test.ts` |
| OAuth : PKCE, pas de `client_secret` dans l'URL, échange et rafraîchissement | idem |
| L'API crée une publication, n'enfile **qu'un** job, refuse un contenu non approuvé | `tests/integration/publishing-api.test.ts` |
| Une décision humaine est le seul chemin de sortie d'`ambiguous` | idem |
| La migration `0007` couvre les quatre tables attendues | `tests/integration/migrations.test.ts` |

## 11. Décisions prises en chemin

| # | Décision | Pourquoi |
|---|---|---|
| M1 | Le niveau est décidé **avant** l'appel (`resolveConnectorForAccount`) | Un `catch` ne décide pas : le repli en niveau C est une décision prise **avant** d'envoyer, jamais un rattrapage d'erreur |
| M2 | `verifyPublished()` rend `verifiable: false` comme réponse normale | Prétendre vérifier serait pire que ne pas vérifier ; LinkedIn ne permet pas de relire les posts d'un compte membre |
| M3 | Le handler lève `TransientError` sur 5xx au lieu de décider d'un retry | « Un handler ne décide pas de la politique de reprise » (docs/02 §12) |
| M4 | La publication retenue par le budget est **reprogrammée**, pas annulée | Le travail repart avec un budget neuf (docs/11 §2.7) |
| M5 | Le connecteur simulé **compte** ses posts | Sans compteur, on ne peut pas prouver « un seul doublon » |
| M6 | `LINKEDIN_API_VERSION` sans valeur par défaut | Figer une version serait périmé à une date connue (dépréciation LinkedIn) |
| M7 | Un job créé pour une date future n'est **pas** exécuté à l'avance | La fenêtre de tir est l'affaire de l'étape 9 |

## 12. Ce qui n'a **pas** été construit, et pourquoi

- **Le parcours OAuth « connecter un compte LinkedIn » côté API** (stockage du
  `state`, route de rappel `/oauth/callback/{provider}`, échange du code) : le
  paquet `@aia/publishing` **fournit** `buildAuthorizationUrl` et
  `exchangeAuthorizationCode` (testés), mais l'API ne les branche pas encore. Il
  manque une table de `state` à usage unique et une redirection **HTTPS** (contrainte
  réelle, notée dans docs/06 §10.3 et docs/07 §6.2) : c'est l'incrément suivant, et
  il est volontairement isolé pour ne pas coupler la publication à un flux externe
  non vérifiable de bout en bout en local ;
- **Le rafraîchissement de jeton dans le worker** : `resolveCredentials()` calcule
  `needsRefresh` (fenêtre de 24 h, docs/06 §4.3) mais l'action de rafraîchir n'est
  pas câblée — un jeton expiré produit un `auth_error` → compte `expired` → décision
  humaine, ce qui est sûr mais moins confortable ;
- **La collecte de métriques** (`metric_snapshots`) : la table existe, le pipeline
  arrive à l'étape 10/11 ;
- **Le niveau A pour une plateforme non acquise** (YouTube, Reddit, TikTok) : interdit
  par docs/10 §4.8 ; ils restent en niveau C ;
- **L'écran de publication** (`apps/web`) : le contrat HTTP existe, l'interface
  arrive avec l'écran de calendrier (étape 9).

## 13. Points ouverts

- **`LINKEDIN_API_VERSION` doit être choisie** avant toute publication niveau A ;
  tant qu'elle est vide, les comptes LinkedIn restent en niveau C ;
- **Redirection OAuth en HTTPS** : LinkedIn l'exige pour une application
  enregistrée, ce qui complique un flux purement local (docs/07 §6.1) ;
- **Décision D4** (fréquence de collecte des métriques) : tranchée en code par
  défaut à `24` h (`METRICS_COLLECT_INTERVAL_HOURS`), à reconfirmer quand des
  quotas réels seront mesurés.

## 14. Définition de terminé

- [x] Quatre tables créées (migration `0007`), listées dans `REQUIRED_TABLE_NAMES`.
- [x] Contrat `PlatformConnector` étendu (capacités vérifiées, `verifyPublished`).
- [x] Connecteurs : niveau C (toutes), A/B (LinkedIn), simulé (tests).
- [x] Handler `publish_content` avec les quatre verrous et la table de décision.
- [x] Frein de budget opposable, qui **retient** au lieu de détruire.
- [x] Routes API : déclencher, lire, trancher.
- [x] **Aucun doublon** après reprise forcée (test d'intégration).
- [x] `tsc`, `eslint`, `pnpm test` (548), `db:check-migrations`, `check:boundaries`,
  `check:canary`, `check:env` : tout est vert.
- [ ] Parcours OAuth de bout en bout (incrément suivant, §12).
