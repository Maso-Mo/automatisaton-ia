import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PROMPT_INCLUDE_PATTERN,
  discoverPromptFiles,
  expandPromptIncludes,
  parsePromptFile,
  readPromptBody,
} from './sync';

/**
 * Les prompts sont des **fichiers du dépôt** (docs/04 §6.1). Deux propriétés sont
 * testées ici, parce qu'elles sont invisibles à l'œil nu :
 *
 * 1. un prompt partagé est inclus **textuellement** (`@include`), donc lisible
 *    dans le fichier qui l'applique et vérifiable dans un diff ;
 * 2. l'inclusion ne peut pas boucler, ni sortir du dossier des prompts — un
 *    prompt qui lit `/etc/passwd` serait une faille, pas une commodité.
 */

const REPO_PROMPTS = fileURLToPath(new URL('../../../../prompts', import.meta.url));

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'aia-prompts-'));
}

describe('inclusion de prompts partagés (docs/04 §6.1)', () => {
  it('remplace `@include` par le contenu du fichier partagé', () => {
    const dir = sandbox();
    try {
      mkdirSync(join(dir, '_shared'), { recursive: true });
      writeFileSync(join(dir, '_shared', 'rules.md'), 'Règle 1 : ne rien inventer.');
      const body = expandPromptIncludes(dir, 'agent.md', 'Avant\n@include _shared/rules.md\nAprès');

      expect(body).toContain('Règle 1 : ne rien inventer.');
      expect(body).not.toContain('@include');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuse une inclusion circulaire et une sortie de dossier', () => {
    const dir = sandbox();
    try {
      mkdirSync(join(dir, '_shared'), { recursive: true });
      writeFileSync(join(dir, '_shared', 'a.md'), 'A\n@include _shared/b.md');
      writeFileSync(join(dir, '_shared', 'b.md'), 'B\n@include _shared/a.md');

      expect(() => expandPromptIncludes(dir, '_shared/a.md', '@include _shared/a.md')).toThrow(
        /circulaire/,
      );
      expect(() => expandPromptIncludes(dir, 'agent.md', '@include ../../etc/passwd')).toThrow(
        /invalide/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('détecte le motif d’inclusion une seule fois par ligne', () => {
    const matches = [...'x\n  @include _shared/a.md  \ny'.matchAll(PROMPT_INCLUDE_PATTERN)];
    expect(matches).toHaveLength(1);
    expect(matches[0]?.[1]).toBe('_shared/a.md');
  });
});

describe('prompts réels du dépôt', () => {
  it('découvre les deux prompts de l’étape 3 et ignore les fichiers partagés', () => {
    const files = discoverPromptFiles(REPO_PROMPTS);
    expect(files).toContain('interviewer/converse.md');
    expect(files).toContain('strategist/master_brief.md');

    // Un fichier partagé n'est pas un agent : il n'a pas d'en-tête, donc il est
    // ignoré par la synchronisation (et n'apparaît jamais comme prompt actif).
    expect(parsePromptFile('_shared/rules-honesty.md', 'texte sans en-tête')).toBeNull();

    const header = parsePromptFile(
      'interviewer/converse.md',
      '---\nagent: interviewer\ntask: converse\nversion: v1\n---\nCorps',
    );
    expect(header?.agent).toBe('interviewer');
    expect(header?.body).toBe('Corps');
  });

  it('synchronise puis relit un prompt **avec** ses règles partagées incluses', () => {
    const body = readPromptBody(REPO_PROMPTS, 'interviewer/converse.md');
    expect(body).not.toContain('@include');
    expect(body).toContain('applicables à TOUS les agents');
    expect(body).toContain('jamais un chiffre');
    expect(body).toContain('source_quote');
  });
});
