# 15 — Mise en œuvre de l'étape 5 (qualité et publication manuelle)

> Compte rendu de ce qui est réellement livré pour `docs/10` §4.5. Le périmètre
> s'arrête au niveau C : aucune plateforme n'est appelée par API.

## 1. Résultat livré

L'étape 5 ferme la première boucle utile du produit :

```text
contenu généré → relecture → critic → fact_checker → correction éventuelle
→ approbation humaine explicite → paquet manuel → publication déclarée et tracée
```

Le dashboard permet de produire un plan, suivre la génération par SSE, ouvrir chaque
contenu, voir ses versions et avertissements, modifier ou régénérer, approuver ou rejeter,
configurer un compte manuel et préparer le paquet exact à publier. Le bouton « J'ai publié »
enregistre la version, le texte, la plateforme, le compte et l'horodatage exacts.

## 2. Critique éditoriale et vérification factuelle

Deux agents structurés et séparés sont ajoutés dans `packages/ai` :

- `critic` renvoie uniquement `verdict`, `score`, `notes` et `repetition_report`. Il juge et ne
  possède aucun champ permettant de réécrire le contenu ;
- `fact_checker` extrait les affirmations, leur type, leur vérifiabilité, leur preuve, leur risque
  et leur statut. Les résultats sont persistés dans `content_claims` ;
- une preuve `project_fact` n'est acceptée que si son identifiant correspond à un fait confirmé ;
- toute affirmation à risque élevé non étayée bloque l'approbation ;
- l'approbation exige les remarques des deux contrôleurs sur la version courante. Une modification
  ou une régénération crée une nouvelle version et impose donc de relancer les contrôles.

Les fournisseurs scriptés gardent les tests et le développement local déterministes. En
production, les mêmes contrats Zod encadrent les sorties des modèles.

## 3. Données et invariant d'approbation

La migration `0004_step_five_manual_publishing.sql` ajoute exactement cinq tables :

| Table | Rôle |
|---|---|
| `platform_accounts` | Compte par projet et plateforme, jetons chiffrés au repos |
| `project_platforms` | Activation, priorité et compte manuel par défaut |
| `manual_packages` | Paquet durable lié à une version précise |
| `publications` | Publication et état métier liés à la version et au compte exacts |
| `publication_attempts` | Tentative, requête exacte, résultat et durée |

Le déclencheur SQL `trg_publication_requires_approval` refuse toute insertion dans
`publications` si `content_versions.approved_at` est absent. Cette garde s'ajoute aux contrôles de
l'API : un autre appelant ou une régression applicative ne peut pas contourner l'approbation.
Les migrations sont testées sur une base vide, une base déjà peuplée et en réapplication.

## 4. Comptes et secrets

LinkedIn, Reddit, TikTok et YouTube sont configurables. Les jetons éventuels utilisent une
enveloppe AES-256-GCM `enc:v1:key_version:nonce:ciphertext:tag`, avec nonce aléatoire et données
authentifiées. Ils ne sont jamais renvoyés par l'API. Le test de chiffrement vérifie l'aller-retour,
le caractère non déterministe et le refus d'un ciphertext altéré ; le canari vérifie les logs.

À ce stade, un compte est une destination manuelle. Il n'y a ni OAuth complet, ni échange de
jeton avec une plateforme, ni promesse qu'un jeton stocké est utilisable par une API.

## 5. Contrat de connecteur et décision D1

`packages/publishing` porte un contrat unique `PlatformConnector` : capacités, authentification,
validation, brouillon, publication, planification, métriques et construction du paquet manuel.
Les quatre implémentations sont de niveau C : `publish`, `createDraft` et `schedule` répondent
`manual_required`. Les différences vivent dans une configuration de connecteur, jamais dans un
`if (platform === ...)` du domaine.

**D1 est tranchée : quatre plateformes en V1, LinkedIn + Reddit + TikTok + YouTube, toutes au
niveau C.** Le connecteur générique rend ce périmètre moins coûteux que les options historiques
1/2/3 plateformes, sans introduire quatre intégrations API fragiles. X reste hors périmètre.

## 6. Limites vérifiées le 2 octobre 2026

| Plateforme | Résultat de la vérification | Traitement |
|---|---|---|
| LinkedIn | La documentation officielle des Posts confirme les formes de posts, mais pas une limite de texte exploitable sur la page publique consultée | 3 000 caractères reste un avertissement prudent, jamais un faux blocage |
| Reddit | Une application officielle Devvit documente 300 caractères de titre et 40 000 de corps ; les règles de subreddit restent variables | Limites indicatives et règles du subreddit dans la checklist |
| TikTok | La référence Direct Post fixe la légende à 2 200 runes UTF-16 | Contrôle bloquant de la description |
| YouTube | La ressource `videos` fixe le titre à 100 caractères et la description à 5 000 octets UTF-8 | Contrôles bloquants sur les unités exactes |

Sources primaires : [LinkedIn Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/integrations/community-management/shares/posts-api),
[Reddit Devvit](https://developers.reddit.com/apps/rainpostink),
[TikTok Direct Post](https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post),
[YouTube Videos](https://developers.google.com/youtube/v3/docs/videos).

Chaque limite conserve sa source et sa date dans les capacités. Les valeurs instables ou non
normatives sont `advisory` et ne bloquent pas. Le script éditorial et la description de plateforme
restent deux notions distinctes ; un dépassement du budget éditorial est donc un avertissement.

## 7. Paquet manuel et traçabilité

Le paquet est construit uniquement depuis la version courante explicitement approuvée. Il contient
le texte, le titre, l'accroche, la description, les hashtags, les mentions, le média attendu le cas
échéant, la checklist, les instructions et le lien profond. Chaque bloc utile dispose d'une action
de copie dans le dashboard.

La confirmation « J'ai publié » vérifie encore le projet, la plateforme, le compte et
l'approbation, puis écrit dans une transaction `publications`, `publication_attempts` et
`manual_packages.marked_published_at`. Le contenu passe ensuite par `publishing` vers `published`.
La requête exacte conservée permet de prouver quel texte et quelle version ont été publiés.

## 8. Dashboard et temps réel

Le dashboard comporte cinq vues : plan, revue, conversation, projets et diagnostic. La revue
affiche une carte par cible, les blocages et avertissements, les claims, les remarques du critique
et du fact-checker, l'historique complet et le plafond de régénération. Le suivi de job utilise le
flux SSE existant et se resynchronise depuis le snapshot serveur après une coupure.

Le parcours Playwright traverse l'application sans court-circuit API : conversation, mémoire,
fiche maître, plan, génération par fournisseur scripté, SSE avec coupure/reprise, relecture,
contrôles, approbation, compte manuel, paquet et confirmation de publication. La portion paquet
manuel → confirmation est chronométrée et doit rester sous 60 secondes.

## 9. Correction de déduplication

La clé d'un job mono-cible confondait la génération initiale et la régénération car le mode était
absent. Elle est désormais `content:<mode>:<contentItemId>`. Un test de non-régression prouve que
`content:initial:…` et `content:regenerated:…` sont différents : une intention de régénération ne
peut plus être absorbée silencieusement par le job initial.

## 10. Décisions d'implémentation

| # | Décision | Raison |
|---|---|---|
| M21 | Le critique ne réécrit jamais | Séparer jugement et création évite qu'une validation change le texte examiné |
| M22 | Les claims sont attachés à une version | Une correction invalide nécessairement l'analyse précédente |
| M23 | Le veto factuel existe dans le domaine et la base garde la publication | Les prompts ne sont pas une barrière de sécurité |
| M24 | Niveau C commun aux quatre plateformes | Obtenir une V1 utile sans dépendre d'autorisations externes |
| M25 | Les limites non confirmées sont indicatives | Une donnée externe instable ne doit pas créer un faux refus |
| M26 | Le paquet est durable et lié à une version | Une copie éphémère ne permet pas d'auditer la publication |
| M27 | Le compte manuel n'expose aucun secret | Le navigateur n'a besoin que du libellé et de la destination |

## 11. Tests ajoutés

- contrats structurés `critic` et `fact_checker`, dont l'absence de champ de réécriture ;
- chiffrement AES-GCM et altération détectée ;
- conformité partagée des quatre connecteurs et comportement des limites ;
- migration vide/peuplée, cinq tables et déclencheur de publication ;
- intégration complète : veto d'un claim critique, contrôles persistés, jeton chiffré, paquet exact,
  publication impossible avant approbation, tentative et horodatage exacts ;
- régression de la clé de déduplication ;
- Playwright sur le parcours conversation → publication manuelle.

La séquence finale de validation est celle demandée : installation, format, types, lint, tests,
migrations, frontières, canari, environnement, build et E2E. Les nombres exacts sont consignés dans
le compte rendu Git de la livraison plutôt que recopiés ici, afin de ne pas devenir obsolètes.

## 12. Ce qui n'a volontairement pas été construit

- aucune publication réelle par API, aucun brouillon distant, aucune planification ;
- aucun scraping ni automatisation de navigateur pour publier ;
- aucun OAuth complet ou renouvellement automatique de jeton ;
- aucune étape 6 : adaptation média, calendrier et fonctionnalités suivantes restent hors scope ;
- aucune affirmation n'est promue en fait projet par le fact-checker ; il juge le contenu, il ne
  modifie pas la mémoire de l'utilisateur.

## 13. Points ouverts après l'étape 5

- mesurer les limites LinkedIn et Reddit contre des comptes réels sans les transformer en règles
  dures tant qu'une source normative ne les confirme pas ;
- décider séparément, à l'étape prévue, quels connecteurs méritent un niveau A ou B ;
- mesurer sur usage réel les seuils du critic et la fréquence des corrections humaines ;
- conserver D2 à D6 ouvertes selon leurs échéances documentées.

## 14. Définition de terminé

| Condition | Preuve |
|---|---|
| Parcours nominal utilisable | E2E complet par l'interface jusqu'à `published` |
| Aucune publication sans approbation | Contrôle API + déclencheur SQL + test d'insertion directe |
| Critique et vérification séparées | Deux agents, deux contrats, notes et claims persistés |
| Publication manuelle en moins de 60 s | Assertion temporelle Playwright |
| Jetons chiffrés et non exposés | Test AES-GCM, intégration API et canari |
| Texte/version/compte/heure exacts | `publications` + `publication_attempts` vérifiés en intégration |
| Migration sûre | Base vide, base peuplée et réapplication |
| Périmètre tenu | Niveau C seulement, étape 6 absente |
