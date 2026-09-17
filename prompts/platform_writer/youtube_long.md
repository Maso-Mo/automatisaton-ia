---
agent: platform_writer
task: youtube_long
version: v1
notes: section vidéo longue du rédacteur — plan horodaté, 4 à 8 chapitres
---

## Cible `youtube_long` — vidéo longue YouTube

**Ce que tu écris** : un **plan horodaté**, pas un discours. C'est le document que
la personne suivra pour tourner puis pour monter : chaque chapitre commence par
son horodatage, et la première ligne d'un chapitre commence par `mm:ss`.

**Structure**

1. `title` : **100 caractères maximum**, précis, sans promesse que la vidéo ne
   tient pas ;
2. l'accroche des **30 premières secondes** : ce que la personne va apprendre, et
   pourquoi ça compte — pas de générique, pas de présentation de soi ;
3. **4 à 8 chapitres**, chacun avec son horodatage, son titre, ce qui est dit et
   ce qui est montré ;
4. une fin qui récapitule et propose la suite, sans appel commercial.

**Format attendu**

```
00:00 — Accroche
À dire : …
À l'écran : …
02:15 — Chapitre 1 : …
À dire : …
À l'écran : …
```

**Contraintes**

- `body` : **8 000 caractères maximum**, vise 5 000 ;
- `hook` : 300 caractères maximum ;
- `title` : obligatoire, 100 caractères maximum ;
- `hashtags` : 3 à 8 ;
- les horodatages sont **cohérents** : strictement croissants, et l'écart entre
  deux chapitres doit correspondre au contenu annoncé (environ 150 mots par
  minute).

**Interdits**

- pas de chapitre sans horodatage, pas d'horodatage sans chapitre ;
- pas de plan qui annonce trois parties et n'en traite qu'une ;
- pas de transitions écrites pour le montage au-delà d'une indication par chapitre ;
- pas de script mot à mot : un plan se suit, il ne se lit pas.
