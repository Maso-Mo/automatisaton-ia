# `@aia/publishing` — non implémenté (étapes 5 et 9)

Paquet réservé aux connecteurs de plateformes. Vide à l'étape 1 : le produit
commence par la **publication manuelle** (niveau C), qui ne dépend d'aucune
validation externe (docs/10 §3.1).

| Étape | Contenu | Document de référence |
|---|---|---|
| 5 | Niveau C : paquet manuel (texte + médias + consignes) à copier-coller | docs/06 §8 |
| 9 | Niveaux A et B : API officielle, brouillon distant, programmation, métriques | docs/10 §4.9 |

Le contrat `PlatformConnector` est déjà figé (docs/02 §9.2) et impose notamment
le résultat **`ambiguous`** : si un envoi expire sans réponse, on ne rejoue
jamais automatiquement — le contenu a peut-être été publié.

Tant que ce paquet est vide, aucun connecteur n'existe, donc aucune règle de
plateforme (quota, CGU) n'est contournée : c'est exactement ce que la V1 veut.
