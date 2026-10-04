# `@aia/news` — collecte et classement déterministes (étape 10)

Le paquet contient les providers RSS/Atom et JSON public, la normalisation, la
déduplication lexicale, le scoring explicable, les urgences et les suggestions.

| Étape | Contenu | Document de référence |
|---|---|---|
| 7 | Tables `news_sources` et `news_items` (la table d'abord, le pipeline ensuite) | docs/03 §13 |
| 10 | Collecte RSS/API, filtrage mécanique sans LLM, déduplication, scoring, candidats scorés | docs/10 §4.10 |

Deux règles structurent chaque ligne de code :

1. **Aucune news inventée.** Si la source n'est pas récupérée, l'élément
   n'existe pas : `verified` et `source_url` sont obligatoires.
2. **Le filtrage mécanique précède tout LLM.** La livraison active ne fait aucun
   appel payant ; l'extension d'enrichissement retient un candidat si le budget
   transmis ne couvre pas son estimation (docs/08 §9.1).
