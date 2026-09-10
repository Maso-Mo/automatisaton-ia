# `@aia/news` — non implémenté (étapes 7 et 10)

Paquet réservé à la veille technologique. Vide à l'étape 1 : le pipeline de
veille n'a de sens qu'une fois la production éditoriale en place (docs/10 §3.1).

| Étape | Contenu | Document de référence |
|---|---|---|
| 7 | Tables `news_sources` et `news_items` (la table d'abord, le pipeline ensuite) | docs/03 §13 |
| 10 | Collecte RSS/API, filtrage mécanique sans LLM, déduplication, scoring, candidats scorés | docs/10 §4.10 |

Deux règles déjà écrites qui devront tenir dès la première ligne de code :

1. **Aucune news inventée.** Si la source n'est pas récupérée, l'élément
   n'existe pas : `verified` et `source_url` sont obligatoires.
2. **Le filtrage mécanique précède le LLM.** Seuls les 5 à 10 meilleurs candidats
   atteignent un modèle (docs/08 §9.1).
