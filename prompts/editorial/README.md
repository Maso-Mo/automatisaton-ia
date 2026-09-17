# Prompts « editorial » — réservé (étapes 3 et 4)

Aucun prompt actif ici, et c'est volontaire : **un dossier par agent**, pas par
famille. Les prompts réellement appelés vivent dans le dossier de leur agent —
`prompts/strategist/master_brief.md` pour le stratège, `prompts/platform_writer/`
pour les rédacteurs par plateforme (`rules.md` pour les règles communes, puis
`linkedin.md`, `reddit.md`, `tiktok.md`, `youtube_short.md`, `youtube_long.md`).

Un fichier dans ce dossier-ci ne serait lu par personne : le chargement se fait par
couple `agent` / `task` (`loadActivePrompt`), et le nom de l'agent est celui du
code. C'est la règle de `prompts/README.md` : un prompt sans code qui l'appelle est
une fausse dette documentée.

Rappel de la règle non négociable : le modèle ne **décide** pas d'écrire, il
**propose** une écriture (`EditPlan`) que le domaine applique après validation
(docs/05 §3).

