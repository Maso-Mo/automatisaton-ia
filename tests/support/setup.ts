/**
 * Environnement des tests (docs/09 §1.1) :
 *
 * - **aucun test ne parle au monde extérieur** : les clés IA présentes ici sont
 *   factices, aucun appel réseau n'est effectué ;
 * - **horloge et fuseau fixés** : un test qui dépend de la date est un test faux ;
 * - journaux silencieux : seul un test qui les observe les active explicitement.
 */

process.env.APP_ENV = 'test';
process.env.TZ = 'UTC';
// Niveaux de journal : les tests capturent leurs journaux dans un flux mémoire,
// donc `error` suffit et évite de gonfler la sortie de la suite.
process.env.LOG_LEVEL = 'error';
process.env.LOG_PRETTY = 'false';

// Secrets factices : `packages/config` refuse de démarrer sans ces deux clés.
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);

// Base : chaque test ouvre son propre fichier temporaire (harness).
process.env.DATABASE_URL = 'file:./data/test-ignore.sqlite';
process.env.DB_WAL = 'true';
process.env.QUEUE_CONCURRENCY = '3';
