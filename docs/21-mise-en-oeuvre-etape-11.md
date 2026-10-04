# Mise en œuvre — étape 11 : analytics, apprentissage et Viral Pattern Engine

## 1. Périmètre livré

L'étape 11 ferme la boucle `publication → mesure → association → recommandation`, sans
publication autonome et sans métrique inventée. Elle ajoute deux tables
(`external_content_examples`, `content_feature_sets`), complète les réceptacles de l'étape 8,
expose une API et deux sections d'interface (`Analytics`, `Viral Research`), et exécute quatre
jobs ciblables : `collect_metrics`, `analyze_performance`, `extract_content_features` et
`rebuild_patterns`.

Le système fonctionne sans API sociale : saisie manuelle et import JSON sont des chemins de
première classe. `PlatformConnector.fetchMetrics()` reste prioritaire lorsqu'un compte déclare
réellement la capacité analytics.

## 2. Métriques et snapshots

Un snapshot conserve la publication, la plateforme, `captured_at`, la provenance, la méthode de
collecte, les métriques communes et un JSON réservé aux métriques propres à la plateforme. Les
valeurs inconnues sont `NULL`, jamais `0`. L'unicité
`(publication_id, captured_at, source)` rend une reprise idempotente tout en conservant plusieurs
points le même jour (T+1 h, T+6 h, T+24 h).

Les métriques prises en charge sont : vues, impressions, portée, likes, commentaires, partages,
sauvegardes, clics, abonnements gagnés, temps de visionnage, durée moyenne, complétion, visites de
profil et taille du compte au moment de publier. Le payload brut est auditable sans jeton.

## 3. Normalisation et définition de la performance

Les taux utilisent, dans cet ordre explicite, impressions, portée puis vues. Sont calculés et
stockés : engagement, partage, sauvegarde, commentaire, CTR, vélocité des vues, performance
relative et percentile. La taille du compte est utilisée quand elle est connue ; les comparaisons
sont regroupées par plateforme et, dans le moteur de patterns, par niche et type de contenu.

La classification est relative à la médiane comparable :

- `< 70 %` : `UNDERPERFORMING` ;
- `70–129 %` : `NORMAL` ;
- `130–249 %` : `STRONG` ;
- `≥ 250 %` : `BREAKOUT` ;
- `VIRAL` seulement à partir de 50 références et `≥ 500 %`.

Sans valeur relative ou avec moins de trois références, l'écran dit que la référence est
insuffisante et n'affirme aucune anomalie. Chaque classe fournit une raison lisible.

## 4. Viral Pattern Engine, datasets et baseline

`ViralPatternEngine` est déterministe. Il transforme les contenus en caractéristiques abstraites :
type de hook, structure, classe de longueur, CTA, niveau technique, présence de sous-titres,
classe de durée et rythme visuel. Il ne conserve ni ne recommande de recopier un script tiers.

Chaque groupe positif est comparé aux contenus du même contexte qui ne portent pas cette valeur.
Il faut au moins cinq positifs et cinq éléments de baseline. Cette comparaison gagnant/baseline
évite le biais du survivant : si 50 contenus sous-titrés et 50 non sous-titrés ont la même
performance, le pattern est `REJECTED`.

Les données personnelles ont un poids trois fois supérieur aux exemples publics dans le calcul de
l'effet médian. Les exemples publics aident donc le cold start ; l'historique du compte reprend
progressivement la priorité.

## 5. Confidence, statuts et learnings

La confiance combine taille d'échantillon, qualité/provenance, amplitude de l'effet et pénalité de
variance. Les seuils sont : moins de 5 = aucune conclusion ; 5–19 = `EXPERIMENTAL` ; 20–49 =
`LIKELY` possible ; 50+ = `SUPPORTED` possible si confiance ≥ 70. Un effet absolu inférieur à
10 % est rejeté, quel que soit le volume.

Un `PerformancePattern` conserve contexte, caractéristique, effet observé, tailles positive et
baseline, confiance, période et IDs de preuve. Les patterns `LIKELY` ou `SUPPORTED` produisent un
learning persistant. Le texte emploie « associé à », jamais « cause ».

Le cold start est explicite : 0 ou 3 observations ne produisent pas de pattern ; les exemples
publics à faible confiance peuvent amorcer `EXPERIMENTAL` ; 20 et 100 observations peuvent faire
évoluer le statut si l'effet est stable.

## 6. Analyse vidéo locale

L'extraction réutilise les métadonnées déjà obtenues par `ffprobe` lors de l'import, la
transcription locale et ses timestamps : durée, résolution, fps, durée moyenne des phrases et
densité de parole. L'extracteur accepte aussi des changements de scène simples pour calculer leur
nombre, leur intervalle et une classe de rythme. Une valeur non disponible reste `NULL` ou
`unknown`; aucune dépendance ML lourde n'a été ajoutée.

Le temps d'extraction et le temps de reconstruction sont mesurés et enregistrés dans les lignes ou
événements de job. Aucun chiffre de performance n'est annoncé sans mesure réelle.

## 7. Exemples externes

`ExternalContentExample` stocke seulement URL, plateforme, créateur éventuel, dates, compteurs
éventuels, abonnés éventuels, durée, titre descriptif, sujet, provenance, confiance et
caractéristiques abstraites. Les sources acceptées sont les URL utilisateur, exports/imports et
providers officiels. Aucun téléchargement massif, scraping agressif, contournement ou copie longue
n'est implémenté. Une URL est dédupliquée par projet et peut être incluse ou exclue de
l'apprentissage.

## 8. PerformanceAdvisor et intégrations

`PerformanceAdvisor` filtre plateforme, niche et type de contenu, écarte les patterns rejetés,
priorise les preuves personnelles et rend recommandation, raison, confiance et IDs de preuve.
Quatre recommandations maximum sont injectées au `platform_writer` et au `media_planner` sous
`PERFORMANCE GUIDANCE`. Le prompt précise qu'elles sont facultatives et corrélationnelles ; les
contraintes de plateforme et vidéo restent prioritaires.

Le calendrier n'est jamais déplacé automatiquement. L'endpoint analytics crée uniquement une
`CalendarChangeProposal`, avec le pattern et la confiance dans la raison ; l'utilisateur doit
l'accepter par le flux existant. Les colonnes `experiment_key` et `experiment_variant` préparent
des comparaisons A/B simples sans lancement automatique massif. Les annotations news existantes ne
sont pas dupliquées.

## 9. Interface

La page Analytics affiche synthèse par plateforme, snapshots, top contenus, contenus faibles,
classe relative et raison. Elle permet la saisie manuelle en distinguant champ vide et zéro, puis
lance l'analyse. `Patterns détectés` expose effet, échantillon, baseline, confiance, statut et
preuves.

`Viral Research` permet d'ajouter une URL et des compteurs publics, de déclencher l'extraction et
d'inclure/exclure l'exemple. Les formulaires et cartes utilisent des grilles adaptatives pour les
petits écrans. Aucun SSE analytics n'a été ajouté : un rafraîchissement léger de 5 secondes suffit
pour ces jobs batch et évite un flux supplémentaire.

## 10. Jobs, coûts et performance locale

Les quatre jobs sont idempotents, retryables, dédupliqués, observables et récupérables après
expiration de lease. Les analyses sont incrémentales par projet ou publication ; la reconstruction
ne parcourt que les feature sets inclus. La collecte automatique est quotidienne par défaut, avec
un marqueur persistant de cycle ; une collecte ou saisie manuelle reste possible à tout moment.

Tous les calculs livrés sont locaux et gratuits. Aucun appel DeepSeek n'est nécessaire au calcul
d'un taux, d'une médiane ou d'une confiance. Les recommandations réutilisent les appels writer et
media planner déjà soumis au frein de budget ; aucun nouvel appel LLM d'analyse n'est activé par
défaut.

## 11. Décisions et limites

- **D4 tranchée : quotidien par défaut + action manuelle.** Aucun connecteur déployé ne fournit
  aujourd'hui de quota analytics acquis justifiant quatre appels par jour. Les snapshots manuels
  gardent la granularité horaire lorsque l'utilisateur en dispose.
- **D6 tranchée : pas de mode démo.** Il n'existe pas de besoin tiers démontré et des chiffres
  factices risqueraient d'être confondus avec des mesures ; les tests contrôlés restent confinés
  aux bases temporaires.
- Les associations ne prouvent pas la causalité ; niche et type de contenu ne suppriment pas tous
  les facteurs confondants.
- L'analyse d'image ne détecte pas visage, produit ou écran/code : cela exigerait une dépendance ML
  disproportionnée. Ces signaux restent inconnus tant qu'ils ne sont pas fournis.
- Les APIs sociales non acquises restent optionnelles ; LinkedIn ne prétend pas fournir des
  analytics quand sa capacité ne le permet pas.

## 12. Tests

Les tests couvrent valeurs manquantes, taux, vélocité, performance relative, percentile,
classification, extraction texte/vidéo, dataset anti-biais, vraie association, cold start
0/3/20/100, poids personnel, advisor, guidance writer/media, jobs, migration, idempotence des
snapshots, import externe et provenance. Les parcours HTTP n'utilisent aucun réseau réel.

## 13. Ce qu'il ne faut PAS construire à ce stade

- entraînement local lourd, embeddings ou RAG ;
- scraping ou téléchargement massif de plateformes ;
- copie de scripts tiers ;
- modification autonome du calendrier ;
- publication ou engagement artificiel ;
- pseudo-certitude à partir d'un petit échantillon ;
- étape 12 avant validation complète de cette étape.
