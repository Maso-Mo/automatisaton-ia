import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { ensureLocalDirectories, loadConfig, type Config } from '@aia/config';
import { applyMigrations, openDatabase, type DatabaseHandle } from '@aia/database';
import { createLogger, type AppLogger } from '@aia/observability';
import { createJobRegistry, SqliteQueue, type JobRegistry } from '@aia/queue';
import { createManualClock, createSeededRandom, type ManualClock } from '@aia/shared';

/**
 * `tests/support` — l'infrastructure des tests d'intégration.
 *
 * Règle de docs/09 §3 : **un test = un fichier de base temporaire, supprimé à la
 * fin**. C'est ce qui permet de tester les contraintes et les index réels (et le
 * + déclencheur) sans isolation à la main.
 */

export const TEST_NOW = Date.UTC(2026, 2, 10, 12, 0, 0);
export const REPO_PROMPTS_DIR = fileURLToPath(new URL('../../prompts', import.meta.url));

export class MemoryStream extends Writable {
  readonly lines: string[] = [];

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.lines.push(chunk.toString());
    callback();
  }

  text(): string {
    return this.lines.join('');
  }

  entries(): Array<Record<string, unknown>> {
    return this.text()
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}

export interface TestContext {
  dir: string;
  config: Config;
  handle: DatabaseHandle;
  clock: ManualClock;
  logger: AppLogger;
  logStream: MemoryStream;
  queue: SqliteQueue;
  registry: JobRegistry;
  cleanup(): void;
}

export interface TestContextOptions {
  seed?: number;
  promptsDir?: string;
  /** Valeurs d'environnement qui remplacent celles du harnais. */
  env?: Record<string, string | undefined>;
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const dir = mkdtempSync(join(tmpdir(), 'aia-test-'));
  const config = loadConfig({
    dotenvPath: null,
    rootDir: dir,
    source: {
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      ENCRYPTION_KEY: 'b'.repeat(64),
      DATABASE_URL: `file:${join(dir, 'app.db')}`,
      LOG_LEVEL: 'error',
      LOG_PRETTY: 'false',
      PROMPTS_DIR: options.promptsDir ?? REPO_PROMPTS_DIR,
      ...options.env,
    },
  });

  ensureLocalDirectories(config);

  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });
  applyMigrations(handle);

  const clock = createManualClock(TEST_NOW);
  const logStream = new MemoryStream();
  const logger = createLogger({
    level: 'trace',
    pretty: false,
    name: 'test',
    destination: logStream,
  });

  const registry = createJobRegistry();
  const queue = new SqliteQueue({
    db: handle,
    registry,
    clock,
    random: createSeededRandom(options.seed ?? 42),
    logger,
    leaseMs: 60_000,
  });

  return {
    dir,
    config,
    handle,
    clock,
    logger,
    logStream,
    queue,
    registry,
    cleanup: () => {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Attend une condition en laissant tourner les timers réels (SSE, boucle). */
export async function waitFor(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 20;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Condition non satisfaite dans le délai (${options.label ?? 'waitFor'})`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
