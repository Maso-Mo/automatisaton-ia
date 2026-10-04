# Mise en œuvre — étape 12 : fiabilisation finale et exploitation locale

## 1. Périmètre livré

L'étape 12 ne crée **aucune table** et ne modifie **aucune règle métier**. Elle répond à une
question que les onze étapes précédentes avaient laissée ouverte : *le produit est-il
exploitable ?* — c'est-à-dire installable sur une machine neuve, sauvegardable, restaurable,
supervisable, accessible depuis un téléphone, et honnête sur ce qui manque.

Ce qui a été construit :

| Domaine | Livré |
|---|---|
| Démarrage | `pnpm setup` (dossiers, `.env` à clé générée, migrations), `pnpm preflight` (gate bloquant/optionnel), `pnpm app:start` |
| Sauvegarde | `pnpm backup` — `VACUUM INTO` de la base + manifeste SHA-256 des médias (décision D5) |
| Restauration | `pnpm restore` — validation, sauvegarde de sécurité, remplacement, re-migration, `--yes` obligatoire |
| Portabilité des données | `pnpm export` — JSON lisible, filtre de colonnes sensibles **structurel** |
| Résilience | Un service optionnel absent dégrade une fonction, jamais le démarrage |
| Sondes | `GET /health`, `GET /ready` (503 tant que la base ou un dossier d'écriture manque) |
| Exploitation | `GET /system/diagnostics` + panneau web « Exploitation » |
| Journalisation | Écriture fichier avec **rotation bornée** (`LOG_MAX_BYTES`, `LOG_MAX_FILES`) |
| Accès distant | `AUTH_TOKEN` (en-tête ou URL pour les lectures), guide LAN et Tailscale |
| Installation | Manifeste PWA, icônes, service worker minimal (hors ligne) |
| Tests | Rotation, manifeste, accès par jeton, sauvegarde/restauration, migration ascendante, parcours d'exploitation |

**Écart assumé par rapport à [`10-plan-de-developpement-12-etapes.md`](10-plan-de-developpement-12-etapes.md)
§4.12** : ce document de plan annonçait aussi un dialecte PostgreSQL testé et des conteneurs
`Dockerfile`/`docker-compose`. Ils **ne sont pas livrés ici**, et c'est écrit plutôt que
sous-entendu (§13). Le critère de sortie réellement visé était l'exploitation du produit *sur le
poste de l'utilisateur*, où il tourne ; la portabilité du modèle de données ne se vérifie pas en
ajoutant un dialecte non utilisé.

## 2. Démarrage : installation, préflight, lancement

```text
pnpm install            # dépendances
pnpm setup              # dossiers + .env (clés générées) + migrations
pnpm preflight          # « puis-je démarrer ? » — bloquant ou non, explicitement
pnpm app:start          # préflight puis API + worker + interface
```

Trois décisions tenables :

1. **`setup` ne réécrit jamais un `.env` existant.** Il ne génère que les deux clés locales
   (`SESSION_SECRET`, `ENCRYPTION_KEY`) et laisse vides les clés de fournisseur. Une clé de
   fournisseur effacée par mégarde ne se récupère pas ; l'écraser serait la seule erreur
   irréversible de cette commande.
2. **`preflight` sépare bloquant et optionnel.** Node < 20, pnpm absent, module `better-sqlite3`
   non compilé, `SESSION_SECRET`/`ENCRYPTION_KEY` manquants ou port occupé → sortie en erreur.
   FFmpeg, Whisper, clé IA absents → avertissement, et `app:start` démarre quand même. Un
   préflight qui refuse de démarrer pour un service optionnel rendrait l'installation plus
   fragile que le produit.
3. **`pnpm app:start` enchaîne le préflight.** Le contrôle n'est pas un rituel à retenir : il est
   dans la commande qui démarre.

## 3. Secrets et revue de sécurité

La politique de [`07-securite-secrets-auth.md`](07-securite-secrets-auth.md) est conservée, et
trois points ont été **vérifiés** plutôt que supposés :

- **Aucun secret n'est jamais renvoyé par l'API.** Le diagnostic expose `configured: true/false`
  pour chaque service, jamais une valeur — un test le vérifie en cherchant la valeur factice dans
  le corps de la réponse et dans les journaux.
- **Aucun secret n'est exporté.** Le filtre est structurel : une colonne dont le nom correspond à
  `token|secret|password|credential|api_key|private` est exclue. Il ne dépend pas de la vigilance
  de qui ajoute une colonne plus tard.
- **Le jeton d'accès ne finit jamais dans un journal.** Il peut arriver en paramètre d'URL (les
  balises `<img>`/`<video>` et `EventSource` ne portent pas d'en-tête) ; toutes les URL
  journalisées ou renvoyées dans un message d'erreur passent par `redactToken()`, y compris
  celles du gestionnaire d'erreurs et du `setNotFoundHandler`.

La revue a produit **une correction de fond** : `AUTH_TOKEN` accepté en URL **uniquement pour
`GET`/`HEAD`**. Accepter un jeton d'URL sur une écriture aurait transformé un jeton de périmètre en
paramètre d'action rejouable depuis un historique de navigation.


## 4. Sauvegarde de la base : `VACUUM INTO`, jamais `cp`

Une base SQLite vivante en mode WAL **ne se copie pas naïvement** : un `cp` peut produire un
fichier déchiré, référençant une page non encore écrite, ou amputé d'une transaction validée à
l'instant de la copie. La seule méthode sûre est `VACUUM INTO`, qui écrit un fichier
transactionnellement cohérent et compacté, sans bloquer durablement la base.

```text
backups/
  db/<horodatage>/app.db           # snapshot cohérent (VACUUM INTO)
  db/<horodatage>/metadata.json    # taille, sha256, migrations, dernier horodatage, version SQLite
  media/<horodatage>/manifest.json # chaque fichier + empreinte
  media/<horodatage>/files/…       # copie réelle (avec --media)
```

Chaque sauvegarde est **vérifiée sur place** avant d'être annoncée : `PRAGMA integrity_check`
(qui doit répondre `ok`) puis empreinte SHA-256 en flux (une base peut peser des gigaoctets).
Un fichier cible existant est remplacé, jamais refusé : relancer `pnpm backup` sur le même
horodatage doit être idempotent.

Un test le prouve sur une base **vivante** : la base reste utilisable après la sauvegarde (une
ligne ajoutée ensuite ne se retrouve **pas** dans la copie), et l'empreinte relue correspond à
celle du moment.

## 5. Sauvegarde des médias : un manifeste, pas une promesse

Les médias suivent la décision **D5** ([`11-risques-decisions-et-limites.md`](11-risques-decisions-et-limites.md)
§3.5) : ils changent rarement, pèsent beaucoup, et ne doivent pas ralentir les snapshots de base.
Ils ont donc leur propre dossier et leur propre rythme — `pnpm backup` écrit toujours le
**manifeste**, et ne copie les fichiers qu'avec `--media`.

Le manifeste (`packages/media/src/manifest.ts`) liste chaque fichier avec sa taille et son
empreinte SHA-256, en clés POSIX (un manifeste écrit sous Windows reste lisible ailleurs). Les
fichiers `.part` sont ignorés : un téléversement interrompu n'est pas un média. La vérification
distingue **manquant** et **altéré** — deux causes différentes, deux actions différentes — et
détecte une altération de même taille, puisqu'elle compare l'empreinte et pas seulement la taille.

## 6. Restauration : trois règles, dans cet ordre

`pnpm restore` (script `scripts/restore.ts`) applique, dans l'ordre :

1. **Rien n'est écrasé sans preuve.** La sauvegarde est validée : lisibilité, `integrity_check`,
   et **empreinte SHA-256 identique** à celle du manifeste. Une sauvegarde illisible est refusée
   avec une ligne de message, pas une pile d'exception.
2. **L'état courant est conservé avant d'être remplacé.** Sauf `--no-safety`, la base actuelle est
   sauvegardée dans `pre-restore-<horodatage>` juste avant. Une restauration n'est jamais un aller
   sans retour.
3. **La restauration destructive exige `--yes`.** Sans lui, le script décrit exactement ce qu'il
   ferait, vérifie la sauvegarde, et ne touche à rien.

Après remplacement, les fichiers `-wal`/`-shm` de l'ancienne base sont supprimés (ils
appartiennent à la base remplacée, pas à la nouvelle) et les migrations sont réappliquées : une
sauvegarde prise à l'étape 8 remonte donc au schéma courant **sans intervention manuelle**, ce qui
est le critère de sortie de l'étape. Un test d'intégration le vérifie sur une base réellement
migrée à huit migrations, sauvegardée, restaurée puis migrée jusqu'à la version courante.

## 7. Résilience : ce qui manque est dit, pas contourné

La règle est unique et vaut pour chaque dépendance : **un service optionnel absent dégrade une
fonctionnalité, il n'empêche jamais de démarrer, et il est visible à l'écran.**

| Absent | Conséquence réelle | Ce qui l'annonce |
|---|---|---|
| FFmpeg / ffprobe | pas de montage vidéo | `preflight` (avertissement) + panneau Exploitation |
| Whisper (binaire ou modèle) | pas de transcription locale | idem ; la voix reste possible en saisie texte |
| Clé de fournisseur IA | pas de génération | avertissement de préflight + diagnostic |
| `AUTH_TOKEN` | accès local non protégé | avertissement au démarrage **si** `APP_HOST` n'est pas localhost |
| LinkedIn / Reddit / TikTok | publication API indisponible | paquet manuel niveau C, panneau Exploitation |

Aucun de ces cas ne produit d'échec différé : le produit ne se déclare jamais prêt à faire ce
qu'il ne peut pas faire. C'est la même règle que celle du frein de budget de l'étape 8 — retenir

## 8. Sondes et diagnostic d'exploitation

Trois routes, trois questions — les confondre est la source d'erreurs classiques (« le service
répond donc tout va bien ») :

| Route | Question | Coût | Comportement |
|---|---|---|---|
| `GET /health` | le processus est-il vivant ? | nul (aucune lecture de base) | toujours `200` |
| `GET /ready` | peut-on lui envoyer du travail ? | une lecture d'état + trois accès disque | `503` tant qu'un dossier d'écriture manque ou qu'une vérification est en erreur |
| `GET /system/diagnostics` | où en est-on ? | lecture disque + dernière sauvegarde + comptage | `200` avec l'état complet |

`/health` et `/ready` restent **publiques même avec `AUTH_TOKEN`** : un superviseur n'a pas à
connaître un secret pour savoir si un service est vivant ([`07`](07-securite-secrets-auth.md)),
et ces routes ne lisent aucune donnée utilisateur. `/ready` nomme en clair la vérification qui
bloque (`blocking[]`) : « pas prêt » sans cause est inactionnable.

Le panneau **Exploitation** de l'interface (vue *Diagnostic*) affiche : espace disque par dossier
(racine, médias, sauvegardes) avec une barre d'occupation, dernière sauvegarde (libellé, âge,
taille, empreinte, nombre total), jobs en échec ou morts, services configurés ou manquants, et
l'accès distant (§10). Il se rafraîchit toutes les 15 s et reste **replié par défaut** : c'est un
panneau d'exploitation, pas l'écran du quotidien.

## 9. Journaux : rotation bornée, jamais bloquante

Un worker qui tourne des mois remplit le disque d'une machine personnelle. `LOG_DIR`,
`LOG_MAX_BYTES` et `LOG_MAX_FILES` activent une destination fichier par processus (`api.log`,
`worker.log`) avec trois garanties (`packages/observability/src/rotate.ts`) :

1. **rotation par taille, synchrone et atomique** (`rename`) : jamais deux fichiers ouverts sur le
   même nom, jamais de ligne perdue au milieu d'un renommage ;
2. **nombre de fichiers borné** : `LOG_MAX_FILES` historiques plus le fichier courant, le plus
   ancien étant supprimé ;
3. **une écriture impossible ne casse rien** : le problème est signalé **une fois** sur la sortie
   d'erreur, puis l'application continue. Un journal cassé ne doit pas arrêter le produit.

`LOG_DIR` vide désactive l'écriture fichier : les journaux vont sur la sortie standard, comme
avant. La rotation n'est pas délégée à un `logrotate` externe, qui n'est pas disponible partout et
que personne ne configure sur un poste personnel.

## 10. Accès réseau local, mobile et distant

L'application écoute `127.0.0.1` par défaut. Pour la consulter depuis un téléphone :

```dotenv
APP_HOST=192.168.1.20        # l'adresse LAN de la machine — jamais 0.0.0.0 (refusé par la config)
AUTH_TOKEN=<openssl rand -hex 32>
```

Trois points, dans l'ordre où ils comptent :

1. **`0.0.0.0` est refusé par la configuration**, pas seulement déconseillé : écouter sur toutes
   les interfaces exposerait les jetons de publication au réseau local
   ([`07`](07-securite-secrets-auth.md) §3.1). Une adresse LAN explicite est acceptée.
2. **Dès que l'accès quitte `localhost`, un jeton est nécessaire.** S'il est absent, l'API
   **avertit au démarrage** avec la variable à définir — le refus par défaut, jamais l'oubli.
   Le jeton est fourni par `Authorization: Bearer …`, `X-Auth-Token: …`, ou `?token=…` pour les
   **lectures** uniquement (SSE, `<img>`, `<video>`).
3. **Hors du réseau local, un tunnel — pas une redirection de port.**
   [Tailscale](https://tailscale.com) est le chemin recommandé : le nom de machine reste privé,
   aucun port n'est ouvert sur la box, et `AUTH_TOKEN` reste requis (un tunnel authentifie des
   machines, pas des applications). Le guide pas à pas est dans
   [`guide-utilisation.md`](guide-utilisation.md).

L'interface est **responsive** (aucun écran ne suppose un large bandeau de navigation) et
**installable** : manifeste, icônes et service worker minimal. Hors ligne, la coquille s'ouvre et
annonce que l'API est injoignable — les données ne sont **jamais** inventées côté navigateur
(`/api/**` n'est jamais mis en cache).


## 11. Tests

Aucun test n'a été « ajouté pour la forme » : chaque fichier correspond à une affirmation qu'un
humain ne peut pas vérifier de mémoire.

| Test | Ce qu'il prouve |
|---|---|
| `packages/observability/src/rotate.test.ts` | rotation déclenchée par la taille, historique borné, réouverture après fermeture, écriture impossible sans interruption |
| `packages/media/src/manifest.test.ts` | clés POSIX, `.part` ignorés, dossier absent accepté, altéré ≠ manquant, altération de même taille détectée |
| `tests/integration/security-access.test.ts` | refus par défaut avec jeton, `Bearer` et `X-Auth-Token`, `?token=` en lecture **seulement**, `/health` et `/ready` publics, jeton absent des journaux et des réponses d'erreur, avertissement hors localhost |
| `tests/integration/diagnostics.test.ts` | `/health`, `/ready` (200 puis 503 si un dossier disparaît), diagnostic complet (disque, sauvegarde, échecs, services), aucune valeur de secret |
| `tests/integration/backup-restore-upgrade.test.ts` | snapshot cohérent d'une base vivante, empreinte vérifiable, refus d'un fichier absent ou tronqué, restauration d'une sauvegarde de l'étape 8 puis migration ascendante, `--yes` obligatoire, sauvegarde altérée refusée sans toucher à la cible |
| `tests/e2e/parcours-exploitation.spec.ts` | panneau Exploitation réel (disque, sauvegardes, services), champ de jeton mémorisé côté navigateur, manifeste + service worker servis, panne de l'API de diagnostic **visible** sans casser l'écran |

Deux tests d'intégration s'appuient sur des **processus réels** (`pnpm exec tsx scripts/restore.ts`)
et non sur une réimplémentation : ce qui est vérifié est le script que l'utilisateur lancera.

## 12. Décisions prises en chemin (M1 à M8)

| # | Décision | Pourquoi |
|---|---|---|
| M1 | `VACUUM INTO` plutôt qu'une copie de fichier | Une copie de base WAL vivante peut être déchirée sans que rien ne le signale |
| M2 | Base et médias sauvegardés séparément, avec manifeste | D5 : des rythmes et des volumes incomparables ; le manifeste rend la restauration **vérifiable** |
| M3 | Empreinte SHA-256 comparée avant toute restauration | Une sauvegarde non vérifiée n'est pas une sauvegarde |
| M4 | `--yes` obligatoire + sauvegarde de sécurité automatique | Une restauration est destructive ; elle doit exiger un geste explicite et rester réversible |
| M5 | `preflight` bloque sur les dépendances réellement bloquantes, avertit sinon | Un service optionnel absent ne doit pas empêcher de démarrer ni rester secret |
| M6 | `AUTH_TOKEN` en URL **uniquement pour `GET`/`HEAD`** | Nécessaire pour SSE et les balises média, inacceptable pour une écriture |
| M7 | `redactToken()` appliqué à *toutes* les URL journalisées | Un jeton oublié dans un seul journal est un jeton perdu |
| M8 | Service worker **en production seulement** | En développement, un cache de coquille ferait passer un artefact de cache pour un bug |

## 13. Limites et ce qui n'a pas été fait

- **PostgreSQL n'est pas livré.** La couche Drizzle et l'isolation de `packages/database` restent
  la condition de portabilité ([`02-architecture.md`](02-architecture.md) §16.10) ; le dialecte
  PostgreSQL n'a pas été exercé, donc **rien de cette étape ne prouve** qu'une migration serait
  sans effet sur le domaine. C'est un travail identifié, non une garantie implicite.
- **Pas de `Dockerfile` ni de `docker-compose`.** L'installation visée est `pnpm
  setup && pnpm app:start` sur le poste où le produit tourne ([`11`](11-risques-decisions-et-limites.md)
  §5.2). Les conteneurs restent pertinents pour une installation par un tiers.
- **Pas de sauvegarde chiffrée ni de copie hors site.** `pnpm backup` écrit à côté, dans
  `backups/` : un disque perdu reste un disque perdu. Le chiffrement de [`07`](07-securite-secrets-auth.md)
  §10.2 protège les **jetons en base**, pas une sauvegarde exportée.
- **Pas de planificateur de sauvegarde.** La commande est manuelle ; `cron`/`launchd` restent à la
  charge de l'utilisateur, faute de pouvoir tester sérieusement ce planificateur ici.
- **Le service worker ne met en cache que la coquille.** Aucune donnée n'est disponible hors
  ligne, et c'est intentionnel : une donnée périmée affichée comme vraie serait pire qu'un message
  d'indisponibilité.
- **La protection par jeton est un secret partagé, pas une authentification.** Pas de comptes, pas
  de révocation, pas de rotation automatique : ce serait du multi-utilisateur, interdit à cette
  étape ([`10`](10-plan-de-developpement-12-etapes.md) §4.12, interdits).
- **Le diagnostic ne teste pas les services par un appel réel** (pas d'appel réseau, pas de coinçage
  de modèle) : il vérifie présence de binaire, présence de modèle, présence de clé. Un service
  « configuré » peut donc échouer à l'usage — c'est visible dans les jobs en échec, comptés par le
  même panneau.

## 14. Ce qu'il ne faut PAS construire à ce stade

- pas de comptes, pas de rôles, pas de multi-utilisateur, pas de multi-tenant ;
- pas d'authentification complète (OAuth, sessions, révocation) : un jeton partagé suffit à un
  utilisateur unique ;
- pas d'orchestration (Kubernetes, service mesh), pas de file externe (Redis) ;
- pas de télémétrie sortante : le produit est local, ses mesures aussi ;
- pas de sauvegarde cloud automatique ni de fournisseur de stockage tiers ;
- pas de reprise après sinistre au-delà de ce que `pnpm restore` sait faire ;
- pas de fusion vers `main` sans validation explicite : cette étape produit un **incrément
  vérifié**, pas une mise en production.

plutôt que détruire, dire plutôt que supposer.
