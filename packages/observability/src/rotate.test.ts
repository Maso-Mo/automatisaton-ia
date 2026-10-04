import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRotatingFileDestination, logFileNameFor, resolveLogDir } from './rotate';

/**
 * Rotation des journaux (étape 12 §16).
 *
 * Ce qui est testé ici est exactement ce qui protège un poste personnel : le
 * journal **ne grossit pas indéfiniment**, le nombre de fichiers est **borné**, et
 * une écriture impossible **n'arrête pas le produit** (docs/08 §5). Les trois
 * points sont invisibles à l'usage — jusqu'au jour où le disque est plein.
 */

const LINE = '{"level":30,"msg":"ligne de journal suffisamment longue pour peser"}\n';

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aia-logs-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('journal fichier avec rotation bornée', () => {
  it('crée le dossier et le fichier courant au premier écrit', () => {
    const dir = join(directory, 'logs');
    const destination = createRotatingFileDestination({
      dir,
      file: logFileNameFor('api'),
      maxBytes: 4_096,
      maxFiles: 3,
    });
    destination.write(LINE);
    destination.close();

    expect(destination.filePath).toBe(join(dir, 'api.log'));
    expect(readFileSync(destination.filePath, 'utf8')).toBe(LINE);
  });

  it('tourne quand la taille dépasse la limite et garde l’historique numéroté', () => {
    const dir = join(directory, 'logs');
    const maxBytes = 1_024;
    const destination = createRotatingFileDestination({
      dir,
      file: 'api.log',
      maxBytes,
      maxFiles: 3,
    });

    // 4 × 1 ko : deux rotations au moins sont nécessaires.
    for (let index = 0; index < 4; index += 1) destination.write(LINE.repeat(20));
    destination.close();

    const files = readdirSync(dir).sort();
    expect(files).toContain('api.log');
    expect(files).toContain('api.log.1');
    // Trois fichiers historiques au plus, plus le fichier courant.
    expect(files.length).toBeLessThanOrEqual(4);
  });

  it('borne le nombre de fichiers : le plus ancien est supprimé, jamais accumulé', () => {
    const dir = join(directory, 'logs');
    const destination = createRotatingFileDestination({
      dir,
      file: 'worker.log',
      maxBytes: 1_024,
      maxFiles: 2,
    });

    // Douze rotations forcées : sans borne, on obtiendrait douze fichiers.
    for (let index = 0; index < 12; index += 1) {
      destination.write(LINE);
      destination.rotate();
    }
    destination.close();

    const files = readdirSync(dir);
    expect(files.length).toBeLessThanOrEqual(3);
    expect(files).toContain('worker.log');
    // `maxFiles = 2` : aucun fichier `.3` ne doit exister.
    expect(files).not.toContain('worker.log.3');
  });

  it('rouvre le fichier après fermeture : une écriture tardive n’est pas perdue', () => {
    const dir = join(directory, 'logs');
    const destination = createRotatingFileDestination({
      dir,
      file: 'api.log',
      maxBytes: 1_024,
      maxFiles: 2,
    });
    destination.write(LINE);
    destination.close();
    destination.write(LINE);
    destination.close();

    expect(readFileSync(destination.filePath, 'utf8')).toBe(LINE.repeat(2));
  });

  it('n’interrompt jamais le produit quand le journal ne peut plus être écrit', () => {
    const dir = join(directory, 'logs');
    const destination = createRotatingFileDestination({
      dir,
      file: 'api.log',
      maxBytes: 1_024,
      maxFiles: 2,
    });
    destination.write(LINE);
    destination.close();

    // Le dossier disparaît et un **fichier** prend sa place : le prochain accès
    // échoue. Le contrat est de signaler une fois, puis de continuer.
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'ceci est un fichier, pas un dossier');

    expect(() => {
      destination.write(LINE);
      destination.write(LINE);
    }).not.toThrow();
  });

  it('résout un dossier de journaux relatif par rapport à la racine', () => {
    expect(resolveLogDir('/depot', 'logs')).toBe('/depot/logs');
    expect(resolveLogDir('/depot', '/var/log/aia')).toBe('/var/log/aia');
  });
});
