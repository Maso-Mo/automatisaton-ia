# Guide d'utilisation

> Ce document s'adresse à **l'utilisateur du produit**, pas au développeur. Il décrit ce qu'on
> tape, ce qu'on voit et quoi faire quand quelque chose ne répond pas. La conception reste dans
> [`docs/`](README.md), et le récit d'exécution de l'étape 12 dans
> [`22-mise-en-oeuvre-etape-12.md`](22-mise-en-oeuvre-etape-12.md).

## 1. Ce qu'il faut sur la machine

| Élément | Requis | Rôle |
|---|---|---|
| Node.js ≥ 20 | **oui** | l'API, le worker et l'outillage |
| pnpm | **oui** | l'installation du dépôt |
| FFmpeg / ffprobe | non | montage vidéo (étapes 6 et 7) |
| whisper.cpp + modèle | non | transcription locale de la voix |
| Clé de fournisseur IA | non | génération de textes (DeepSeek par défaut) |

**Rien de ce qui est « non » n'empêche de démarrer.** Sans eux, la fonctionnalité correspondante
est annoncée comme non configurée dans le panneau *Exploitation*, et le reste fonctionne.

## 2. Installer, en quatre commandes

```bash
pnpm install          # dépendances du monorepo
pnpm setup            # dossiers + .env (deux clés générées) + migrations
pnpm preflight        # « puis-je démarrer ? » — la réponse est explicite
pnpm app:start        # préflight puis API + worker + interface
```

`pnpm setup` ne réécrit **jamais** un `.env` existant : il génère les deux clés locales
(`SESSION_SECRET`, `ENCRYPTION_KEY`) et laisse volontairement vides les clés de fournisseur. Un
`.env` déjà présent est conservé tel quel — c'est ce qui garantit qu'une clé de fournisseur ne
disparaît pas par accident.

`pnpm preflight` affiche une ligne par dépendance, avec ✅ ou ⚠️, et sort en erreur **seulement**
pour ce qui bloque réellement : Node trop ancien, module natif non compilé, clés locales
absentes, port déjà occupé.

Comptes rendus : `pnpm app:start` réenchaîne le préflight, il n'y a donc rien à retenir.

## 3. Configurer

Le fichier `.env` (créé depuis `.env.example`) est commenté ligne à ligne. Ce qui compte :

```dotenv
APP_ENV=development
APP_HOST=127.0.0.1              # jamais 0.0.0.0 (la configuration refuse)
APP_PORT=4317
APP_URL=http://127.0.0.1:5173

DATABASE_URL=file:./data/app.db
BACKUP_DIR=./backups
LOG_DIR=./logs                  # vide = journaux sur la sortie standard
LOG_MAX_BYTES=5242880           # 5 Mo par fichier
LOG_MAX_FILES=5                 # 5 historiques, plus le fichier courant

DAILY_BUDGET_USD=2
MONTHLY_BUDGET_USD=30
LLM_DEFAULT_PROVIDER=deepseek
DEEPSEEK_API_KEY=               # vide = génération indisponible, tout le reste marche

AUTH_TOKEN=                     # vide = accès local non protégé (défaut sûr en localhost)
```

- **Les clés de fournisseur vivent ici, jamais dans la base.** L'écran ne les affiche jamais,
  seulement « configuré » ou « non configuré ».
- **Le budget est un frein, pas une coupure** : au-delà du plafond, les jobs de génération sont
  *retenus* (ils attendent), ils ne sont pas détruits.
- **`AUTH_TOKEN` vide est le réglage correct en local.** Il devient obligatoire dès que
  l'application est joignable autrement que depuis `localhost` (§9 et §10).

## 4. Démarrer, arrêter

```bash
pnpm app:start     # préflight, puis API + worker + interface (Ctrl+C pour tout arrêter)
pnpm dev:api       # seulement l'API
pnpm dev:worker    # seulement le worker (nécessaire aux jobs)
pnpm dev:web       # seulement l'interface
```

Tant que le **worker** ne tourne pas, les jobs restent en attente : l'interface l'indique, et
l'écran de diagnostic montre le dernier battement de cœur du worker.

## 5. Utiliser l'interface

Dix vues, une barre de navigation :

| Vue | À quoi ça sert |
|---|---|
| **Aujourd'hui** | ce qui est dû aujourd'hui, ce qui attend une décision |
| **Calendrier** | organiser les publications futures, fuseau choisi explicitement |
| **News / Veille** | sources, score, vérification des faits, adaptation proposée |
| **Analytics** | mesures réelles, comparaison à une baseline, recommandations explicables |
| **Plan éditorial** | sujets proposés, angle retenu, cibles et génération |
| **Revue des contenus** | relire, corriger, approuver, rejeter, régénérer |
| **Montage vidéo** | importer, transcrire, proposer un plan, rendre un short vertical |
| **Conversation** | l'entretien qui construit la mémoire, puis la fiche maître à valider |
| **Projets** | la mémoire structurée : projets, faits, état de vérification |
| **Diagnostic** | le socle est-il en état ? + le panneau **Exploitation** (§12) |

Deux règles du produit sont visibles partout : **rien ne se publie ni ne se planifie sans
validation humaine**, et **aucune donnée n'est inventée** — une mesure absente est affichée comme

## 6. Sauvegarder (à faire régulièrement)

```bash
pnpm backup                  # base + manifeste des médias
pnpm backup -- --media       # + copie réelle des fichiers médias
pnpm backup -- --dir=/media/usb/backups   # sur un disque externe
```

Ce qui est écrit :

```text
backups/
  db/<horodatage>/app.db           # snapshot cohérent de la base
  db/<horodatage>/metadata.json    # taille, sha256, nombre de migrations
  media/<horodatage>/manifest.json # chaque média + empreinte
  media/<horodatage>/files/…       # uniquement avec --media
```

Trois choses à savoir :

- la base est sauvegardée par `VACUUM INTO`, **jamais** par une copie de fichier : une base
  ouverte en mode WAL ne se copie pas à la main sans risque ;
- le manifeste des médias **énumère** les fichiers avec leur empreinte : c'est ce qui permet de
  vérifier une restauration au lieu de l'espérer ;
- sauvegarder les médias à chaque fois n'est pas nécessaire : ils changent rarement. Un `pnpm
  backup` quotidien de la base et un `--media` hebdomadaire suffisent largement.

## 7. Restaurer

```bash
pnpm restore                                   # prévisualisation : rien n'est modifié
pnpm restore -- --label=20260310-120000 --yes  # restaure cette sauvegarde
pnpm restore -- --media --yes                  # restaure aussi les médias
```

Le script, dans l'ordre :

1. **valide** la sauvegarde (lisibilité, `integrity_check`, empreinte SHA-256) ;
2. **conserve** l'état courant dans `backups/db/pre-restore-<horodatage>` ;
3. **remplace** la base, supprime les fichiers `-wal`/`-shm` de l'ancienne, puis **remet le schéma
   à niveau** par les migrations.

Sans `--yes`, rien n'est touché : la prévisualisation indique ce qui serait remplacé. Une
sauvegarde altérée est refusée même avec `--yes`.

À la fin : redémarrer avec `pnpm app:start`.

## 8. Sortir ses données

```bash
pnpm export                                  # exports/<horodatage>/export.json
pnpm export -- --out=./mes-donnees.json
```

L'export contient projets, faits, conversations, contenus, publications, calendrier, veille et
mesures, en JSON lisible, avec la configuration **non secrète**. Les colonnes dont le nom évoque un
secret (jeton, secret, mot de passe, clé d'API) sont **exclues par construction**, pas par
vigilance : une colonne ajoutée demain qui s'appelle `xxx_token` ne sera pas exportée.

## 9. Consulter depuis un téléphone (réseau local)

1. Trouver l'adresse de la machine sur le réseau local (par exemple `192.168.1.20`).
2. Dans `.env` :

```dotenv
APP_HOST=192.168.1.20
AUTH_TOKEN=<openssl rand -hex 32>
```

3. Redémarrer (`pnpm app:start`), puis ouvrir `http://192.168.1.20:5173` sur le téléphone.
4. Dans **Diagnostic → Exploitation → Jeton d'accès**, coller le même jeton. Il est mémorisé dans
   ce navigateur et joint automatiquement aux requêtes ; il n'est **jamais** affiché ensuite.

Pourquoi un jeton devient obligatoire ici : dès que l'application écoute au-delà de `localhost`,
n'importe quel appareil du réseau peut l'atteindre. Le jeton est la seule barrière, et l'API
avertit au démarrage s'il manque.

`0.0.0.0` est **refusé** par la configuration : il exposerait l'application sur toutes les
interfaces, y compris les réseaux non maîtrisés.

## 10. Accès distant (hors du réseau local) avec Tailscale

Le chemin recommandé est un **tunnel**, jamais une redirection de port sur la box :

1. Installer [Tailscale](https://tailscale.com) sur la machine et sur le téléphone, se connecter
   avec le même compte.
2. Laisser `APP_HOST=127.0.0.1` (l'interface Vite écoute en local) et définir `AUTH_TOKEN`.
3. Depuis le téléphone, atteindre la machine par son nom Tailscale : `http://<machine>:5173`.
4. Coller le jeton dans **Diagnostic → Exploitation**, comme au §9.

Pourquoi ainsi :

- **aucun port ouvert sur Internet** : la machine reste invisible depuis l'extérieur ;
- **le tunnel authentifie des machines, pas l'application** — `AUTH_TOKEN` reste donc nécessaire ;
- le nom Tailscale est privé et stable, ce qui évite de dépendre d'une IP qui change.

## 11. Installer l'application sur l'écran d'accueil (PWA)

L'interface est servie avec un manifeste, des icônes et un service worker minimal :

- **Android / Chrome** : menu ⋮ → *Installer l'application* ;
- **iOS / Safari** : Partager → *Sur l'écran d'accueil*.

Hors ligne, l'application s'ouvre et indique que l'API est injoignable. Les données, elles, ne
sont **jamais** mises en cache : afficher une mesure périmée comme si elle était vraie serait pire
qu'un message d'indisponibilité.


## 12. Journaux et diagnostic : quoi regarder

- **`GET /health`** (`http://127.0.0.1:4317/health`) : le processus répond. Aucun accès base : à
  interroger sans crainte, notamment par un superviseur.
- **`GET /ready`** : l'application peut-elle travailler ? Une réponse `503` **nomme** ce qui
  bloque (base illisible, dossier média ou sauvegardes non inscriptible).
- **`GET /system/diagnostics`** : espace disque, dernière sauvegarde, jobs en échec, services
  configurés. C'est la version « machine » du panneau *Exploitation*.
- **Fichiers de journaux** : `logs/api.log` et `logs/worker.log` si `LOG_DIR` est défini, avec
  rotation (5 fichiers de 5 Mo par défaut) — le disque ne se remplit pas tout seul.

Le panneau **Exploitation** (vue *Diagnostic*) affiche les mêmes informations que les routes, avec
une barre d'occupation disque : vert en dessous de 85 %, ambre jusqu'à 95 %, rouge au-delà.

## 13. Dépannage

| Symptôme | Ce qui se passe | Quoi faire |
|---|---|---|
| « API injoignable » dans l'interface | l'API ne tourne pas | `pnpm dev:api` (ou `pnpm app:start`) |
| Les jobs restent « en attente » | le worker ne tourne pas | `pnpm dev:worker` |
| `Configuration invalide : APP_HOST …` | `0.0.0.0` est interdit | mettre l'adresse LAN explicite ou `127.0.0.1` |
| `401 UNAUTHORIZED` alors que l'écran s'ouvrait avant | `AUTH_TOKEN` a été défini côté serveur | coller le même jeton dans *Exploitation* |
| Avertissement `AUTH_TOKEN` au démarrage | l'API écoute hors localhost sans jeton | définir `AUTH_TOKEN`, ou revenir à `127.0.0.1` |
| Vidéo impossible : « FFmpeg non configuré » | FFmpeg absent du `PATH` | installer FFmpeg, ou accepter la dégradation |
| Voix impossible : « transcription non configurée » | binaire ou modèle Whisper absent | renseigner `WHISPER_BIN` / `WHISPER_MODEL_PATH` |
| Génération impossible : « aucune clé de fournisseur » | `DEEPSEEK_API_KEY` vide | renseigner la clé, ou utiliser les paquets manuels |
| Le disque se remplit | médias volumineux | `pnpm media:purge` (médias orphelins), puis vérifier l'espace dans *Exploitation* |
| `pnpm restore` refuse | empreinte incohérente ou fichier illisible | choisir une autre sauvegarde : une sauvegarde altérée ne se répare pas |
| Erreur `better-sqlite3` au démarrage | module natif non compilé pour cette version de Node | `pnpm rebuild better-sqlite3` |

## 14. Ce que le produit ne fait pas

- il **ne publie pas tout seul** : LinkedIn, Reddit, TikTok et YouTube passent par une
  approbation humaine, ou par un paquet manuel ;
- il **n'invente pas de mesure** : une statistique absente est absente ;
- il **ne travaille pas hors ligne** côté interface, et ne garde pas de copie locale des données ;
- il **n'est pas multi-utilisateur** : un seul utilisateur, un jeton de périmètre optionnel ;
- il **ne sauvegarde pas à votre place** : `pnpm backup` est une commande, pas un service ;
- il **ne se met pas à jour tout seul**, et ne contacte aucun service en dehors de ceux que vous
  avez configurés.

absente, pas comme zéro.
