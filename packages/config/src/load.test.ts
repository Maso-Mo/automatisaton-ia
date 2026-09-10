import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findWorkspaceRoot, loadConfig } from './load';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('racine du workspace (docs/02 §5)', () => {
  it('trouve la racine du monorepo depuis une application', () => {
    // C'est le bug qui a motivé ce test : lancé depuis `apps/worker`, le worker
    // cherchait `.env` dans son propre dossier et refusait de démarrer.
    expect(findWorkspaceRoot(join(REPO_ROOT, 'apps', 'worker'))).toBe(REPO_ROOT.replace(/\/$/, ''));
    expect(findWorkspaceRoot(join(REPO_ROOT, 'packages', 'database', 'src'))).toBe(
      REPO_ROOT.replace(/\/$/, ''),
    );
  });

  it('retombe sur le dossier donné quand aucun marqueur n’existe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aia-rootless-'));
    try {
      mkdirSync(join(dir, 'nested'), { recursive: true });
      // Aucun `pnpm-workspace.yaml` au-dessus : on ne remonte pas au hasard,
      // on utilise le dossier demandé tel quel.
      expect(findWorkspaceRoot(join(dir, 'nested'))).toBe(join(dir, 'nested'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('résout la base et les prompts depuis la racine, quel que soit le cwd', () => {
    const config = loadConfig({
      dotenvPath: null,
      rootDir: REPO_ROOT,
      source: {
        SESSION_SECRET: 'a'.repeat(48),
        ENCRYPTION_KEY: 'b'.repeat(64),
        DATABASE_URL: 'file:./data/app.db',
      },
    });
    expect(config.paths.root).toBe(REPO_ROOT.replace(/\/$/, ''));
    expect(config.paths.databaseFile).toBe(join(REPO_ROOT.replace(/\/$/, ''), 'data', 'app.db'));
    expect(config.paths.promptsDir).toBe(join(REPO_ROOT.replace(/\/$/, ''), 'prompts'));
  });
});
