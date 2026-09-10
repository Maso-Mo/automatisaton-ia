# `@aia/media` — non implémenté (étapes 3, 6 et 7)

Ce paquet existe dans l'arborescence parce que les frontières du monorepo sont
fixées dès l'étape 1 (docs/02 §5). Il ne contient **aucun code à l'étape 1**, et
c'est volontaire : la règle est « une table d'abord, le pipeline ensuite », et son
équivalent ici est « un paquet d'abord, son implémentation ensuite — jamais un
paquet rempli de code provisoire » (docs/10 §1.3).

Ce qui arrivera ici, et quand :

| Étape | Contenu | Document de référence |
|---|---|---|
| 3 | Ingestion d'un fichier, déduplication par hash, `ffprobe`, transcription locale (`Transcriber`) | docs/10 §4.3 |
| 6 | Bibliothèque de médias : vignettes, posters, versions verticales | docs/10 §4.6 |
| 7 | Pipeline vidéo FFmpeg : découpe, silences, sous-titres, burn-in, export | docs/10 §4.7 |

Contrats déjà figés qui devront être respectés à l'implémentation (docs/02 §9.4,
§9.5, §9.6) : `StorageAdapter`, `Transcriber`, `FFmpegRunner` — avec des fonctions
**pures** pour compiler un plan de montage en `string[]`, testables sans exécuter
FFmpeg.

Tant que ce paquet est vide, un service absent (FFmpeg, whisper) est traité
« dégradé » et non « bloquant » (docs/02 §10).
