# Documentation — index et règles

## Ordre de lecture

1. **`00-cahier-des-charges.md`** — le besoin brut. C'est la source de vérité du besoin :
   on ne réinterprète pas, on répond.
2. **`01-vision-produit.md`** — ce que le produit final fait, pour qui, avec quelles
   fonctionnalités et quels écrans.
3. **`02-architecture.md`** — comment le produit est construit, module par module.
4. **`03-modele-de-donnees.md`** — ce que le produit stocke exactement.
5. **`04-orchestrateur-et-agents-ia.md`** — comment l'IA est organisée et comment elle
   reste peu coûteuse et non hallucinatoire.
6. **`05-pipelines.md`** — les flux de bout en bout.
7. **`06-connecteurs-et-publication.md`** — les plateformes, leurs capacités et leurs limites.
8. **`07-securite-secrets-auth.md`** — réseau, secrets, jetons, authentification, contenus
   générés, données personnelles, légal.
9. **`08-jobs-observabilite-couts.md`** — la mécanique d'exécution et le suivi financier.
10. **`09-tests-et-qualite.md`** — comment on sait que ça marche.
11. **`10-plan-de-developpement-12-etapes.md`** — l'ordre d'exécution, avec critères de fin.
12. **`11-risques-decisions-et-limites.md`** — ce qui peut casser, ce qui est réversible,
    et ce qui doit volontairement attendre.
13. **`12-mise-en-oeuvre-etape-1.md`** — ce qui a été **réellement** construit à l'étape 1 :
    décisions prises en chemin (M1 à M12), ce qui n'a pas été construit et pourquoi, tests,
    points ouverts. À lire après avoir codé quelque chose, pas avant.
14. **`13-mise-en-oeuvre-etape-3.md`** — idem pour l'étape 3 (conversation IA et fiche maître) :
    décisions (M1 à M16), ce qui n'a pas été construit, tests, points laissés ouverts, et la
    correspondance avec la numérotation du plan.


## Règles de rédaction

- **Français**, ton direct, décisions explicites.
- Chaque choix technique majeur est justifié par : *pourquoi / alternatives / avantages /
  inconvénients / coût / complexité / compatibilité PC local / compatibilité cloud*.
- Chaque phase se termine par une liste **« ce qu'il ne faut PAS construire à ce stade »**.
- Les informations dont la véracité dépend du monde extérieur (quotas et politiques des
  APIs de plateformes, prix des modèles) sont marquées `⚠️ À VÉRIFIER` : elles doivent être
  recontrôlées **au moment de l'implémentation**, pas supposées.
- Les diagrammes sont en **Mermaid** (rendu natif GitHub).

## Convention de nommage des fichiers

```text
NN-sujet.md
```

`NN` est un numéro à deux chiffres qui donne l'ordre de lecture. Pour insérer un document,
on utilise un numéro libre (`04b-…`) plutôt que de renuméroter l'existant.
