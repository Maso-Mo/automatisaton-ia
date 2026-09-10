# 08 — Jobs, observabilité et coûts

> Répond aux sections 24, 25, 26, 31, 32, 42 et aux questions 19, 20, 30 du
> [cahier des charges](00-cahier-des-charges.md). S'appuie sur
> [`02-architecture.md`](02-architecture.md) §9.3 (contrat `Queue`) et §12 (modèle d'erreurs),
> [`03-modele-de-donnees.md`](03-modele-de-donnees.md) §14 (tables `jobs`, `job_events`,
> `llm_calls`), et [`05-pipelines.md`](05-pipelines.md) §2 (cycle de vie d'un job).

Ce document répond à trois questions très concrètes :

1. **Comment un job s'exécute et survit à un crash ?**
2. **Comment savoir en dix secondes pourquoi quelque chose a échoué ?**
3. **Combien ça coûte, et comment ne pas dépasser le budget sans le savoir ?**

---

## 1. Le principe : la file vit en base

**Il n'y a pas de Redis, pas de RabbitMQ, pas de BullMQ en V1.** La table `jobs` porte
simultanément la file d'attente, le lease d'exécution et l'historique. La justification complète est
dans [`02-architecture.md`](02-architecture.md) §9.3 et §14 ; les trois raisons essentielles :

| Raison | Détail |
|---|---|
| **Un service de moins** | Sur un PC modeste, chaque service permanent est un coût d'installation, de mise à jour et de panne |
| **Une seule source de vérité** | L'historique des jobs est dans la même base que les contenus : une requête suffit à relier les deux |
| **Migration possible plus tard** | L'abstraction `Queue` est un contrat ; `SqliteQueue` peut être remplacé par `RedisQueue` sans toucher au domaine |

**Le prix à payer, assumé :** la contention d'écriture sur SQLite. Elle est réelle, et c'est
pourquoi les jobs simultanés sont limités à 3 par défaut
([`05-pipelines.md`](05-pipelines.md) §10.2). En mono-utilisateur, cette limite n'est jamais
atteinte dans un usage normal.

---

## 2. La boucle du worker

### 2.1 Le cycle d'un tick

```text
toutes les 60 s (et immédiatement après la fin d'un job) :

  1. reclaimExpired()      jobs 'running' dont lease_expires_at < now → 'queued', attempt inchangé
  2. promoteScheduled()    available_at = now pour les jobs échus (retry, cron)
  3. enqueueCron()         crée les jobs récurrents dus, avec leur dedupe_key journalière
  4. claim(workerId, N)    réservation atomique des N jobs prioritaires
  5. run()                 exécution séquentielle, un job à la fois dans le worker
  6. heartbeat()           toutes les 10 s pendant l'exécution
```

### 2.2 La réservation atomique

```sql
-- Le cœur du système : une seule requête, aucune course possible.
BEGIN IMMEDIATE;
  UPDATE jobs
     SET status = 'running',
         worker_id = :workerId,
         started_at = :now,
         attempt = attempt + 1,
         lease_expires_at = :now + :leaseMs,
         heartbeat_at = :now
   WHERE id IN (
     SELECT id FROM jobs
      WHERE status = 'queued'
        AND available_at <= :now
        AND (:offline = 0 OR requires_network = 0)
      ORDER BY priority ASC, available_at ASC, created_at ASC
      LIMIT :n
   );
COMMIT;
```

**`BEGIN IMMEDIATE` et non `BEGIN`** : la transaction prend le verrou d'écriture immédiatement, ce
qui évite l'erreur `SQLITE_BUSY` qui survient quand deux transactions commencent en lecture puis
tentent d'écrire. C'est un détail d'implémentation **qui décide si la file fonctionne ou échoue
une fois sur cent**.

**`attempt` est incrémenté à la réservation, pas à l'échec.** Conséquence : un crash du worker
avant la fin du job compte quand même une tentative. C'est volontaire — sans cela, un job qui fait
planter le processus serait relancé indéfiniment, et on ne peut pas distinguer un crash d'un
redémarrage normal.

### 2.3 Lease et heartbeat

| Paramètre | Valeur | Raison |
|---|---|---|
| Heartbeat | Toutes les 10 s | Marque le job comme réellement en cours d'exécution |
| `leaseMs` (défaut) | 60 s | Tolère une pause de 50 s (recouvrement de la base, charge CPU) |
| `leaseMs` (jobs longs) | 5 min pour `render_video` | Un encodage FFmpeg peut bloquer le processus de plusieurs minutes |
| Reprise | `reclaimExpired()` remet en `queued`, `worker_id` remis à `null` | Un crash ne perd aucun job |

**Un job repris redémarre à sa dernière étape persistée**, pas au début : c'est le rôle de
`current_step` et des écritures d'étape ([`05-pipelines.md`](05-pipelines.md) §2.2). Un job sans
`current_step` persistant n'est pas « repris », il est « refait » — et refait veut dire repayé.

### 2.4 Arrêt propre

```text
SIGINT / SIGTERM reçu :
  1. cesser de réserver de nouveaux jobs
  2. laisser le job courant finir son étape en cours (pas d'interruption au milieu d'un appel LLM)
  3. libérer le lease (status='queued', worker_id=null) → reprise immédiate ailleurs
  4. fermer la base, vider les journaux
  5. si le délai dépasse 30 s : libérer le lease et sortir, le job sera repris par reclaimExpired
```

**« Ne pas interrompre au milieu d'un appel LLM »** est important pour le budget : un appel
interrompu côté client est facturé quand même. On termine l'appel, on écrit le résultat, puis on
s'arrête.

---

## 3. États d'un job et transitions

```text
                   ┌──────────────── repriorisation ───────────────┐
                   ▼                                               │
  queued ──claim──▶ running ──succès──▶ completed                 │
    ▲                 │                                            │
    │                 ├──échec réessayable & attempt < max ──▶ queued (available_at = backoff)
    │                 │
    │                 ├──échec réessayable & attempt = max ──▶ failed
    │                 │
    │                 ├──échec non réessayable ──────────────▶ failed
    │                 │
    │                 ├──annulation demandée ────────────────▶ cancelled
    │                 │
    │                 └──lease expiré (crash) ───────────────▶ queued ──┘
    │
    └──queue pleine / budget épuisé : le job reste queued, visible, avec la raison
```

| État | Sens | Visible dans l'interface |
|---|---|---|
| `queued` | En attente, `available_at` dans le futur pour un retry | Oui, avec le moment prévu et la raison de l'attente |
| `running` | Réservé par un worker, lease actif | Oui, avec l'étape courante et la progression |
| `completed` | Terminé avec succès | Oui |
| `failed` | Échec définitif (tentatives épuisées ou erreur non réessayable) | Oui, avec la cause et l'action possible |
| `cancelled` | Annulé par l'utilisateur ou remplacé | Oui, discret (pas une erreur) |
| `dead` | Échec répété qui a épuisé une politique (ex. `max_attempts` d'un job non réessayable) | Oui, dans une vue dédiée |

**`cancelled` n'est jamais `failed`.** Un utilisateur qui annule sa propre génération ne doit pas
voir une erreur ; il doit voir « annulé ». Cette distinction paraît cosmétique, elle ne l'est pas :
les statistiques d'échec pilotent les alertes, et une annulation qui compte comme un échec fausse
le signal.

**La reprise d'un job interrompu ne consomme pas de tentative supplémentaire** quand le lease a
expiré sans erreur applicative. Un crash du worker n'est pas un échec du job. Le distinguer évite
de faire échouer définitivement un travail long à cause de trois redémarrages.

---

## 4. Reprise après erreur — les neuf cas de la section 32

| Cas | Réaction | Mécanisme |
|---|---|---|
| **Erreur transitoire (5xx, réseau)** | Retry avec backoff | `attempt < max_attempts`, `available_at = now + backoff(attempt)` |
| **Crash du worker** | Reprise automatique | `reclaimExpired()` sur `lease_expires_at` |
| **Coupure réseau** | Les jobs `requires_network` restent `queued` | Mode hors ligne ([`05-pipelines.md`](05-pipelines.md) §10.4) |
| **Quota d'API atteint (429)** | Report, **pas** d'échec | `rate_limit_reset_at` respecté ([`06-connecteurs-et-publication.md`](06-connecteurs-et-publication.md) §9.1) |
| **API indisponible durablement** | Retry borné puis `failed` avec message explicite | Pas de retry infini |
| **Upload échoué** | Reprise à l'étape d'upload, fichier local conservé | `current_step` + média source intact |
| **Publication ambiguë** | **Aucun retry** | `needs_human_decision` ([`06-connecteurs-et-publication.md`](06-connecteurs-et-publication.md) §9.1) |
| **OAuth expiré** | 1 rafraîchissement, puis notification | `connection_state='expired'` |
| **Budget de job épuisé** | Arrêt propre du job, sortie partielle **non publiée** | Vérification avant appel ([`04-orchestrateur-et-agents-ia.md`](04-orchestrateur-et-agents-ia.md) §10) |

### 4.1 Les trois règles de retry

| Règle | Formulation |
|---|---|
| **1. On ne réessaie que ce qui est sûr** | Un effet de bord externe non confirmé n'est jamais réessayé automatiquement. C'est la règle qui protège des doublons |
| **2. Le backoff est exponentiel avec jitter** | 30 s, 2 min, 8 min, 32 min… + un aléa de ±20 %. Sans jitter, trois jobs qui échouent ensemble reviennent ensemble |
| **3. Le nombre de tentatives dépend de l'étape** | Un appel LLM : 3 tentatives. Un upload vidéo de 500 Mo : 1 seule (le coût d'un retry est réel) |

### 4.2 Le tableau de décision (implémenté par le worker)

Le worker applique [`02-architecture.md`](02-architecture.md) §12 **après** le handler, jamais le
handler lui-même. Un handler qui décide de ses propres retries rend le comportement global
imprévisible ; ici, la règle est unique et vérifiable.

| Nature de l'erreur | Réessayable ? | Effet |
|---|---|---|
| Erreur de programmation (`TypeError`…) | Non | `failed` + entrée dans `errors`, remontée comme un bug |
| Contenu refusé par la validation de sortie (3 réparations échouées) | Non | `failed` avec le contenu brut conservé |
| Timeout sur un appel idempotent | Oui | Retry |
| Timeout après envoi d'un effet de bord | Non | `ambiguous` |
| Erreur de configuration (`MissingCredentialError`) | Non | `failed` + invitation à configurer |
| Erreur de budget | Non | `cancelled` avec raison (ce n'est pas une panne) |

**`cancelled` pour un dépassement de budget** est un choix : un budget atteint n'est pas un
dysfonctionnement, c'est une décision de l'utilisateur qui produit son effet. Le présenter comme
`cancelled` avec la raison « budget hebdomadaire atteint » est exact ; `failed` serait alarmant à
tort.

---

## 5. Observabilité

### 5.1 Les cinq niveaux

| Niveau | Support | Volume | Usage |
|---|---|---|---|
| 1. Journal structuré | Fichiers, JSON par ligne, rotation | Élevé, éphémère | Débogage technique, corrélation |
| 2. `job_events` | Base, append-only | Moyen, 90 jours | Flux temps réel (SSE), progression, étapes |
| 3. `llm_calls` | Base | Moyen, 1 an | Coût, latence, qualité, empreinte de contexte |
| 4. `errors` | Base | Faible | Motifs récurrents, regroupement par signature |
| 5. `system_health` | Base | Faible | Vue instantanée : worker actif, disque, dernier job, clés présentes |

**Cinq niveaux et pas un seul, parce qu'ils répondent à des questions différentes.** Un journal
fichier ne permet pas de calculer un coût par semaine ; une table de coûts ne permet pas de voir
qu'un `ffmpeg` a échoué sur un codec précis. Les deux sont nécessaires.

### 5.2 Corrélation : les cinq identifiants

| Identifiant | Portée | Présent dans |
|---|---|---|
| `job_id` | Un travail | journal, `job_events`, `llm_calls`, `publication_attempts` |
| `request_id` | Un appel réseau | journal, `publication_attempts`, en-tête envoyé quand la plateforme le permet |
| `content_item_id` | Un contenu | journal, jobs, appels LLM, publications |
| `conversation_id` | Un échange | journal, messages, appels LLM |
| `context_fingerprint` | Un contexte de prompt | `llm_calls` (hash du contexte exact) |

**Un message de journal sans `job_id` est presque toujours inutile.** La règle est donc : tout
message produit pendant l'exécution d'un job porte `job_id` **et** l'étape courante. Le logger
l'ajoute automatiquement via un contexte asynchrone, pas à la main dans chaque appel.

**`context_fingerprint` (hash du contexte) est l'identifiant le plus utile pour la qualité.** Deux
appels avec la même empreinte et la même version de prompt doivent produire des résultats
comparables : si ce n'est pas le cas, la variance est due au modèle. Si l'empreinte change et que
la qualité change, la cause est le **contexte**. Sans lui, on ne sait jamais attribuer une
régression.

### 5.3 Temps réel : SSE et reprise

Le choix de SSE plutôt que WebSocket est justifié dans [`02-architecture.md`](02-architecture.md)
§13. Le point d'implémentation qui compte ici :

```text
GET /jobs/{id}/events?lastSequence=42   →  les événements 43, 44, 45…
```

**Chaque événement porte un `sequence` strictement croissant par job.** Le client stocke le dernier
numéro reçu et le renvoie à la reconnexion. Sans cela, une coupure d'une seconde au milieu d'une
génération fait perdre l'affichage des étapes intermédiaires — et l'utilisateur, ne voyant plus rien
avancer, croit à un blocage.

### 5.4 Ce que `system_health` affiche en une requête

| Indicateur | Ce qu'il révèle |
|---|---|
| Jobs `queued` / `running` et leur ancienneté | Un job `queued` depuis 20 minutes signale un worker mort ou une priorité insolvable |
| Age du dernier heartbeat | Le worker est-il vivant ? |
| Dernier job terminé et sa durée | Une durée anormale signale une régression de performance |
| Nombre de jobs `failed` sur 24 h | Alerte de santé réelle |
| Espace disque disponible | Le pipeline vidéo remplit un disque plus vite qu'on ne le croit |
| Présence des clés requises (booléens) | « La clé IA n'est pas configurée » plutôt qu'un échec au premier appel |
| Solde du budget (jour / semaine) | Le seul indicateur financier à voir en permanence |
| Version de la base et état des migrations | Un décalage explique des erreurs bizarres |

---

## 6. L'écran « pourquoi ça a échoué »

C'est le livrable concret de la section 42 du cahier des charges : « une interface permettant de
comprendre rapidement pourquoi une opération a échoué ». Voici sa spécification exacte.

### 6.1 Ce qui doit être visible sans déplier quoi que ce soit

```text
✗ Génération du contenu — LinkedIn « Retour d'expérience sur les files SQLite »
  Étape atteinte      : criticize (critique du brouillon)
  Durée totale        : 1 min 12 s
  Coût                : 0,081 USD  (3 appels : analyse 0,031 · rédaction 0,036 · critique 0,014)
  Cause               : Le critic a renvoyé un verdict « reject » après réécriture
  Message utilisateur : Le brouillon contredit un fait enregistré sur le projet :
                        « je maîtrise Redis en production » n'est pas défendable
                        (aucun fait équivalent enregistré).
  Actions possibles   : [Voir le brouillon] [Régénérer avec une consigne] [Ajouter un fait au projet]

  ▾ Détail technique (4 étapes, 3 appels LLM)
      analyse        0,031 USD   ✓ 2,1 s   strategist / extract_master_brief
      rédaction      0,036 USD   ✓ 38,4 s  platform_writer / generate_linkedin
      critique       0,014 USD   ✗ 8,2 s   critic / critique_draft → verdict: reject
```

### 6.2 Ce qui rend cet écran bon

| Élément | Pourquoi il est là |
|---|---|
| **Étape atteinte** | Dit exactement où le travail s'est arrêté, donc ce qui est déjà payé et conservé |
| **Coût réel** | Un échec a un prix ; le cacher fait croire que réessayer est gratuit |
| **Message utilisateur** | En français, avec la cause métier et non le code d'erreur |
| **Action(s) possible(s)** | Un écran d'erreur sans action est une impasse |
| **Détail technique replié** | Utile pour l'utilisateur avancé, sans être imposé |
| **Conservation du brouillon** | Refusé ne veut pas dire jeté : le contenu existe, la trace est complète |

### 6.3 La règle des messages

| Interdit | Attendu |
|---|---|
| `UNKNOWN_ERROR` | « L'API de génération n'a pas répondu dans les 60 secondes. Nouvelle tentative prévue à 14 h 32. » |
| `VALIDATION_FAILED` | « Le texte fait 3 412 caractères ; la limite LinkedIn est 3 000. » |
| Une trace de pile Node affichée | Une phrase + un bouton « copier les détails techniques » |

**Un message d'erreur doit nommer une action.** S'il n'y en a pas, c'est que l'utilisateur est
bloqué et qu'il faut le dire explicitement (à la place : « Régénérer » ou « Réessayer plus tard »).

---

## 7. Coûts : mesurer avant de limiter

### 7.1 L'unité : le micro-dollar en entier

**Tous les montants sont stockés en `micro_usd` entiers** (`1 USD = 1 000 000`), jamais en
flottant. Deux raisons :

1. **Un flottant ne s'additionne pas de façon fiable.** Sur des milliers d'appels à 0,000074 $,
   les arrondis dérivent.
2. **Un entier se somme, se compare et se plafonne sans ambiguïté** — y compris dans une clause
   `WHERE total < limit` exécutée par la base, ce qui permet un contrôle de budget **atomique**.

L'affichage convertit au dernier moment (`$0.0814`). Le stockage, jamais.

### 7.2 Les quatre sources de coût

| Source | Où c'est mesuré | Ordre de grandeur |
|---|---|---|
| **Appels LLM** | `llm_calls.cost_micro_usd` | 90–99 % du total |
| **API payantes tierces** | `jobs.cost_micro_usd` (part hors LLM) | Transcription, recherche web |
| **Publicité (section 24)** | Table de dépenses dédiée, saisie manuelle ou importée ⚠️ | Poste séparé, jamais mélangé au budget IA |
| **Infrastructure locale** | Non mesuré | Électricité, disque : hors périmètre, mais documenté comme coût réel |

**Séparer le coût IA du coût publicitaire est indispensable.** Le budget de référence (5 $/semaine)
concerne l'IA ; y ajouter la publicité ferait croire à un dépassement permanent alors que ce sont
deux décisions différentes.

### 7.3 Comment le coût d'un appel est calculé

```ts
cost_micro_usd = round(
  (prompt_tokens     - cached_tokens) * input_price_per_million  / 1_000_000 * 1_000_000
+ (cached_tokens)                     * cached_price_per_million / 1_000_000 * 1_000_000
+  completion_tokens                  * output_price_per_million / 1_000_000 * 1_000_000
)
```

Les prix sont une **table de configuration versionnée** (`llm_providers_config`), pas des constantes
dans le code : un changement de tarif ne doit pas demander un déploiement. Chaque prix porte une
date d'effet, ce qui permet de recalculer un coût historique avec le tarif de l'époque.

> ⚠️ À VÉRIFIER — les tarifs par million de jetons, la remise de cache et les règles de facturation
> de chaque fournisseur (DeepSeek, OpenAI, Anthropic, Gemini) doivent être confirmés à la source
> avant l'implémentation. Ne pas coder un tarif de mémoire.

**Le coût est écrit même en cas d'erreur partielle.** Un appel qui timeout après 40 000 jetons a
coûté ; `status='timeout'` avec un `cost_micro_usd` non nul est une ligne normale.

---

## 8. Budgets et plafonds

### 8.1 Les quatre niveaux de plafond

| Niveau | Table | Exemple | Effet |
|---|---|---|---|
| **Global jour** | `app_settings.daily_budget_usd` | 1,00 $ | Réglage simple, visible par l'utilisateur |
| **Global semaine** | `budget_limits` (`scope='global'`, `period='week'`) | 5,00 $ | Le budget de référence du cahier des charges |
| **Par projet** | `budget_limits` (`scope='project'`) | « Client A : 2 $/semaine » | Évite qu'un projet absorbe tout |
| **Par tâche** | `budget_limits` (`scope='task'`) | « veille : 0,50 $/jour » | Le filet le plus utile : la veille tourne toute seule |

**Le contrôle est fait avant l'appel, dans une seule requête, et il est atomique :**

```sql
-- Refuse l'appel si le total consommé dépasse le plafond du jour ou de la semaine.
SELECT 1 FROM (
  SELECT COALESCE(SUM(cost_micro_usd), 0) AS spent
    FROM llm_calls
   WHERE created_at >= :periodStart          -- borne calculée selon le fuseau configuré
) WHERE spent >= :limit;
```

**Pourquoi avant l'appel et non après :** après, l'argent est déjà dépensé. Le dépassement n'est
alors qu'un rapport. La vérification doit être un **veto**.

### 8.2 Le coût d'un dépassement : `hard_stop` ou avertissement

| Réglage | Comportement | Quand l'utiliser |
|---|---|---|
| `hard_stop = true` (défaut) | Les jobs consommateurs restent `queued` avec la raison « budget atteint » | Le défaut : on ne dépense pas sans décision |
| `hard_stop = false` | On continue, une notification est émise à 80 % puis à 100 % | Pour une semaine où l'on accepte de dépasser |

**Le job n'est pas annulé, il est retenu.** Rester `queued` avec la raison affichée permet de le
relancer d'un clic le lendemain, au lieu de le perdre et de devoir tout refaire.

### 8.3 L'estimation avant appel

Avant un appel coûteux (génération longue, analyse d'un document volumineux), le système
**estime** le coût et compare au budget restant :

```text
Estimation : ~74 000 jetons d'entrée, ~4 000 de sortie ≈ 0,021 USD
Budget du jour restant : 0,008 USD
→ L'appel est refusé avant d'être payé. Message : « Budget journalier insuffisant.
  Il reste 0,008 USD ; cet appel est estimé à 0,021 USD. »
```

`estimateCost()` fait partie du contrat `LLMProvider`
([`02-architecture.md`](02-architecture.md) §9.1) précisément pour cela. Estimation approximative
et refus explicite valent mieux qu'un dépassement découvert le lendemain.

### 8.4 La règle de la réservation

Pour éviter que trois jobs concurrents franchissent ensemble un plafond (chacun vérifiant « il
reste 0,02 $ » et chacun consommant 0,015 $), le contrôle et l'écriture se font dans **la même
transaction** que la réservation du job, ou avec une réservation de budget (`budget_reservations`)
⚠️ si la contention le justifie. En pratique, avec 3 jobs simultanés maximum, ce cas est rare —
mais il doit être connu comme un cas à traiter, pas découvert en production.

---

## 9. Six moyens de tenir un budget de 5 $/semaine

Dans l'ordre d'efficacité décroissante. Les cinq premiers sont dans le cahier des charges
(section 25) ; le sixième est le seul qui agit sur la cause.

| # | Moyen | Gain typique | Coût de mise en œuvre |
|---|---|---|---|
| 1 | **Contexte minimal** : n'envoyer que les faits pertinents du projet, pas toute la mémoire | 40–70 % | Faible — c'est un choix de conception, pas une optimisation |
| 2 | **Cache par `context_fingerprint`** : un même contexte + même prompt ne se paie pas deux fois | 10–30 % | Faible |
| 3 | **Déduplication** : `dedupe_key` empêche deux fois le même job planifié | Variable, élevé en veille | Quasi nul (contrainte de base) |
| 4 | **Routage par modèle** : modèle économique pour classer/résumer, modèle fort pour les tâches éditoriales | 20–50 % | Moyen — table de routage à définir |
| 5 | **Mode économie** : le système bascule automatiquement quand le budget mensuel descend sous un seuil | 30 % | Faible |
| 6 | **Faire moins** : 3 contenus de qualité par semaine plutôt que 12 médiocres | Facteur 3–4 | Aucun coût, mais demande une décision produit |

### 9.1 La table de routage par défaut

| Tâche | Modèle | Justification |
|---|---|---|
| Classification d'actualités, étiquetage, déduplication | Local ou économique | Tâche simple, sortie vérifiable, tolérance à l'erreur |
| Résumé court d'une source | Local ou économique | Idem |
| Transcription | Local (Whisper) | Déjà local par choix matériel ([`02-architecture.md`](02-architecture.md) §7) |
| Recherche sémantique, embeddings | Local | Aucun appel réseau, aucun coût |
| Rédaction éditoriale (stratégie, rédaction, critique, vérification) | Modèle fort | C'est là que l'argent est bien dépensé |
| Analyse de performance et plans d'amélioration | Modèle fort, une fois par semaine | Fréquence faible, valeur élevée |

**Règle explicite : le mode économie ne dégrade jamais la vérification factuelle ni la critique.**
Ce sont les deux étapes qui protègent l'utilisateur ; les couper pour économiser 0,01 $ est une
fausse économie. En mode économie, on réduit la **fréquence** et la **longueur**, jamais les
garde-fous.

### 9.2 Le mode économie

| Déclencheur | Effet | Retour à la normale |
|---|---|---|
| 80 % du budget mensuel consommé | Bascule sur modèles économiques partout où c'est possible ; réduit la veille à 1 exécution/jour | Automatique au changement de mois |
| 95 % | Ajoute un plafond strict sur les tâches non essentielles | Idem |
| 100 % | `hard_stop` sur tout sauf vérification d'un contenu déjà rédigé | Idem |

Le mode économie **change les modèles, pas les garde-fous** : le pipeline conserve sa structure, ses
validations et son approbation humaine.

---

## 10. Le tableau de bord des coûts

### 10.1 L'écran principal (section 25 du cahier des charges, complété)

```text
Budget IA — semaine du 6 au 12 octobre

  Plafond       5,00 USD
  Dépensé       1,43 USD   ██████░░░░░░░░░░░░░░  29 %
  Restant       3,57 USD
  Prévision fin de semaine  ≈ 2,10 USD   (rythme actuel)

  Par poste                              Par projet
  Conversation      0,12 USD             Client A           0,98 USD
  Veille (news)     0,09 USD             Projet perso       0,31 USD
  LinkedIn          0,07 USD              Veille seule       0,14 USD
  Reddit            0,06 USD
  Scripts vidéo     0,21 USD             Par modèle
  Développement     0,88 USD             fort            1,21 USD
                                         économique      0,22 USD

  ▾ Détail par jour      lun 0,21 · mar 0,34 · mer 0,18 · jeu 0,29 · ven 0,41 · sam 0 · dim 0
  ▾ Top 5 appels les plus chers
      veille / summarize_source        0,031 USD    412 000 jetons in
      linkedin / generate_linkedin     0,036 USD     19 400 jetons in
      …
```

**Trois choses font la différence avec un simple total :**

| Élément | Pourquoi |
|---|---|
| **La prévision de fin de semaine** | Un total sans projection n'indique pas s'il y a un problème. La projection est une extrapolation linéaire du rythme observé, et elle suffit à alerter |
| **Le coût par poste et par projet** | « 1,43 $ » n'explique rien. « La veille coûte 0,09 $ et le développement 0,88 $ » désigne le poste à corriger |
| **Le top des appels les plus chers** | Une ligne anormale (412 000 jetons d'entrée pour résumer un article) révèle un bug de contexte, pas un problème de tarif |

### 10.2 La vue par contenu

| Colonne | Sens |
|---|---|
| Coût total du contenu | Somme de tous les appels liés à ce contenu, du brief à la publication |
| Coût par étape | Permet de voir si la critique coûte plus que la rédaction |
| Coût des réessais | La part payée à cause d'échecs ou de régénérations |
| Coût par plateforme | Décline un même contenu sur 4 plateformes : ce qui coûte le plus |
| Coût vs performance | Le seul ratio qui compte : combien a coûté un contenu qui a bien marché |

**La colonne « coût des réessais » est la plus actionnable.** Un contenu qui coûte 0,30 $ dont
0,22 $ en réessais signale un problème de qualité de prompt, pas un problème de budget.

### 10.3 Le poste publicitaire : séparé et comparé (section 24)

| Donnée | Nature | Source |
|---|---|---|
| Contenu organique vs promu | Étiquette sur le contenu | Déclaré par l'utilisateur |
| Montant dépensé | Saisie manuelle en V1 ⚠️ | L'utilisateur (les API de publicité sont hors périmètre) |
| Période | Dates de début et de fin | Saisie manuelle |
| Impressions payées, conversions | Import manuel ou saisie ⚠️ | L'utilisateur |
| ROI comparé | Organique vs payant, durée de vie égale | Calcul |

**Formulation explicite : le système ne dépense jamais d'argent publicitaire tout seul.** Il
enregistre et compare. Un budget qui peut être dépensé automatiquement sur une plateforme externe
est une décision bien plus lourde que la même somme en appels LLM — et cela n'est pas demandé.

**Ce qui justifie le travail :** comparer organique et payant sur le **même contenu**. Cette
comparaison est impossible sans étiquette ni montant enregistrés dès le départ, ce qui justifie de
prévoir les champs maintenant même si l'interface arrive plus tard.

---

## 11. Alertes

| Alerte | Seuil | Canal | Fréquence maximale |
|---|---|---|---|
| Budget jour à 80 % | 80 % | Notification locale | 1 fois/jour |
| Budget semaine à 80 % | 80 % | Notification locale | 1 fois/semaine |
| Budget atteint | 100 % | Notification persistante + jobs retenus | 1 fois/période |
| Compte de plateforme expiré | À la détection | Notification persistante | 1 fois/7 jours |
| Publication ambiguë | À la détection | Notification persistante **prioritaire** | 1 fois/jour |
| Échecs répétés (> 5 en 1 h) | 5 échecs | Notification | 1 fois/heure |
| Aucun job exécuté depuis 24 h alors que la veille est active | 24 h | Notification | 1 fois/jour |
| Disque sous 10 % | 10 % | Notification persistante | 1 fois/jour |

**Pas d'alerte par e-mail, pas de webhook, pas de notification push.**
([`07-securite-secrets-auth.md`](07-securite-secrets-auth.md) §3). Une notification dans l'application est le seul canal,
et c'est suffisant pour un outil qu'on ouvre toutes les semaines. Ajouter un canal externe
signifierait gérer un service de plus, avec ses secrets et ses pannes.

**Une alerte doit se fermer toute seule.** Une notification qui reste après résolution du problème
(par exemple « budget atteint » encore affichée le mois suivant) apprend à ignorer les
notifications. Chaque alerte porte donc sa condition de disparition.

---

## 12. Fournisseurs IA vus sous l'angle du coût et de la fiabilité

Le contrat `LLMProvider` (`generate`, `structuredOutput`, `estimateCost`, `capabilities`,
`healthCheck`) est défini dans [`02-architecture.md`](02-architecture.md) §9.1. Ce qui compte ici,
c'est ce que l'exploitation exige de lui.

### 12.1 Ce que chaque capacité implique

| Méthode | Conséquence si elle est mal définie |
|---|---|
| `estimateCost()` | Le plafond n'est vérifiable qu'**après** paiement → §8.3 perd tout sens |
| `capabilities()` | On envoie un `json_schema` à un modèle qui ne le supporte pas → sorties invalides en série, donc coût de réparation |
| `healthCheck()` | Une panne de fournisseur se manifeste comme 40 jobs en échec au lieu d'un message clair |
| `structuredOutput()` | Sans validation locale du schéma, une réponse presque conforme devient un contenu presque correct |

### 12.2 Les cinq règles d'exploitation d'un fournisseur

| Règle | Formulation |
|---|---|
| **1. Un fournisseur par rôle, pas un fournisseur par défaut unique** | Le rôle « second avis » ([`04-orchestrateur-et-agents-ia.md`](04-orchestrateur-et-agents-ia.md)) doit par défaut être un **autre** fournisseur, sinon il ne détecte rien |
| **2. `healthCheck()` avant une longue série d'appels** | Un ping de 20 jetons coûte presque rien ; 40 jobs échoués coûtent cher |
| **3. Le changement de fournisseur ne touche pas les prompts** | Les prompts sont des fichiers indépendants du fournisseur ; un prompt qui contient « Tu es DeepSeek » est un bug |
| **4. Le prix vit en configuration, jamais dans le code** | §7.3 : sinon toute mise à jour de tarif demande un redéploiement |
| **5. Un fournisseur non configuré ne fait pas échouer le démarrage** | Il est désactivé et visible comme tel, avec le message « non configuré » |

### 12.3 La comparaison de fournisseurs

Un même contenu peut être généré par deux fournisseurs pour être comparé. Ce qui doit alors être
enregistré est déjà dans `llm_calls` : `provider`, `model`, `prompt_version_id`,
`context_fingerprint`, `cost_micro_usd`, `latency_ms`, `status`. La comparaison est donc une
**requête**, pas une fonctionnalité à construire :

```sql
-- Qualité perçue vs coût, par fournisseur, sur les 90 derniers jours
SELECT provider, model,
       COUNT(*)                            AS appels,
       SUM(cost_micro_usd) / 1000000.0     AS cout_usd,
       AVG(latency_ms)                     AS latence_moyenne_ms,
       SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS taux_succes
  FROM llm_calls
 WHERE created_at >= :since
 GROUP BY provider, model
 ORDER BY cout_usd DESC;
```

**Ce qui manque au modèle ne manque pas par hasard** : la qualité ne se mesure pas dans un `SUM`.
Elle vient de la note de `content_review_notes` ou des performances publiées
([`03-modele-de-donnees.md`](03-modele-de-donnees.md) §12). C'est la jonction entre le coût et la qualité, et elle
doit être explicitement calculée à part.

### 12.4 Modèles locaux : la règle de décision

Le partage local / cloud est posé dans [`02-architecture.md`](02-architecture.md) §7. Du point de
vue du coût, la règle se résume à une question :

> **Le coût d'un modèle local en temps et en fiabilité est-il inférieur au coût de l'appel
> distant ?**

| Tâche | Verdict | Raison |
|---|---|---|
| Transcription (Whisper) | **Local** | Payant à l'usage en distant, lent mais gratuit localement, et une transcription imparfaite se corrige |
| Embeddings, recherche sémantique | **Local** | Volume élevé, tolérance à l'imprécision, aucune dépendance réseau |
| Classification, étiquetage | **Local si possible** | Sortie courte ; un petit modèle suffit souvent |
| Rédaction, stratégie, critique, vérification factuelle | **Distant** | C'est le cœur de la valeur ; une erreur ici coûte plus que l'appel |

**Ce qui n'est jamais local :** la vérification factuelle et la critique. Ce sont les deux étapes
qui protègent l'utilisateur, et un petit modèle qui les exécute mal donne une fausse assurance.

**Le PC est modeste : c'est une contrainte, pas un détail.** Un modèle local qui rend le poste
inutilisable pendant une génération n'est pas une économie, c'est un problème d'ergonomie. Le
worker, la limite de concurrence et la priorité basse des jobs lourds existent pour cela.

---

## 13. Ce qu'il ne faut PAS construire (maintenant)

| Tentation | Pourquoi c'est refusé |
|---|---|
| **Redis / BullMQ / un courtier de messages** | Le contrat `Queue` suffit en mono-utilisateur. Un service permanent de plus à installer, surveiller et sauvegarder pour une charge de 3 jobs simultanés (§1) |
| **Grafana, Prometheus, OpenTelemetry, un collecteur de métriques** | Une pile d'observabilité complète pour une application qu'une seule personne ouvre. Cinq tables et une requête suffisent (§5.1) |
| **Une journalisation distribuée (Loki, ELK)** | Les journaux tiennent dans des fichiers sur la machine qui les produit ; les chercher ailleurs n'existe pas ici |
| **Un système d'alerte e-mail ou push** | Il faut un service tiers, des secrets, et une gestion d'échec d'envoi — pour un outil qu'on ouvre soi-même (§11) |
| **Un worker distribué sur plusieurs machines** | Le lease et la file sont conçus pour plusieurs workers, mais une seule machine les exécute. On garde la propriété, on ne construit pas la distribution |
| **Un suivi de coût en temps réel par flux (streaming token par token)** | Le coût final dépend des jetons facturés ; on écrit le coût à la fin de l'appel. Un compteur animé est décoratif |
| **Un budget par utilisateur, des quotas multi-locataires** | Un utilisateur. La comptabilité multi-locataire coûte en complexité et ne sert à rien |
| **Une refacturation, une facturation, un lien avec un système comptable** | Hors périmètre produit |
| **Une interface d'administration pour piloter la file à la main** (reprioriser 200 jobs, geler un type) | Le besoin réel est « annuler ce job » et « réessayer celui-là ». Le reste est un outil de développeur, pas une fonctionnalité |
| **Un mode « accéléré » qui augmente la concurrence** | Sur SQLite et un PC modeste, plus de concurrence ralentit l'ensemble. La limite de 3 est une décision de performance (§1) |
| **Un compteur d'appels API « par seconde » affiché en direct** | Aucune décision ne s'en déduit |

**Le fil commun de ces refus :** l'observabilité utile ici est **post-mortem et requêtable**, pas
**temps réel et distribuée**. Un tableau de bord temps réel, un vrai système de métriques et une
pile de journaux ont tous été écartés pour la même raison — ils servent à surveiller un système
qu'on ne comprend pas, alors que celui-ci est petit, local, et qu'on peut l'interroger directement
avec SQL.

---

## 14. Synthèse

### 14.1 Les huit décisions de ce document

| # | Décision | Où |
|---|---|---|
| 1 | La file vit dans la table `jobs` ; pas de Redis en V1 | §1 |
| 2 | Réservation atomique avec `BEGIN IMMEDIATE` ; `attempt` incrémenté à la réservation | §2.2 |
| 3 | Lease 60 s + heartbeat 10 s ; `reclaimExpired` garantit qu'un crash ne perd aucun job | §2.3 |
| 4 | Un retry n'est jamais appliqué à un effet de bord non confirmé | §4.1 |
| 5 | Cinq niveaux d'observabilité, cinq identifiants de corrélation, SSE reprenable par `sequence` | §5 |
| 6 | L'écran d'échec affiche l'étape atteinte, le coût réel et une action possible | §6 |
| 7 | Tout montant en `micro_usd` entier ; contrôle de budget **avant** l'appel | §7.1, §8.1 |
| 8 | Le mode économie réduit la fréquence et la longueur, **jamais** les garde-fous | §9.2 |

### 14.2 Les trois questions auxquelles ce document répond, en une phrase

| Question | Réponse |
|---|---|
| Comment un job survit-il à un crash ? | Par un lease en base : le job est remis en file par `reclaimExpired` et reprend à sa dernière étape persistée |
| Comment savoir pourquoi ça a échoué ? | Par `job_events` + `llm_calls` reliés par `job_id` : étape atteinte, coût réel, cause métier et action possible |
| Comment ne pas dépasser 5 $/semaine ? | Par un contexte minimal (§9, moyen n° 1), un veto de budget **avant** chaque appel et une alerte à 80 % |

### 14.3 Renvois

| Sujet | Document |
|---|---|
| Contrat `Queue`, modèle d'erreurs, SSE, local/cloud | [`02-architecture.md`](02-architecture.md) §9.3, §12, §13, §7 |
| Tables `jobs`, `job_events`, `llm_calls`, `budget_limits`, rétention | [`03-modele-de-donnees.md`](03-modele-de-donnees.md) §4.4, §14, §16.1 |
| Cycle de vie d'un job, étapes persistées, concurrence, planificateur | [`05-pipelines.md`](05-pipelines.md) §2, §10 |
| Vérification du budget par l'orchestrateur | [`04-orchestrateur-et-agents-ia.md`](04-orchestrateur-et-agents-ia.md) §10 |
| `rate_limited`, `ambiguous`, jetons, quotas d'API | [`06-connecteurs-et-publication.md`](06-connecteurs-et-publication.md) §9, §10 |
| Rédaction des journaux, absence de secrets | [`07-securite-secrets-auth.md`](07-securite-secrets-auth.md) §9 |
| Tests de la file (crash, reprise, doublons, budget) | [`09-tests-et-qualite.md`](09-tests-et-qualite.md) |

---

*Fin du document. La file, la reprise après erreur, l'observabilité, le coût et les budgets sont
spécifiés ; la stratégie de vérification qui prouve que tout cela fonctionne est traitée dans
[`09-tests-et-qualite.md`](09-tests-et-qualite.md).*







