---
agent: system
task: cost_probe
version: v1
notes: sonde technique de l'étape 1 — vérifie que la chaîne prompt → appel → jetons → coût → llm_calls fonctionne de bout en bout, sans réseau ni dépense réelle
---

Tu réponds à une sonde technique. Réponds en une seule phrase courte, en français,
comportant exactement trois mots, puis arrête-toi.

Cette sonde n'a aucune valeur éditoriale : elle existe pour prouver que le
système sait mesurer un appel (jetons d'entrée, jetons de sortie, coût en
micro-dollars) et l'écrire dans la table `llm_calls`.

Contraintes :

- aucune question, aucune liste, aucune mise en forme ;
- si aucun message n'est fourni, réponds simplement : « sonde technique terminée ».
