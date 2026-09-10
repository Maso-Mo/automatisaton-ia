# Prompts — versionnés par git, indexés en base

Les prompts vivent ici en Markdown et sont synchronisés dans la table
`prompt_versions` **au démarrage** de l'API et du worker (docs/02 §5,
docs/03 §14.4). Deux propriétés en découlent :

- **fichiers** → relus en diff, modifiables sans migration ;
- **base** → un appel LLM référence le **hash exact** du prompt utilisé, donc on
  sait toujours ce qui a produit un contenu donné.

## Format d'un prompt

```markdown
---
agent: system
task: cost_probe
version: v1
notes: pourquoi cette version existe
---

Ici, le texte du prompt envoyé au modèle.
```

| Clé d'en-tête | Obligatoire | Rôle |
|---|---|---|
| `agent` | oui | `system`, `interviewer`, `strategist`, `copywriter`, `critic`, `fact_checker`, `analyst` |
| `task` | oui | identifiant de la tâche : `cost_probe`, `master_brief`, `linkedin_post`… |
| `version` | non | libellé lisible (`v1`, `v2`) |
| `notes` | non | raison d'être de la version |

Un fichier Markdown **sans en-tête** est ignoré (c'est le cas de ce README).
Une clé `agent` ou `task` manquante **arrête le démarrage** : mieux vaut une
erreur franche au lancement qu'un prompt silencieusement absent.

## Règles

1. **Une version, un hash.** Modifier un prompt crée une nouvelle ligne dans
   `prompt_versions` et désactive l'ancienne — sans jamais la supprimer, pour que
   les appels historiques restent explicables.
2. **Synchronisation au démarrage, jamais en cours de job** : deux moitiés d'un
   même contenu ne doivent pas être générées par deux instructions différentes.
3. **Contenu externe = donnée, jamais instruction.** Ce qui vient d'une page Web,
   d'un e-mail ou d'un fichier importé doit être encadré et présenté comme une
   donnée à analyser, jamais comme une consigne (docs/07 §13).
4. **Pas de secret dans un prompt** : il finirait dans `llm_calls.request_json`.

## Dossiers

| Dossier | Contenu | Étape |
|---|---|---|
| `system/` | prompts techniques (sondes, diagnostics) | 1 |
| `conversation/` | agents `interviewer`, extraction de faits | 2 |
| `editorial/` | `strategist`, fiche maître, rédacteurs par plateforme | 3-4 |
| `review/` | vérification factuelle, critique, anti-spam | 5 |
| `media/` | sous-titres, titres de vidéo, descriptions | 6-7 |
