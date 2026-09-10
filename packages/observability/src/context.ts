import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Corrélation : cinq identifiants suffisent à relier tout ce qui concerne une
 * même opération (docs/08 §5.2). Ils sont posés **une fois** par le worker ou
 * l'API, puis ajoutés automatiquement à chaque message :
 *
 * > « Un message de journal sans `job_id` est presque toujours inutile. Le logger
 * > l'ajoute automatiquement via un contexte asynchrone, pas à la main dans
 * > chaque appel. »
 */

export interface LogContext {
  /** Identifiant du job en cours : le plus utile de tous. */
  jobId?: string;
  /** Identifiant du worker (processus) qui exécute. */
  workerId?: string;
  /** Tâche métier : `noop`, `master_brief`, `linkedin_post`… */
  task?: string;
  /** Agent IA appelant, quand il y en a un. */
  agent?: string;
  projectId?: string;
  contentId?: string;
  /** Empreinte du contexte de prompt : le seul moyen d'attribuer une régression. */
  contextFingerprint?: string;
  /** Étape courante du pipeline ou du job. */
  step?: string;
  [key: string]: unknown;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Exécute `fn` dans un contexte de journalisation donné. */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  return storage.run({ ...context }, fn);
}

/** Ajoute des clés au contexte courant s'il existe, sinon n'en crée pas. */
export function withLogContext<T>(patch: LogContext, fn: () => T): T {
  const current = storage.getStore();
  return storage.run({ ...(current ?? {}), ...patch }, fn);
}

/** Contexte courant, vide si aucun n'est posé. */
export function currentLogContext(): LogContext {
  return storage.getStore() ?? {};
}

/**
 * Met à jour le contexte courant en place (même référence asynchrone) : utilisé
 * pour `setProgress`/`setStep` d'un job, qui doivent apparaître sur les messages
 * suivants sans re-créer de portée.
 */
export function setLogContext(patch: LogContext): void {
  const current = storage.getStore();
  if (!current) return;
  for (const [key, value] of Object.entries(patch)) {
    current[key] = value;
  }
}
