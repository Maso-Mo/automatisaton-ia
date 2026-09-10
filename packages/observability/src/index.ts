/**
 * `@aia/observability` — journalisation corrélée.
 *
 * « Pourquoi ça a échoué ? » doit se répondre sans lire un journal brut : ce
 * paquet pose le contexte (job, étape, tâche, empreinte de contexte) et garantit
 * qu'aucun secret ne traverse la sortie.
 */

export * from './context';
export * from './logger';
