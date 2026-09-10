/**
 * `@aia/config` — configuration et secrets.
 *
 * Seul paquet autorisé à lire `process.env` (docs/02 §11). Deux responsabilités :
 *
 * 1. **Charger et valider** la configuration au démarrage (`loadConfig`) ;
 * 2. **Rédiger** les secrets au point de passage unique (`redact`), utilisé par
 *    le journal, le client HTTP et le journal des appels LLM.
 */

export * from './env';
export * from './load';
export * from './redact';

/**
 * `ConfigError` est réexporté ici pour que les points d'entrée (API, worker,
 * scripts) attrapent une erreur de configuration **sans** dépendre de
 * `@aia/shared` directement : c'est le contrat de démarrage du paquet.
 */
export { ConfigError } from '@aia/shared';
