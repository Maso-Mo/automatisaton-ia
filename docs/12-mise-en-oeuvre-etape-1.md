# 12 — Mise en œuvre de l'étape 1 (fondations exécutables)

> Répond à l'exigence de [`09-tests-et-qualite.md`](09-tests-et-qualite.md) §14 : **« ce qui a été
> volontairement écarté est écrit »**. Ce document n'est pas une spécification — la spécification
> reste [`10-plan-de-developpement-12-etapes.md`](10-plan-de-developpement-12-etapes.md) §4.1. C'est
> le **compte rendu d'exécution** : ce qui existe réellement, ce qui a été tranché en chemin, ce qui
> n'a pas été construit, et comment on le vérifie.

---

## 1. Ce qui existe maintenant

```text
automatisation-ia/
├── apps/
│   ├── api/          Fastify 5 · REST + SSE · écoute 127.0.0.1:4317
│   ├── worker/       boucle de jobs (lease, heartbeat, arrêt propre) + job noop
│   └── web/          SPA React + Vite + Tailwind (écran de diagnostic)
├── packages/
│   ├── core/         domaine : hiérarchie d'erreurs, cas d'usage « diagnostic »
│   ├── database/     Drizzle + SQLite (WAL) : 13 tables, migrations, dépôts
│   ├── queue/        contrat Queue + SqliteQueue (BEGIN IMMEDIATE) + politique de reprise
│   ├── ai/           contrat LLMProvider, calcul de coût, enregistrement des appels, prompts
│   ├── analytics/    agrégation des dépenses, veto de budget, état du budget
│   ├── observability/ journal pino corrélé (job_id automatique) + rédaction
│   ├── config/       validation Zod de l'environnement, rédaction des secrets
│   ├── shared/       types, énumérations, UUID v7, temps, argent, erreurs de base
│   ├── media/        emplacement réservé (étapes 3, 6, 7) — README seulement
│   ├── news/         emplacement réservé (étapes 7, 10) — README seulement
│   └── publishing/   emplacement réservé (étapes 5, 9) — README seulement
├── prompts/          prompts versionnés (fichiers + en-tête agent/task)
├── scripts/          check-env · db-migrate · db-check-migrations · check-canary
│                     check-boundaries · e2e · verify.sh
├── tests/            support (harnais) + integration (8 fichiers)
├── data/             NON VERSIONNÉ : base SQLite locale
└── .env / .env.example
```

**Les 13 tables de l'étape 1** sont créées : `users`, `app_settings`, `llm_providers_config`,
`projects`, `project_goals`, `project_facts`, `project_skill_facts`, `style_profiles`,
`audience_profiles`, `jobs`, `job_events`, `llm_calls`, `prompt_versions`.

**Le critère de sortie est satisfait et vérifié automatiquement** :

| Critère de `docs/10 §4.1` | Vérification |
|---|---|
| `pnpm verify` passe | `scripts/verify.sh` (types, lint, tests, E2E, migrations, frontières, canari, environnement) |
| La base se crée depuis zéro | `pnpm db:migrate` + `pnpm db:check-migrations` (base vide **et** base peuplée) |
| Un job `noop` s'exécute et s'écrit dans `jobs`/`job_events` | `tests/integration/noop-job.test.ts` + `pnpm job:noop -- --wait` |
| Une ligne `llm_calls` porte un coût calculé | idem : coût en micro-dollars, empreinte de contexte, version de prompt |
| L'application refuse de démarrer si une clé requise manque | `packages/config/src/env.test.ts` + `pnpm check:env` |


---

## 2. Décisions prises pendant l'implémentation

Ces points n'étaient pas tranchés par la documentation, ou la contredisaient partiellement. Ils sont
consignés ici parce qu'une décision non écrite n'existe pas (docs/11 §2).

| # | Décision | Raison | Alternative écartée |
|---|---|---|---|
| **M1** | **Onze paquets** : les neuf de `docs/02 §5` (`core`, `database`, `queue`, `shared`, `config`, `ai`, `media`, `news`, `publishing`) **plus** `observability` et `analytics` | Le brief d'étape listait `observability` et `analytics` ; les documents imposent `core` comme couche qui décide. Créer les onze évite de renommer plus tard | Supprimer `core` (violerait docs/02 §5) · créer `analytics` en sous-dossier de `core` (mélangerait domaine et mesure) |
| **M2** | **Les prompts vivent à la racine (`prompts/`)**, pas dans `packages/prompts/` | `docs/02 §5` et `docs/10 §4.1` placent `prompts/` à la racine ; `docs/03 §14.4` mentionne `packages/prompts/*.md`. Majorité + périmètre d'étape retenus | Créer un dixième paquet pour des fichiers Markdown |
| **M3** | **La base d'erreurs vit dans `@aia/shared`**, `@aia/core` la réexporte et y ajoute ses erreurs métier | `docs/02 §12` veut une hiérarchie unique dans `core` ; `docs/02 §5` interdit à un paquet d'infrastructure d'importer `core`. La file doit lever des erreurs typées : la base est donc dans `shared`, réexportée par `core` | Dupliquer la hiérarchie (deux vérités) · laisser `queue` importer `core` (frontière violée) |
| **M4** | **`tsx` est le lanceur de développement** | Node 20 LTS n'exécute pas TypeScript ; les documents exigent « `pnpm dev` doit suffire » avec `node >= 20`. `tsx` est un *loader*, pas un cinquième outil de test | Compiler en `dist` avant chaque lancement (boucle de développement pénible) · exiger Node 22+ (contredit docs/02 §10) |
| **M5** | **Le contrôle des frontières et des cycles est un script** (`scripts/check-boundaries.ts`) | `import/no-cycle` exige un résolveur de modules supplémentaire. Le script analyse le graphe, vérifie le sens des dépendances, l'existence des points d'entrée, le confinement de Drizzle et de `process.env`, et **échoue**. ESLint garde les règles locales | Ajouter `eslint-plugin-import` + résolveur TypeScript (deux dépendances pour un contrôle unique) |
| **M6** | **Les seules clés exigées au démarrage sont les clés cryptographiques** (`SESSION_SECRET`, `ENCRYPTION_KEY`) | Réconcilie `docs/02 §11` (une clé IA absente ne bloque pas) et le critère de sortie de l'étape 1 (refus de démarrer si clé requise manquante). La présence des clés IA est exposée en booléen, jamais leur valeur | Exiger une clé IA (contredit docs/02 §11 : la publication manuelle doit fonctionner sans IA) |
| **M7** | **Aucune table `system_health` à l'étape 1** | Cette table arrive à l'étape 4 (`docs/03 §14.6`) et la règle « la table d'abord, le pipeline ensuite » ne permet pas de la déplacer sans raison. Le diagnostic est **calculé en direct** par le domaine via des ports | Créer la table maintenant (28 tables d'avance, hors périmètre) |
| **M8** | **Les prix des modèles sont une constante datée et testée** (`PRICE_TABLE`, avec `effectiveFrom` et `verified`) | `docs/08 §7.3` prévoit `llm_providers_config`, qui n'a **pas encore** de colonnes de prix (`docs/03 §4.3`). Une table unique et datée permet de calculer un coût réel dès le premier job, sans inventer de tarif silencieux : chaque prix est marqué `verified: false` ⚠️ | Coder des prix dans le provider (impossible à dater) · attendre l'étape 3 (le critère « coût calculé » ne serait pas tenable) |
| **M9** | **Aucune route d'action dans l'API** : pas de `POST /jobs/noop` | `docs/10 §4.1` interdit les fonctionnalités métier à cette étape. La sonde se lance par `pnpm job:noop`, qui exerce **le même chemin** que les futures routes (validation Zod, déduplication, priorité) | Exposer une route « pour la démo » (surface d'API non spécifiée, à retirer ensuite) |
| **M10** | **Playwright est installé à l'étape 2**, pas maintenant | `docs/09 §3` veut garder quatre outils, utilisés seulement quand ils servent. `pnpm test:e2e` échoue explicitement si un parcours apparaît sans être branché : l'oubli est impossible | Installer Playwright et laisser un parcours vide (vert pour rien) |
| **M11** | **`allowBuilds` dans `pnpm-workspace.yaml`** au lieu de `onlyBuiltDependencies` | pnpm 11 (version installée) bloque tout script d'installation et utilise `allowBuilds`. Seuls `better-sqlite3` et `esbuild` sont autorisés | Autoriser tous les scripts d'installation (surface d'attaque inutile) |

---

## 3. Ce qui n'a **pas** été construit, et pourquoi

`docs/10 §4.1` liste des interdits ; voici ce qu'ils recouvrent concrètement, plus ce qui a été
reporté volontairement pendant l'implémentation.

| Non construit | Raison | Quand |
|---|---|---|
| **Authentification complète** (sessions, OAuth, écrans) | Aucune fonctionnalité ne la requiert à l'étape 1 ; `SESSION_SECRET` est exigé maintenant pour que la clé existe avant d'en avoir besoin | Étape 5 (OAuth des plateformes) |
| **Panneau de réglages** | La table `app_settings` existe, l'interface arrive quand il y a des réglages à régler | Étapes 3 puis 4 |
| **Design system** | Dix composants suffisent ; Tailwind couvre l'écran de diagnostic | Quand l'interface dépasse ~15 écrans |
| **Redis / BullMQ** | La table `jobs` porte la file (docs/08 §1). `Queue` est un contrat : le jour où un second worker existe, un `RedisQueue` se branche sans toucher au domaine | > 1 000 jobs/jour |
| **Fournisseurs IA réels** (DeepSeek, OpenRouter, Ollama) | Le contrat `LLMProvider` est figé et exercé par un provider **scripté** (aucun réseau, aucun coût) ; un vrai fournisseur sans orchestrateur ne servirait à rien | Étape 3 |
| **Orchestrateur et agents** | Aucun agent à l'étape 1 : `packages/ai` ne contient que les contrats, le coût et les prompts | Étape 3 |
| **Médias, FFmpeg, transcription** | `packages/media` est un emplacement réservé avec son README | Étapes 3, 6, 7 |
| **Publication, connecteurs** | `packages/publishing` réservé ; la V1 publie à la main (niveau C) | Étapes 5, 9 |
| **Veille** | `packages/news` réservé | Étapes 7, 10 |
| **Analytics produit** (métriques, apprentissages) | `packages/analytics` ne fait que du **suivi de coût**, seule mesure dont l'absence met l'utilisateur en danger | Étape 11 |
| **Chiffrement des jetons AES-256-GCM** | Aucun jeton à chiffrer : `ENCRYPTION_KEY` est validée et disponible, l'enveloppe `enc:v1:…` arrive avec `platform_accounts` | Étape 5 |
| **Déclencheurs SQL anti-publication-sans-approbation** | Ils portent sur `publications` et `content_claims`, qui n'existent pas encore ; les migrations SQL manuelles les accueilleront | Étapes 4 et 5 |
| **Contraintes de clé étrangère vers les tables des étapes suivantes** | `jobs.content_item_id`, `jobs.publication_id`, `project_facts.source_message_id`, `llm_calls.conversation_id`, `llm_calls.content_item_id` sont créés **sans contrainte** : SQLite ne sait pas ajouter une clé étrangère sans reconstruire la table. La contrainte sera ajoutée par la migration qui crée la table cible | Étapes 2, 4, 5 |
| **Index au-delà des six requêtes critiques** | « Aucun autre index n'est créé à l'avance » (docs/03 §15.3) | À partir de requêtes lentes mesurées |
| **Réveil du worker à l'enqueue** | Le worker sonde toutes les `WORKER_POLL_MS` (60 s par défaut, valeur documentée) : un job créé juste après un tour attend au plus une minute. Assumé à l'étape 1, à revoir dès que l'utilisateur clique sur « générer » (étape 4) | Étape 4 |
| **Suite `live`, tests de charge, CI distante, couverture en ligne** | Refusés explicitement (docs/09 §1.2, §15) | Jamais à cette échelle |


---

## 4. Comment lancer et vérifier

```bash
pnpm install                          # dépendances (better-sqlite3 compilé)
cp .env.example .env                  # puis renseigner les deux clés :
openssl rand -hex 32                  #   SESSION_SECRET
openssl rand -hex 32                  #   ENCRYPTION_KEY

pnpm check:env                        # état de l'environnement (bloquant / dégradé)
pnpm db:migrate                       # crée data/app.db et les 13 tables

pnpm dev                              # API (4317) + worker + web (5173) en parallèle
pnpm job:noop -- --wait               # sonde de bout en bout : statut, événements, coût
# puis http://127.0.0.1:5173          # écran de diagnostic

pnpm verify                           # la vérification complète (à lancer avant de committer)
```

| Commande | Ce qu'elle fait |
|---|---|
| `pnpm dev` | lance `apps/api`, `apps/worker` et `apps/web` en parallèle |
| `pnpm test:unit` | tests unitaires seuls (fonctions pures, contrats) |
| `pnpm test:int` | tests d'intégration (base SQLite réelle, file réelle, HTTP réel) |
| `pnpm test:e2e` | parcours de bout en bout — aucun à l'étape 1, échoue si un parcours apparaît sans Playwright |
| `pnpm test:live` | suite manuelle contre les fournisseurs réels (aucun test à l'étape 1) |
| `pnpm db:check-migrations` | migrations appliquées sur base vide **et** sur base peuplée |
| `pnpm check:boundaries` | sens des dépendances, cycles, points d'entrée, confinement de Drizzle et de `process.env` |
| `pnpm check:canary` | aucun secret ne traverse la journalisation |
| `pnpm check:env` | Node, SQLite, FFmpeg, whisper, clés : bloquant ou dégradé |

---

## 5. Ce que les tests couvrent (et ce qu'ils ne couvrent pas)

**22 fichiers, 139 tests** au moment de la livraison de l'étape 1.

| Fichier | Ce qu'il protège |
|---|---|
| `tests/integration/queue-claim.test.ts` | réservation atomique concurrente (12 jobs, 4 workers), priorité, déduplication, reprise de lease sans tentative supplémentaire, heartbeat, progression |
| `tests/integration/queue-retry.test.ts` | backoff ±20 %, épuisement des tentatives, erreur non réessayable, **jamais de reprise sur un résultat ambigu**, annulation ≠ échec, mode hors ligne, journal `job_events` |
| `tests/integration/noop-job.test.ts` | chaîne complète : job terminé, 6 événements ordonnés, ligne `llm_calls` avec coût calculé, reprise après crash, déduplication |
| `tests/integration/migrations.test.ts` | 13 tables, idempotence, index partiel « un seul fournisseur par défaut », unicité de `(type, dedupe_key)`, séquence d'événements, clés étrangères, JSON validé |
| `tests/integration/api.test.ts` | diagnostic, liste des jobs, 404 typé sans trace de pile, flux SSE avec état complet puis `done` |
| `tests/integration/budget.test.ts` | agrégation jour/mois, seuils de mode économie, plafond dur, `app_settings.daily_budget_usd` |
| `tests/integration/prompts.test.ts` | synchronisation idempotente, nouvelle version + ancienne désactivée, en-tête invalide refusé |
| `packages/ai`, `packages/queue`, `packages/analytics`, `packages/core`, `packages/config`, `packages/shared`, `packages/observability` | calcul de coût, backoff, politique de reprise, enregistrement des appels, veto de budget, diagnostic, validation d'environnement, rédaction, temps, identifiants |

**Trois bugs réels trouvés par ces tests et corrigés** — c'est le meilleur argument pour les écrire
avant les fonctionnalités :

1. **récursion infinie de la rédaction** sur un objet circulaire (journal d'une requête Fastify) :
   `RangeError: Maximum call stack size exceeded` au premier appel réel — corrigé par un `WeakSet` de
   suivi, une profondeur bornée et un résumé des objets de transport ;
2. **fuite de secret par le message et la pile** : pino ne passe pas le message à `formatters.log` ;
   la rédaction du message passe désormais par `hooks.logMethod`, celle de la pile par la rédaction
   de l'erreur — détecté par `pnpm check:canary`, puis figé par un test ;
3. **racine du dépôt déduite du `cwd`** : `pnpm dev:worker` refusait de démarrer (clés introuvables)
   et aurait créé une base par application — corrigé par `findWorkspaceRoot()` et un test ;
4. **quatre fichiers silencieusement absents du dépôt** : la règle `.gitignore` `media/` masquait
   aussi `packages/media/` (le paquet réservé) et `prompts/media/`. Détecté en relisant `git ls-files`
   après le premier commit : tout stockage local vit désormais uniquement sous `data/`, et un dossier
   de code ne peut plus être ignoré par accident.

**Ce qui n'est pas testé, et assumé** : le rendu visuel de l'écran de diagnostic (aucun test
d'interface à l'étape 1) ; les comportements liés à `FFmpeg` et `whisper` (pas encore de code) ; les
performances sous charge (il n'y a pas de charge) ; la suite `live` contre des fournisseurs réels
(aucun fournisseur réel).

---

## 6. Points laissés ouverts pour l'étape 2

| Point | Pourquoi il n'est pas tranché ici | À trancher |
|---|---|---|
| Constat de latence de la file (jusqu'à `WORKER_POLL_MS`, 60 s) | Valeur documentée (docs/08 §2.1) ; sans conséquence tant qu'aucun utilisateur n'attend un résultat | Étape 4 : notification d'enqueue ou `pollMs` adaptatif |
| Ajout des clés étrangères vers les tables des étapes 2, 4 et 5 | SQLite exige une reconstruction de table : ce sera fait par la migration qui crée la table cible | Étapes 2, 4, 5 |
| Politique de rétention de `job_events` | `purgeJobEventsBefore()` existe et est testable ; la purge automatique demandera un job récurrent | Étape 11 (analytics, jobs cron) |
| `SETTINGS_SCHEMAS` (un schéma Zod par clé de `app_settings`) | Une seule clé est lue aujourd'hui (`timezone`, `daily_budget_usd`) ; la table clé/valeur ne doit pas se remplir de schémas inutilisés | Étape 3 (réglages du fournisseur IA) |
| Écran de réglages et génération de `ENCRYPTION_KEY` depuis l'interface | `docs/10 §4.1` interdit le panneau de réglages à cette étape ; la commande `openssl` documentée suffit | Étape 4 |

| **M12** | **`findWorkspaceRoot()` : la racine du dépôt, pas le dossier courant** | Bug réel découvert en exécution : lancé depuis `apps/worker`, le worker cherchait `.env` et `data/app.db` dans son propre dossier — il refusait de démarrer, ou pire, créait une base par application. La racine est désormais trouvée en remontant jusqu'à `pnpm-workspace.yaml` | Déduire la racine du `cwd` (le comportement fautif) |
