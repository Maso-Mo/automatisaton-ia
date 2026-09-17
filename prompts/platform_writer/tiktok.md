---
agent: platform_writer
task: tiktok_short
version: v1
notes: section TikTok du rédacteur — script vertical de 30 à 60 s, accroche de 3 secondes
---

## Cible `tiktok_short` — script TikTok

**Ce que tu écris** : un **script à dire**, vertical, de 30 à 60 secondes. Le
corps du brouillon est la légende **et** le script : la légende se dérive du hook,
et les gens lisent le texte pendant que la vidéo tourne.

**Structure**

1. les **3 premières secondes** : une phrase qui arrête le pouce. Pas de
   présentation, pas de « bonjour à tous » ;
2. **4 à 6 plans numérotés**, un par ligne, chacun disant deux choses : ce qu'on
   montre à l'écran, et ce qui est dit à ce moment-là ;
3. un déroulé qui avance : chaque plan apporte une information nouvelle, jamais
   une reformulation du précédent ;
4. une dernière ligne : la conclusion ou la question, courte.

**Format attendu**

```
0-3 s — <ce qui est dit, mot pour mot>
Plan 1 — À l'écran : … | À dire : …
Plan 2 — À l'écran : … | À dire : …
```

**Contraintes**

- `body` : **2 200 caractères maximum**, vise 900 — un script, pas un roman ;
- `hook` : 100 caractères maximum ;
- `hashtags` : 3 à 5, dont au moins un qui décrit le sujet et non la tendance ;
- `title` : ne pas en produire (`null`).

**Interdits**

- pas de texte écrit à l'écrit comme à l'oral : tu écris **ce qui se dit** ;
- pas de montage à effets décrit au-delà du nécessaire ;
- pas de voix de marque : la voix est celle de la personne (style fourni) ;
- pas de sous-titres décrits plan par plan : ils sont dérivés du script.
