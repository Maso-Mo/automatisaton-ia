import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadActivePrompt, syncPrompts } from '@aia/ai';
import { listPromptVersions } from '@aia/database';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Prompts = fichiers du dépôt, indexés en base (docs/03 §14.4). Ce qui est testé
 * ici, c'est la **propriété** qui compte : une modification crée une version et
 * désactive l'ancienne sans jamais la supprimer.
 */

const PROMPT_V1 = `---
agent: system
task: cost_probe
version: v1
notes: version initiale du test
---

Réponds en trois mots.
`;

const PROMPT_V2 = PROMPT_V1.replace('version: v1', 'version: v2').replace(
  'Réponds en trois mots.',
  'Réponds en cinq mots, sans ponctuation.',
);

let context: TestContext;
let promptsDir: string;

beforeEach(() => {
  promptsDir = mkdtempSync(join(tmpdir(), 'aia-prompts-'));
  mkdirSync(join(promptsDir, 'system'), { recursive: true });
  writeFileSync(join(promptsDir, 'system', 'probe.md'), PROMPT_V1);
  writeFileSync(join(promptsDir, 'README.md'), '# Ce fichier n’est pas un prompt\n');
  context = createTestContext({ promptsDir });
});

afterEach(() => {
  context.cleanup();
  rmSync(promptsDir, { recursive: true, force: true });
});

function sync() {
  return syncPrompts({
    handle: context.handle,
    promptsDir,
    clock: context.clock,
    logger: context.logger,
    gitCommit: 'test-commit',
  });
}

describe('synchronisation des prompts', () => {
  it('indexe les fichiers, ignore les README et reste idempotent', () => {
    const first = sync();
    expect(first.scanned).toBe(1); // le README n'est pas un prompt
    expect(first.inserted).toBe(1);
    expect(first.active).toBe(1);

    const second = sync();
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(listPromptVersions(context.handle)).toHaveLength(1);
  });

  it('crée une nouvelle version et désactive l’ancienne quand le contenu change', () => {
    sync();
    const before = loadActivePrompt(context.handle, promptsDir, 'system', 'cost_probe');
    expect(before?.body).toContain('trois mots');

    writeFileSync(join(promptsDir, 'system', 'probe.md'), PROMPT_V2);
    const report = sync();

    expect(report.inserted).toBe(1);
    expect(report.deactivated).toBe(1);
    expect(report.active).toBe(1);

    const versions = listPromptVersions(context.handle);
    expect(versions).toHaveLength(2); // rien n'est supprimé
    expect(versions.filter((row) => row.is_active)).toHaveLength(1);

    const after = loadActivePrompt(context.handle, promptsDir, 'system', 'cost_probe');
    expect(after?.body).toContain('cinq mots');
    expect(after?.promptVersionId).not.toBe(before?.promptVersionId);
  });

  it('retire l’en-tête du corps envoyé au modèle', () => {
    sync();
    const prompt = loadActivePrompt(context.handle, promptsDir, 'system', 'cost_probe');
    expect(prompt?.body.startsWith('---')).toBe(false);
    expect(prompt?.body).not.toContain('agent: system');
  });

  it('refuse un prompt sans agent ou sans task plutôt que de l’ignorer', () => {
    writeFileSync(
      join(promptsDir, 'system', 'incomplet.md'),
      '---\nversion: v1\n---\n\nContenu sans agent ni task.\n',
    );
    expect(() => sync()).toThrow(/agent/);
  });

  it('refuse un en-tête non fermé', () => {
    writeFileSync(join(promptsDir, 'system', 'casse.md'), '---\nagent: system\ntask: x\n');
    expect(() => sync()).toThrow(/en-tête de prompt non fermé/i);
  });
});
