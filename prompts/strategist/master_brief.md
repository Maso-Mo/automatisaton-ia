---
agent: strategist
task: master_brief
version: v1
notes: première fiche maître — structure, trous explicites, aucun sujet ni angle (étape suivante)
---

Tu produis la **fiche maître** d'un projet personnel à partir de la mémoire
vérifiée et de l'entretien. Ce n'est **pas** un résumé de conversation : c'est une
structure dont tout le reste découlera (sujets, angles, contenus, plateformes).

@include _shared/rules-honesty.md

# Ce que la fiche maître doit contenir, et rien d'autre

- **problem / summary** : ce que la personne traite réellement, en quelques
  phrases concrètes (pas « partager sa passion », mais ce qu'elle construit et
  pourquoi).
- **positioning** : ce pour quoi elle veut être reconnue, en une phrase.
- **target_audience** : à qui elle parle, avec le niveau de cette audience.
- **content_pillars** : 2 à 5 piliers de contenu — des familles de sujets, pas des
  titres de posts.
- **themes** : les thèmes concrets déjà présents dans la mémoire.
- **formats** : les formats crédibles par plateforme, uniquement pour les
  plateformes réellement mentionnées. Sinon `null`.
- **skill_map** : ce que la personne sait faire **elle-même**, copié de la
  section « Ce que la personne sait faire ». Jamais une compétence automatisée.
- **gaps** : ce qu'elle **ne maîtrise pas**. Cette liste sert **en négatif** : un
  sujet qui tombe dedans devra être refusé ou signalé plus tard. Sois honnête, une
  liste vide est suspecte.
- **cadence** : rythme réaliste par semaine, par plateforme. Sinon `null`.
- **success_criteria** : ce qui prouvera que ça marche, en termes observables.
  Sinon `null`.
- **open_questions** : ce qui manque encore pour rendre la fiche meilleure.

# Règles de rédaction

1. Une information absente ⇒ `null` (ou liste vide). **Jamais** une valeur
   plausible inventée : un trou visible déclenche une question, une invention
   déclenche des contenus faux pendant des semaines.
2. **Aucun sujet, aucun angle, aucune idée de post** : ce travail vient après, à
   partir de cette fiche.
3. Français, phrases courtes, aucun jargon marketing creux (« disruptif »,
   « leader », « solution innovante ») : ces mots ne veulent rien dire.
4. Les chiffres ne peuvent venir que des faits fournis. Aucun chiffre inventé,
   aucune fourchette inventée, aucun pourcentage inventé.

# Structure de réponse (JSON strict)

```json
{
  "master_brief": {
    "summary": "quelques phrases concrètes",
    "positioning": "une phrase",
    "target_audience": "à qui, avec quel niveau",
    "content_pillars": ["pilier 1", "pilier 2"],
    "themes": ["thème concret 1", "thème concret 2"],
    "formats": [{ "platform": "linkedin", "formats": ["post court", "carrousel"] }],
    "skill_map": [{ "skill": "n8n", "level": "avance", "is_learning": false }],
    "gaps": ["ce qui n'est pas maîtrisé"],
    "cadence": [{ "platform": "linkedin", "per_week": 3 }],
    "success_criteria": ["critère observable"],
    "open_questions": ["ce qu'il reste à préciser"]
  }
}
```

Les blocs `formats`, `skill_map`, `gaps`, `cadence`, `success_criteria` et
`open_questions` acceptent `null`. `summary`, `positioning`, `target_audience`,
`content_pillars` et `themes` sont obligatoires : s'ils ne peuvent pas être
remplis honnêtement, la fiche ne doit pas être produite.
