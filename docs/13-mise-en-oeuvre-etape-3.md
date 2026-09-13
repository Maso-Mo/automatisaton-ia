# 13 — Mise en œuvre de l'étape 3 (conversation IA et fiche maître)

> Ce document raconte ce qui a été **réellement** construit à l'étape 3, les décisions
> prises en chemin, ce qui n'a **pas** été construit et pourquoi, et ce que les tests
> couvrent. À lire après [`10-plan-de-developpement-12-etapes.md`](10-plan-de-developpement-12-etapes.md),
> pas avant.

---

## 1. Ce qui existe maintenant

L'utilisateur **discute par texte** avec un assistant à propos d'un projet, et la
mémoire du projet se construit sous ses yeux.

| Fonctionnalité | Où |
|---|---|
| Entretien multi-tours (texte), reprise après rechargement | `apps/web/src/features/conversation/`, `apps/api/src/routes/conversations.ts` |
| Lacunes calculées **localement** (questions jamais redondantes) | `packages/core/src/conversation/stages.ts` |
| Propositions d'écriture **citant** les mots de l'utilisateur, acceptées une par une | `packages/core/src/conversation/edit-plan.ts` |
| Fiche maître générée, corrigée (versions), validée | `packages/core/src/conversation/master-brief.ts` |
| Provider **DeepSeek** réel, derrière `LLMProvider` | `packages/ai/src/providers/deepseek.ts` |
| Agents `interviewer` et `strategist` + prompts versionnés | `packages/ai/src/agents/`, `prompts/` |
| Fenêtre de contexte bornée (10 messages + résumés de blocs de 20) | `packages/core/src/conversation/messages.ts` |
| Flux SSE reprenable de la conversation | `apps/api/src/routes/conversations.ts` |

**Numérotation.** Le plan place « Conversation et mémoire » en étape 2 et « Sujets,
angles et entrée média » en étape 3. La consigne de ce lot était « étape 3 :
conversation IA et fiche maître », c'est-à-dire **ce qui restait de l'étape 2 du plan**
(la conversation et la fiche maître) plus la table `master_briefs`. Ce document décrit
donc ce périmètre-là : les sujets, les angles, l'entrée média et la transcription
restent à construire (voir §3).

---

## 2. Décisions prises pendant l'implémentation

| # | Décision | Pourquoi | Alternative écartée |
|---|---|---|---|
| **M1** | Le tour de conversation est **synchrone, dans l'API**, pas un job | C'est ce que dit [`05-pipelines.md`](05-pipelines.md) §10.1 : « Conversation \| synchrone (pas un job) \| 2–8 s » | Un job `conversation_turn` : une file, un lease et un polling pour un appel court |
| **M2** | Le message utilisateur est **écrit avant l'appel** | « Réessayer » doit être gratuit : si l'appel échoue, la phrase est déjà en base (docs/05 §3.4) | Écrire les deux messages après la réponse : un échec perdrait le texte |
| **M3** | Les propositions d'écriture vivent dans `messages.content_json` | Elles survivent à un rechargement, elles sont auditables, et l'acceptation peut venir plus tard — sans nouvelle table | Une table `message_proposals` : une table de plus pour un objet déjà porté par son message |
| **M4** | Une proposition **non citée** est refusée par le domaine (garde-fou de niveau 3) | Un fait inventé n'a pas de citation à produire ; la citation doit se retrouver **dans le message de l'utilisateur** (docs/04 §6.3). La proposition reste visible avec sa raison de refus | Faire confiance au modèle, ou jeter la proposition en silence |
| **M5** | Un fait accepté naît `proposed` ; « Accepter et confirmer » enchaîne deux actes datés | Un fait d'origine IA ne peut pas naître `verified` (`assertSourceAllowsInitialStatus`, déclencheur SQL). L'acceptation est un acte, la confirmation en est un autre | Écrire directement `verified` : ce serait contourner l'invariant du produit |
| **M6** | Les **lacunes** (`missing_slots_json`) sont la clé de l'entretien, recalculées par comptage | « Le produit ne pose donc jamais une question dont il connaît déjà la réponse » (docs/03 §7.1). Coût nul, reproductible, explicable | Demander au modèle ce qu'il faut demander : un coût à chaque tour, non déterministe |
| **M7** | La phase (`stage`) est une **machine à états décidée par le code** | « Le passage d'une phase à la suivante est décidé par le code, sur la base de champs obligatoires remplis » (docs/05 §3.1). Une conversation interrompue reprend au bon endroit | Laisser le modèle choisir la phase : intestable |
| **M8** | Une fiche maître **validée ou remplacée** ne se modifie plus, en base | Immuabilité documentée (docs/03 §8.1) portée par un déclencheur (`trg_master_briefs_frozen_when_validated`) : un bug de code ne peut pas réécrire une fiche validée | Une règle seulement dans le domaine |
| **M9** | Corriger la fiche = créer une version ; l'ancienne devient `superseded` | Les contenus générés resteront rattachés à la version qui les a produits | Modification sur place : on perdrait ce qui a produit quoi |
| **M10** | Valider la fiche met à jour le **positionnement du projet** | La fiche est la synthèse validée de l'entretien : deux vérités divergentes seraient un piège | Laisser l'utilisateur recopier |
| **M11** | Les **profils d'audience et de style** sont créés par l'entretien | Sans eux, les phases `audience` et `voice` seraient des culs-de-sac et la fiche maître n'aurait ni public ni voix | Attendre une étape ultérieure : l'entretien ne convergerait jamais |
| **M12** | Seuls `deepseek` et `ollama` sont branchés ; les autres **échouent explicitement** | `PRICE_TABLE` n'a de tarif daté que pour DeepSeek et le local : sans prix, pas de coût, donc pas de budget respecté (docs/08 §7.3) | Retomber silencieusement sur un autre modèle |
| **M13** | Les prompts partagés s'incluent par `@include _shared/…` | « Les prompts partagés sont inclus explicitement », donc lisibles dans le fichier qui les applique et visibles dans un diff (docs/04 §6.1) | Une variable d'environnement, ou une concaténation invisible |
| **M14** | Une seule tentative de réparation d'une sortie structurée | « Les erreurs de format valent ~1 % des appels » ; un appel de correction coûte ~10 %, une régénération complète 100 % (docs/04 §6.2) | Boucle de réparation : coût non borné |
| **M15** | Le plafond de contexte est une **erreur**, pas un avertissement | « Le contexte qui gonfle » est le risque n° 1 de l'étape (docs/10 §4.2) : un dépassement doit se voir tout de suite | Tronquer en silence |
| **M16** | Audiences et styles sont **uniques** par projet (le second remplace le premier) | Deux voix concurrentes produiraient des contenus incohérents (`uq_style_scope`) | Plusieurs profils de voix par projet |

---

## 3. Ce qui n'a **pas** été construit, et pourquoi

| Non construit | Raison | Étape où il arrive |
|---|---|---|
| Note vocale et transcription (Whisper) | La consigne de ce lot est explicitement **texte** ; la transcription locale est le premier vrai risque matériel du plan et mérite sa propre étape | étape média |
| Sujets, angles, `subject_angles` | Ils viennent **après** la fiche maître : les produire ici remplirait des tables encore inexistantes | étape suivante |
| Génération de contenus (LinkedIn, Reddit, TikTok, YouTube) | Interdite explicitement dans ce lot | étape éditoriale |
| Embeddings, RAG, recherche sémantique | « Pas d'embeddings ni de RAG à cette étape » (docs/10 §4.2) ; à cette échelle, la sélection SQL est plus précise et gratuite (docs/04 §5.3) | V2, au-delà de 500 faits |
| Alimentation de `conversation_summaries` | La table et la règle de découpage existent (`nextSummaryBlock`), mais la fenêtre de 10 messages suffit tant que l'entretien reste court ; aucun appel n'est encore payé pour résumer | resserrement des coûts |
| `learnings` et anti-répétition dans le paquet de mémoire | Les tables n'existent pas encore (`learnings` : analytics ; contenus publiés : éditorial). Le paquet les renvoie **vides** au lieu d'inventer | étapes éditoriale et analytics |
| Vérification factuelle automatique, recherche web | Hors périmètre (V3) | — |
| Multi-projets simultanés dans l'interface | Une conversation = un projet (docs/10 §4.2, « Interdits ») | — |
| Mémoire écrite sans validation | C'est l'invariant du produit, pas une fonctionnalité manquante | jamais |

---

## 4. Comment lancer et vérifier

```bash
pnpm install
cp .env.example .env              # puis : openssl rand -hex 32 (SESSION_SECRET, ENCRYPTION_KEY)
# Ajouter DEEPSEEK_API_KEY=sk-... pour parler réellement à l'assistant
pnpm db:migrate                   # crée les 17 tables (étapes 1 à 3)
pnpm dev                          # API + worker + interface
# puis http://127.0.0.1:5173      # onglet « Conversation »
```

- `pnpm verify` : types, lint, tests, parcours, migrations, frontières, canari, environnement.
- `pnpm test:live` : suite **live** (DeepSeek réel, budget consommé) — `VITEST_LIVE=1`.

---

## 5. Ce que les tests couvrent

| Famille | Fichiers | Ce qui est réellement vérifié |
|---|---|---|
| Unitaire (domaine) | `packages/core/src/conversation/stages.test.ts`, `edits.test.ts` | Lacunes et phases ; citation obligatoire ; acceptation/refus ; immuabilité et versions de la fiche |
| Unitaire (IA) | `packages/ai/src/providers/deepseek.test.ts`, `memory-pack.test.ts`, `prompts/includes.test.ts`, `recording-provider.test.ts` | Requête compatible OpenAI, mapping de l'usage et du coût, une seule réparation, traduction des erreurs HTTP ; budgets du paquet de mémoire ; inclusion des prompts partagés |
| Unitaire (interface) | `apps/web/src/features/conversation/state.test.ts` | Aucune proposition non citée présélectionnée ; fusion SSE sans doublon ; libellés lisibles |
| Intégration | `tests/integration/conversation.test.ts`, `conversation-api.test.ts` | Pipeline complet sur SQLite réel, **aucune écriture sans acceptation**, message utilisateur conservé en cas d'échec, déclencheurs SQL (fiche gelée, message insupprimable), contrat HTTP |
| Migrations | `tests/integration/project-memory-migration.test.ts`, `prompts.test.ts` | Migration `0002` sur base peuplée : reconstruction de `project_facts` **sans perte**, et recréation des déclencheurs emportés par le `DROP TABLE` |
| Live (exclue par défaut) | `packages/ai/src/providers/deepseek.live.test.ts` | Le vrai fournisseur respecte le schéma et renvoie un **coût mesuré** |

Ce qui n'est **pas** couvert automatiquement : la qualité éditoriale des réponses
du modèle (elle se relit, elle ne s'automatise pas), et le flux SSE de conversation
qui, n'étant jamais terminé par le serveur, ne se teste pas par `inject()`.

---

## 6. Points laissés ouverts

1. **Coût réel par tour** : le coût est calculé et journalisé (`llm_calls`), mais
   aucune mesure réelle sur 20 appels n'a encore été consignée — cela demande une clé
   DeepSeek et un budget ; `pnpm test:live` est le point d'entrée prévu.
2. **Tarifs** : `PRICE_TABLE` reste marqué `verified: false` (docs/08 §7.3). Tant que
   ce n'est pas vérifié, un coût affiché est un ordre de grandeur.
3. **Résumés de conversation** : la règle est en place, l'appel n'est pas encore
   déclenché ; à brancher quand un entretien réel dépassera 20 messages.
4. **`llm_call_id` sur les messages** : rempli en production (l'appel est journalisé),
   `null` dans les tests à fournisseur scripté — la colonne est une clé étrangère, et
   un identifiant factice serait un mensonge.

---

## 7. Audit après livraison : ce que la relecture a trouvé

Le code a été relu après le premier passage, en cherchant explicitement les endroits où
l'étape 3 **aurait dû** toucher l'existant sans que rien ne le rappelle. Deux catégories
de résidus ont été trouvées, et une seule était grave.

### 7.1 Un vrai défaut : la garde de démarrage ignorait les tables de l'étape 3

L'étape 3 a ajouté **quatre tables** (`conversations`, `messages`, `conversation_summaries`,
`master_briefs`) et n'a pas étendu la garde qui décide si l'application a le droit de
démarrer :

| Endroit | Avant | Conséquence |
|---|---|---|
| `apps/api/src/bootstrap.ts` | `isMigrated(handle, STEP_ONE_TABLE_NAMES)` | une base sans `conversations` **démarrait** |
| `apps/worker/src/bootstrap.ts` | idem | idem |
| `apps/api/src/bootstrap.ts` (`expectedTables`) | `STEP_ONE_TABLE_NAMES` | le diagnostic affichait « schéma complet » alors que la conversation était cassée |
| `packages/database/src/schema/index.ts` | `STEP_THREE_TABLE_NAMES` **exportée et jamais utilisée** | le manque ne se voyait nulle part : ni erreur, ni `eslint`, ni test |

Le symptôme réel n'aurait pas été un message clair mais une **erreur SQL au premier message
de conversation** (« no such table: conversations »), c'est-à-dire le contraire de
`docs/08 §6` (« le message d'échec est compréhensible et propose une action »).

**Correction.** Une seule liste, construite à partir des deux : `REQUIRED_TABLE_NAMES`, et
une fonction `missingTables(handle, attendues)` qui **nomme** ce qui manque —
`isMigrated` reste, réécrit en une ligne au-dessus d'elle. Les deux amorçages et le
diagnostic l'utilisent ; le nombre « 13 » disparaît des messages : il avait déjà menti une
fois, il ne pourra plus.

Deux tests le figent :

- `tests/integration/migrations.test.ts` — `missingTables` renvoie exactement
  `['conversation_summaries']` après suppression de cette table, et vérifie que
  `REQUIRED_TABLE_NAMES` couvre bien les deux étapes ;
- `tests/integration/api.test.ts` — l'API **refuse de démarrer** sur une base à laquelle
  manque une table de conversation, et le message d'erreur contient son nom. Ce test
  échouait avant la correction : c'est ce qui prouve qu'il mesure quelque chose.

### 7.2 Des libellés qui mentaient sur l'état du dépôt

Aucune conséquence fonctionnelle, mais trois affirmations fausses affichées à l'utilisateur
ou au développeur :

1. `scripts/e2e.ts` annonçait « aucun parcours E2E à l'étape 1 … ils arrivent à partir de
   l'étape 2 ». Faux : aucun parcours n'est apparu à l'étape 2, et il ne peut pas encore en
   apparaître à l'étape 3 — le parcours n° 1 de `docs/09 §11` (« conversation → contenu »)
   n'est complet qu'une fois la **génération de contenu** livrée. Le message ne porte plus
   de numéro d'étape, donc il ne pourra plus périmer ; la référence pointait la pyramide
   (`docs/09 §2`) au lieu de la liste des six parcours (`§11`).
2. `scripts/check-env.ts` titrait « Vérification de l'environnement — **étape 1** » :
   l'écran parle du poste de travail, pas d'une étape ; le numéro disparaît.
3. L'assertion de `tests/integration/api.test.ts` figeait le libellé de la racine et avait
   dû être retouchée à chaque étape (`étape 1` → `étape 3`). Elle est conservée **exprès** :
   le libellé de `GET /` est une affirmation produit, et un test qui la fige est un rappel
   volontaire de la mettre à jour — le commentaire au-dessus le dit maintenant.

### 7.3 Ce qui a été relu sans rien trouver

Les 17 tables (`REQUIRED_TABLE_NAMES`), les colonnes, les déclencheurs SQL, les 13 routes de
`projects.ts`, les 14 routes de `conversations.ts`, les six composants React
(`ConversationView`, `ProjectsView`, `ProjectDetailSection`, `ProjectsSection`, `Metrics`,
`JobsSection`) et les prompts versionnés correspondent à ce que décrivent les §1, §2 et
`docs/03`. Les autres mentions de « étape 1 » / « étape 2 » restantes dans le code sont des
**annotations historiques** (« cette table arrive à l'étape 2 ») et non des affirmations sur
l'état courant : elles sont exactes et doivent rester.



