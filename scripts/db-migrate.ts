import { ConfigError, ensureLocalDirectories, loadConfig } from '@aia/config';
import { appliedMigrationCount, applyMigrations, openDatabase } from '@aia/database';
import { createLogger } from '@aia/observability';

/** Crée la base depuis zéro et applique les migrations. Idempotent. */
function main(): void {
  const logger = createLogger({ level: 'info', pretty: true, name: 'db-migrate' });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }

  ensureLocalDirectories(config);
  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });

  const before = appliedMigrationCount(handle);
  const report = applyMigrations(handle);
  const after = appliedMigrationCount(handle);
  handle.close();

  logger.info(
    {
      file: config.paths.databaseFile,
      before,
      applied: report.applied,
      total: after,
    },
    report.applied > 0 ? 'migrations appliquées' : 'base déjà à jour',
  );
}

main();
