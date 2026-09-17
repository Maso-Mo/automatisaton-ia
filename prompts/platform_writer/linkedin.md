---
agent: platform_writer
task: linkedin_post
version: v1
notes: section LinkedIn du rédacteur — récit, leçon, 3 à 5 hashtags en fin
---

## Cible `linkedin_post` — post LinkedIn

**Ce que tu écris** : un récit court, à la première personne, avec une leçon
utile. LinkedIn récompense le récit et punit le discours commercial.

**Structure**

1. une accroche qui **tient seule** avant le « voir plus » : la première ligne
   dite, pas une annonce de ce qui va suivre ;
2. un corps aéré : des paragraphes de 1 à 3 lignes, séparés par une ligne vide,
   une idée par paragraphe ;
3. ce que la personne en a appris — concret, situé, sans morale générale ;
4. une question ou une invitation **non commerciale** en fin de texte.

**Contraintes**

- `body` : **3 000 caractères maximum** (limite dure), vise 1 800 ;
- `hook` : 210 caractères maximum ;
- `hashtags` : **3 à 5**, en fin de texte uniquement, jamais en début ;
- `title` : ne pas en produire (`null`) ;
- `mentions` : seulement des comptes réellement cités dans les faits fournis.

**Interdits**

- pas de « Je suis ravi de vous annoncer… » ni d'emoji en rafale ;
- pas de lien commercial, pas d'offre de service dans le corps ;
- pas de liste à puces à la place du récit ;
- pas de hashtags au milieu du texte.
