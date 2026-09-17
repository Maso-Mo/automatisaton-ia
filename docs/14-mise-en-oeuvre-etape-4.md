# 14 — Mise en œuvre de l'étape 4 (génération éditoriale)

> Ce document raconte ce qui a été **réellement** construit à l'étape 4, les décisions
> prises en chemin, ce qui n'a **pas** été construit et pourquoi, et ce que les tests
> couvrent. À lire après [`10-plan-de-developpement-12-etapes.md`](10-plan-de-developpement-12-etapes.md)
> §4.4, pas avant.

---

## 1. Ce qui existe maintenant

L'utilisateur demande un **plan** d'après sa mémoire vérifiée, choisit **un angle**, et le
worker écrit **un lot de textes** — un par plateforme, dans un seul appel. Il relit, corrige à
la main, régénère une cible, approuve ou rejette. Chaque écriture est une **version conservée** ;
rien n'est publié, rien n'est déclaré « vérifié ».

| Fonctionnalité | Où |
|---|---|
| Plan éditorial **synchrone** (3 à 5 sujets × 2 à 3 angles), ancrage vérifié | `packages/core/src/editorial/plan.ts`, `packages/ai/src/agents/strategist.ts` (tâche `angles`), `apps/api/src/features/editorial.ts` |
| Valeurs de chaque cible : limite dure, budget visé, titre, hashtags, chapitres | `packages/shared/src/content-targets.ts` |
| **Un appel, N textes** : règles communes + une section par cible demandée | `packages/ai/src/agents/platform-writer.ts`, `prompts/platform_writer/rules.md` |
| Contrôle **local** des longueurs et de la forme, régénération ciblée | `packages/core/src/editorial/validation.ts` |
| Versions immuables, machine à états, approbation tracée, plafond de régénérations | `packages/core/src/editorial/content.ts`, migration `0003` (déclencheurs SQL) |
| Le job `generate_content` : contexte, écriture, contrôle, enregistrement | `packages/queue/src/job-specs.ts`, `apps/worker/src/handlers/generate-content.ts`, `apps/worker/src/features/platform-writer.ts` |
| L'API éditoriale : 13 routes (plan, sujets, angles, contenus) | `apps/api/src/routes/editorial.ts` |
| La **matière** d'un rédacteur (faits confirmés, compétences, voix, audience) | `packages/core/src/projects/writer-memory.ts`, `packages/ai/src/memory-pack.ts` |
| Les prompts du rédacteur, versionnés et synchronisés en base | `prompts/platform_writer/{rules,linkedin,reddit,tiktok,youtube_short,youtube_long}.md` |
| Un job peut être **enfilé** par l'API sans être exécutable par elle | `packages/queue/src/types.ts` (`JobSpec` ⊂ `JobDefinition`), `registry.registerSpec()` |

**La base grandit de 10 tables** : les 8 de l'étape 4 (`content_items`, `content_versions`,
`content_claims`, `content_review_notes`, `video_renders`, `errors`, `system_health`,
`notifications`) **plus** les 2 de l'étape 3 restées en arrière — `content_subjects` et
`subject_angles`, qui portent le plan et attendaient cette migration pour exister. La liste
attendue au démarrage (`REQUIRED_TABLE_NAMES`) passe donc de 17 à **27 tables**, et la migration
`0003` ajoute **5 déclencheurs** : immuabilité d'une version, cohérence de `current_version_id`,
et les trois gardes des affirmations (`content_claims`).

**Numérotation.** Le plan place « Sujets, angles et entrée média » en étape 3 et « Génération
éditoriale » en étape 4 ; ce lot, intitulé « étape 4 », couvre les **sujets et angles** (étape 3
du plan) **puis** l'**écriture multi-plateformes** (étape 4 du plan). Ce que le plan promettait à
l'étape 3 et qui n'est **pas** là : l'entrée média et la transcription (voir §3).

---

## 2. Décisions prises pendant l'implémentation

Ces points n'étaient pas tranchés par la documentation, ou l'étaient partiellement. Ils sont
consignés ici parce qu'une décision non écrite n'existe pas (docs/11 §2).

| # | Décision | Pourquoi | Alternative écartée |
|---|---|---|---|
| **M1** | Le **plan est synchrone** dans l'API ; la **rédaction est un job** | C'est la répartition de `docs/05 §10.1` : le plan dure quelques secondes et l'utilisateur veut voir les sujets ; écrire cinq textes doit survivre à un redémarrage | Un job aussi pour le plan : une file, un lease et un polling pour un appel court |
| **M2** | **Un appel par lot**, jamais un appel par plateforme | Le sujet, l'angle, la voix et les faits sont identiques : cinq appels enverraient cinq fois le même contexte et coûteraient cinq fois le prix d'entrée (docs/04 §4.3) | Un appel par cible, « plus simple à paralléliser » |
| **M3** | L'**ancrage factuel est vérifié en code**, mot à mot, contre les faits fournis | Un modèle ne sait pas ce qu'il a inventé. Les `evidence` sont des **extraits**, jamais des identifiants — demander un identifiant en fait inventer. La comparaison ignore casse, accents et ponctuation, avec un seuil de recouvrement de jetons à `0,5` | Faire confiance à la phrase du prompt « ne cite que les faits fournis » |
| **M4** | Le **score** d'un sujet et d'un angle est **calculé localement** | Un modèle qui s'auto-note produit un classement qui ne veut rien dire. La formule (pilier, couverture de compétence, fraîcheur, diversité, pénalité de répétition) est écrite en clair, reproductible et testable | Demander un `score` au modèle — docs/03 §8.3 le liste sans en fixer la formule |
| **M5** | Un sujet non ancré est **rejeté avec ses raisons** ; un angle non ancré est **écarté** sans faire tomber son sujet ; un plan intégralement non ancré lève `PLAN_UNGROUNDED` | « 2 sujets sur 5 n'ont pas été retenus, voici pourquoi » vaut mieux qu'un plan silencieusement plus court ; et un plan vide enregistré ferait croire à une absence de matière | Filtrer en silence, ou enregistrer ce qui reste sans le dire |
| **M6** | Les **limites chiffrées vivent dans le code** et sont **injectées** dans le prompt au moment de le construire | Une limite recopiée dans un `.md` finit toujours par diverger du contrôle qui la vérifie après génération — et c'est le code qui a raison | Écrire « 3 000 caractères » dans `linkedin.md` |
| **M7** | Le contrôle de forme distingue **bloquant** et **avertissement** | Bloquant : la plateforme refuserait le texte (trop long, titre manquant, chapitres absents, marqueur de gabarit resté). Avertissement : le texte passera, mais il est moins bon — et on ne paie **pas** un appel pour un avertissement | Un seul niveau : soit on bloque trop, soit on ne signale rien |
| **M8** | Une régénération automatique **par cible**, une seule fois (`REGENERATION_ATTEMPTS_PER_TARGET = 1`), et `MAX_REGENERATIONS_PER_ITEM = 3` par contenu | Régénérer coûte cher : on ne régénère que ce qui a échoué, jamais en boucle. Au-delà de trois fois, le problème est dans l'angle ou dans la fiche, pas dans le texte | Régénérer le lot entier, ou régénérer indéfiniment |
| **M9** | **Une version ne se modifie pas** : édition, régénération et correction créent une ligne | C'est ce qui rend le retour en arrière possible et « pourquoi ce texte ? » répondable (docs/03 §9.2). La règle est tenue par la **base** (`trg_content_versions_immutable`), pas seulement par le code | Un `UPDATE` sur la version courante : plus simple, et l'historique disparaît |
| **M10** | La machine à états est une **table explicite**, et `generated → approved` en est **absent** | Une route oubliée ne peut pas produire une approbation sans passage par la relecture. Les **trois écarts assumés** du diagramme de docs/03 §9.1 sont commentés dans le code (retours en arrière d'une régénération, archivage depuis presque tous les états), et docs/03 §9.1 porte désormais un renvoi vers cette table | Une suite de `if` dispersés dans les routes |
| **M11** | La **preuve** d'approbation est `approved_version_id`, pas l'état | Régénérer un contenu approuvé **efface** l'approbation : approuver un texte puis en écrire un autre ne peut pas passer inaperçu (docs/05 §4.3) | Se fier à `state = 'approved'` |
| **M12** | `JobSpec` (ce qu'il faut pour **accepter** un job) est séparé de `JobDefinition` (spec + handler) ; l'API n'enregistre qu'une **spec** | L'API enfile, le worker exécute (docs/02 §3). Les deux partagent une définition unique — jamais recopiée — mais seul le worker possède le handler | Deux schémas d'entrée recopiés : la première divergence serait invisible |
| **M13** | Un job de régénération porte le **`contentItemId`** exact et **une seule** cible | Sans lui, une régénération devinerait sa cible par le couple (angle, plateforme) et se tromperait dès qu'un angle a deux contenus. Avec une cible unique, le rédacteur ne voit jamais les autres plateformes | Retrouver le contenu par (angle, plateforme) |
| **M14** | La **consigne** de réécriture est transmise telle quelle, et le **texte refusé** est renvoyé au modèle pour la réécriture ciblée | C'est la parole de l'utilisateur : le produit ne la réécrit pas. Et repartir de zéro réintroduit les mêmes défauts (docs/04 §4.3) | Reformuler la consigne « proprement », ou repartir de l'angle seul |
| **M15** | **On refuse avant de payer** : fiche maître validée, angle choisi, prompts présents, lignes de contenu créées — tout cela **avant** l'appel au modèle | Un refus coûte zéro ; un job qui échoue après l'appel coûte une tentative et un appel | Valider après l'appel, « pour aller plus vite » |
| **M16** | `content_claims` reste **vide** et le contrôle local n'est **pas stocké** : il est recalculé à la lecture | Aucune affirmation n'est « vérifiée » avant l'étape 5 (docs/10 §4.4). Et une colonne de validation conservée mentirait dès la première mise à jour des limites de plateforme : recalculer juge le texte avec la règle d'aujourd'hui | Persister le contrôle dans une colonne `validation_json` |
| **M17** | `providerApiKey()` et `llmModelFor()` vivent dans `packages/config`, une fois pour toutes | C'est le seul paquet qui connaît les variables d'environnement (docs/02 §11). Le recopiage produirait un job qui part sans clé pendant que la conversation fonctionne | Lire `process.env` dans la fabrique du worker |
| **M18** | Un **angle désigne une cible** ; `platform_hint` reste une **note** transmise au modèle, jamais un filtre | Une cible est une clé de sortie (`linkedin_post`…), pas une plateforme : le modèle doit écrire exactement les cibles demandées. Le `platform_hint` de l'angle est informatif (« cet angle vise un post court »), et le transformer en contrainte interdirait de réutiliser un bon angle ailleurs | Déduire les cibles du `platform_hint` de l'angle |
| **M19** | L'édition manuelle **remplace le corps en entier** et pose `humanEdited` + `editRatio` | Une édition partielle demanderait des ancres, donc un diff, ce que le produit ne promet pas. Le ratio mesure **combien** le texte a changé : c'est le proxy d'utilité réelle du modèle, et le signal que l'étape 11 exploitera (docs/03 §9.1) | Un `PATCH` partiel par phrase |
| **M20** | L'**empreinte de prompts** journalisée est celle du **lot entier** (« règles + sections des cibles demandées ») | Modifier le prompt d'une seule plateforme crée donc une nouvelle version de contenu, et un lot rejoué à l'identique porte la même empreinte : la traçabilité reste exacte (docs/04 §4.3, mis à jour par cette étape) | Une empreinte par plateforme, donc un appel aux propriétés mélangées |

---

## 3. Ce qui n'a pas été construit, et pourquoi

| Écarté | Pourquoi | Quand il arrive |
|---|---|---|
| **Tout écran web** : relecture, comparaison de versions, choix d'angle | Le périmètre de ce lot est la chaîne **API + worker + domaine** ; `docs/10 §4.4` place l'écran de revue dans la même étape, mais l'interface ne se teste pas sans navigateur (aucun E2E n'existe : `scripts/e2e.ts` le dit et échoue si un parcours apparaît sans Playwright) | Étape qui introduit le parcours E2E « conversation → contenu » |
| **Vérification des affirmations** (`critic`, `fact_checker`, `content_claims` rempli) | `docs/10 §4.4` l'exclut explicitement : à cette étape le produit écrit et l'utilisateur valide. Les **tables et les gardes existent déjà** (`trg_approval_requires_claims_ok`) pour que l'étape 5 n'ait pas à reconstruire la base | Étape 5 |
| **Publication** (`scheduled`, `publishing`, `published`, `publish_failed`) | Aucun connecteur n'existe (`packages/publishing` est un emplacement réservé). Les états sont **déclarés** dans la table de transitions pour qu'elle soit complète, et jamais atteints par le code de cette étape | Étapes 5 et 9 du plan |
| **Entrée média et transcription** (ce que `docs/10` place à l'étape 3) | Le lot était intitulé « étape 4 » : le périmètre livré est sujets + angles + écriture. `packages/media` reste un emplacement réservé | Étape média du plan |
| **`video_renders`** : aucun pipeline vidéo | Table créée par la règle « la table d'abord, le pipeline ensuite » (docs/10 §1.3). `errors`, `system_health` et `notifications` sont dans le même cas : elles existent, personne ne les interroge encore | Étapes 11 et 12 |
| **Cibles X, Instagram et blog** | `docs/06` les traite en `⚠️` à revérifier ; seules les cinq cibles dont les limites sont écrites et testées ont un prompt et un schéma de sortie. Ajouter une cible sans limite vérifiée produirait un texte qu'aucun contrôle ne juge | Quand docs/06 tranche leurs limites |
| **Notification d'enqueue, `pollMs` adaptatif** | Point laissé ouvert par `docs/12` §6. La latence jusqu'à `WORKER_POLL_MS` reste, elle est visible dans l'écran de jobs | Étape 5 (l'utilisateur attend un résultat) |
| **Cache de prompt / réutilisation de contexte** | Le gain est réel (le contexte d'un lot est envoyé une fois), mais le mesurer demande des appels réels et un volume. `llm_calls` porte déjà tout ce qu'il faut pour le calculer | Étape 11 (analytics) |

---

## 4. Ce qui a été corrigé en chemin

### 4.1 Une base à laquelle il manque une table de contenu démarre encore

La correction de `docs/13 §7.1` (une seule liste, `REQUIRED_TABLE_NAMES`, et `missingTables()` qui
**nomme** ce qui manque) ne suffisait pas si la nouvelle étape ne s'y inscrivait pas : sans cela,
une base sans `content_versions` aurait démarré et produit « no such table: content_versions » au
premier enregistrement de texte — exactement le symptôme que `docs/08 §6` interdit.

**Correction.** `STEP_FOUR_TABLE_NAMES` (les 8 noms SQL, ce que lisent les contrôles de démarrage)
et `STEP_FOUR_TABLES` (les objets Drizzle, pour le jour où le diagnostic les interrogera) sont
ajoutés, et `REQUIRED_TABLE_NAMES` les agrège : **27 tables** attendues. `missingTables` continue de
faire le travail, dans l'API comme dans le worker.

Deux tests le figent, et ils mesurent vraiment quelque chose :

- `tests/integration/migrations.test.ts` — la liste attendue est vérifiée **en toutes lettres**,
  y compris ses exceptions : les deux tables éditoriales de l'étape 3 (`content_subjects`,
  `subject_angles`) arrivent avec la migration `0003` alors qu'elles appartiennent à l'étape 3. Le
  test cite aussi les 8 noms de l'étape 4 **explicitement** : c'est précisément quand une table
  n'est encore interrogée par personne (`video_renders`, `errors`, `system_health`,
  `notifications`) qu'elle peut disparaître d'une migration sans que rien ne le voie ;
- `tests/integration/project-memory-migration.test.ts` — la base peuplée reçoit désormais **trois**
  migrations (`0001`, `0002`, `0003`), et le total appliqué passe de 3 à 4 (en comptant `0000`) :
  c'est `0002` qui reconstruit `project_facts`, et c'est `0003` qui ajoute les contenus à une base
  qui contient déjà des projets, des faits et une fiche validée.

### 4.2 Des libellés qui mentaient encore

`tests/integration/api.test.ts` figeait le libellé de la racine à « étape 3 », et
`docs/04 §4.3` décrivait un prompt par plateforme sans mentionner `rules.md`. Les deux sont
corrigés : le libellé dit **étape 4**, et la documentation de l'agent dit ce que le code fait
(règles communes, limites injectées depuis le code, empreinte du lot entier). L'assertion du
libellé est conservée **exprès** : c'est un rappel volontaire de la mettre à jour à chaque étape,
et le commentaire au-dessus le dit.

Trois libellés périmés sont corrigés dans la même passe, parce qu'ils affirmaient l'état du dépôt
et non une étape : la **description de `package.json`** (« étape 1 : fondations exécutables »)
perd son numéro — c'est la ligne que lit un visiteur du dépôt ; le **README** annonçait encore
« étapes 1 à 3 », « les 17 tables » et « aucune génération de contenu n'existe encore », trois
affirmations devenues fausses ; et il pointe désormais le §4.4 du plan avec ses propres
interdits (pas de publication, pas de vérification d'affirmations, pas d'entrée média) au lieu du
§4.3. `scripts/check-env.ts` annonçait enfin « transcription désactivée (étape 3) » : c'est vrai du
**plan** (étape 3 = sujets, angles **et entrée média**) mais faux du lot, puisque cette livraison
s'appelle étape 4 — le message nomme maintenant la fonctionnalité (« entrée média du plan,
docs/10 §4.3 ») au lieu d'un numéro.

### 4.3 Une limite connue, assumée, et écrite ici

Pour un lot à **une seule** cible, l'API pose `contentItemId` dès la génération initiale (utile
pour retrouver le contenu à réécrire), et la clé de déduplication devient
`content:regenerate:<itemId>`. Conséquence : si l'utilisateur clique sur « Régénérer » **pendant**
que cette génération initiale est encore en file, `SqliteQueue.enqueue` renvoie le job déjà actif
et la demande de réécriture n'est pas enfilée — silencieusement. Rien n'est payé deux fois, mais
l'intention est perdue. Le correctif est connu (inclure `mode` dans la clé) et vérifiable ; il est
laissé ouvert parce qu'il appartient à l'écran de relecture, qui est le seul à pouvoir désactiver
le bouton tant que le job tourne (§6).

---

## 5. Ce que les tests couvrent

**Quatre fichiers nouveaux, 38 tests**, plus cinq fichiers existants mis à jour. La suite complète
compte **43 fichiers et 320 tests**, tous verts (`pnpm test`), avec `pnpm typecheck` et
`pnpm lint` verts.

| Fichier | Ce qu'il fige |
|---|---|
| `packages/core/src/editorial/validation.test.ts` (11) | Limites dures par plateforme, budget visé (avertissement, pas blocage), marqueur de gabarit, titre obligatoire, chapitres d'une vidéo longue, comptage des chapitres et du temps de lecture, ancrage d'une citation (casse et accents compris), mesure du pourcentage réécrit |
| `packages/core/src/editorial/content.test.ts` (8) | Un lot incomplet échoue **bruyamment** ; une cible inventée est signalée et non enregistrée ; seules les cibles fautives sont régénérées ; la plateforme et le format se **dérivent** de la spécification ; le graphe d'états est fermé et sans auto-transition |
| `packages/ai/src/agents/platform-writer.test.ts` (13) | Le contexte n'est envoyé **qu'une fois** et l'ordre des cibles ne change pas le prompt ; les limites sont lues dans le code, pas dans le `.md` ; le texte refusé et son motif ne sont joints qu'à la cible réécrite ; un lot sans prompt échoue **avant** l'appel ; l'empreinte du lot change si un prompt change ; une sortie mal emballée est **réparée**, une sortie non conforme est refusée, un contexte trop long n'est pas payé |
| `tests/integration/editorial.test.ts` (6) | La chaîne complète sur le **vrai** code de production (voir ci-dessous) |

**Ces six tests d'intégration ne simulent que le modèle.** Les ports, la file, la spécification du
job (`generateContentSpec`), le handler et la boucle du worker sont le code de production : la file
du test est indiscernable de celle de l'API. Ce qu'ils mesurent, et qui n'était vérifiable nulle
part ailleurs :

1. la racine annonce l'étape courante et les points d'entrée éditoriaux ;
2. `BRIEF_NOT_APPROVED` en **409** : pas de plan sans fiche maître validée ;
3. un plan non ancré est refusé **avec le détail** (`droppedAngles`, sujets rejetés et leurs raisons) ;
4. **un appel, quatre versions** : aucun contenu versionné avant le passage du worker, une ligne
   `llm_calls` tracée par le job, et `content_claims` **vide** ;
5. régénérer **ajoute** une version sans écraser les précédentes, et `generated → approved` est
   refusé : l'approbation ne couvre que le texte approuvé ;
6. le rejet est une **décision signée** (`decision`), pas une suppression.

**Ce qui n'est pas testé, et assumé** : tout rendu visuel (le front n'existe pas à cette étape) ;
le parcours E2E (aucun navigateur, aucun Playwright) ; une **panne réseau** du fournisseur — le
fournisseur scripté ne sait pas échouer, donc la politique de reprise du job (3 tentatives,
backoff) n'a pas de test d'intégration, seulement un test unitaire de la file ; le chemin
`write_retry` du handler (le lot scripté est toujours conforme — la réparation Zod est testée au
niveau de l'agent, pas de bout en bout) ; le **veto de budget** vu depuis ce job (il est testé dans
`tests/integration/budget.test.ts`, au niveau du paquet `analytics`) ; le coût **réel** d'un lot de
cinq textes, qui demande un appel à un vrai fournisseur.

---

## 6. Points laissés ouverts pour l'étape 5

| Point | Pourquoi il n'est pas tranché ici | À trancher |
|---|---|---|
| Clé de déduplication d'un lot à cible unique (`mode` absent de la clé) | Sans conséquence tant que l'écran de relecture n'existe pas : c'est lui qui pourra désactiver « Régénérer » pendant qu'un job tourne (§4.3) | Étape 5, avec l'écran de relecture |
| Remplissage de `content_claims` et appel du `critic` | Périmètre de l'étape 5 (`docs/10 §4.4`). Les déclencheurs SQL gardent déjà l'approbation honnête | Étape 5 |
| Écran de choix d'angle, de relecture et de **comparaison de versions** | Aucun front n'a été touché : l'API rend tout ce qu'il faut en **un** appel (`GET /content/:id` → objet, historique complet, contrôle recalculé) | Étape 5 |
| Notification d'enqueue / `pollMs` adaptatif | Latence jusqu'à `WORKER_POLL_MS`, sans conséquence tant que personne n'attend un résultat | Étape 5 |
| Seuil d'ancrage (`0,5`) et budgets de tokens du lot (10 000 en entrée, 6 000 en sortie) | Valeurs posées par le raisonnement, pas mesurées : il faut du contenu réel et des refus réels pour savoir si le seuil est trop indulgent ou trop sévère | Étape 5, puis étape 11 |
| Limites chiffrées des plateformes (`docs/06`) | Marquées `⚠️` dans `content_targets.ts` : elles changent, et un chiffre faux produit un faux refus | À revérifier avant publication |
| Purge de `errors`, `notifications`, `system_health`, `job_events` | Rien n'écrit encore dans ces tables ; la rétention demande un job récurrent | Étapes 11 et 12 |
| **Coût réel d'un lot mesuré** (docs/09 §14, condition 5) | Aucun appel réel n'a été passé : le coût est **calculé et journalisé** (`llm_calls`, vérifié par le test d'intégration), mais pas **mesuré** sur un lot réel de trois à cinq textes. Cela demande une clé et un budget | `pnpm test:live` étendu à `platform_writer` |

---

## 7. La définition de « terminé » (docs/09 §14), condition par condition

| # | Condition | État à l'étape 4 |
|---|---|---|
| 1 | La fonctionnalité marche sur le parcours nominal | **Oui, au niveau API + worker** : plan → sélection d'angle → génération → relecture → édition → approbation, couvert par `tests/integration/editorial.test.ts`. Pas d'E2E : aucun navigateur n'est branché |
| 2 | Les chemins d'erreur sont traités et affichés | **Oui** : `BRIEF_NOT_APPROVED` (409), `PLAN_UNGROUNDED`, `CONTENT_STATE_TRANSITION` (409), `CONTENT_NOT_FOUND`, `PROMPT_MISSING`, `JOB_INPUT_INVALID`, `REGENERATION_LIMIT` — chacun avec un code et un message actionnable |
| 3 | Les tests de l'étape passent | **Oui** : 38 tests dédiés, suite complète à 43 fichiers / 320 tests, `typecheck` et `lint` verts |
| 4 | La migration est écrite et testée sur base peuplée | **Oui** : `0003` sur base peuplée (`project-memory-migration.test.ts`) et `db:check-migrations` sur base vide **et** peuplée |
| 5 | Le coût de l'étape est mesuré et écrit dans `llm_calls` | **Partiellement** : écrit et vérifié, pas encore mesuré sur un appel réel (§6) |
| 6 | Les journaux ne contiennent aucun secret | **Oui** : `pnpm check:canary` (la clé du fournisseur de rédaction passe par le même point de rédaction que les autres) |
| 7 | Ce qui a été volontairement écarté est écrit | **Oui** : §3 de ce document, et les interdits du §4.4 du plan |

---

## 8. Les critères de sortie du plan (docs/10 §4.4)

| Critère écrit dans le plan | État | Où le vérifier |
|---|---|---|
| Un contenu produit pour **4 plateformes en un seul appel** | **Oui** | `tests/integration/editorial.test.ts` (un appel, quatre versions) et `platform-writer.test.ts` (le contexte n'est parti qu'une fois) |
| Chaque sortie **valide son schéma Zod ou est réparée** | **Oui** | `platform-writer.test.ts` : sortie mal emballée réparée et signalée, sortie non conforme refusée. La **reprise par un second appel** après échec de schéma appartient au fournisseur (`deepseek.test.ts`, docs/13 §5) : l'agent n'a ni boucle ni seconde chance à lui |
| Les **longueurs** respectent les limites par plateforme ⚠️ | **Oui, avec réserve** | `validation.test.ts` pour le contrôle ; les valeurs elles-mêmes restent marquées ⚠️ dans `content_targets.ts` et doivent être revérifiées avant publication |
| Chaque version conservée avec son **`context_fingerprint`** | **Oui, autrement nommé** | L'empreinte de contexte vit dans `llm_calls.context_fingerprint` et la version y renvoie par `llm_call_id` ; la version porte aussi `prompt_version_hash`, `model_used` et `temperature_x100`. Le plan prévoyait la colonne sur la version ; la table `llm_calls` porte l'information **une fois** pour l'appel entier, ce qui est plus juste pour un lot multi-cibles |
| Le **marquage IA** est présent | **Oui** | `content_items.ai_generated` (vrai par défaut), `human_edited`, `edit_ratio`, et `content_versions.generation` (`initial`, `regenerated`, `edited`, `reformatted`) |
| Aucune affirmation n'est « vérifiée » à ce stade | **Oui, trivialement** | `content_claims` est vide ; les trois déclencheurs de la migration `0003` rendent une approbation avec une affirmation non étayée **impossible** le jour où la table se remplira |
| **Écran de comparaison de versions** | **Non** | §3 : aucune interface à cette étape. Les données sont là (`GET /content/:id` rend l'historique complet) |
