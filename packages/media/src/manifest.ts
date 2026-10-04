import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { sha256File } from './hash';

/**
 * Manifeste des médias (étape 12 §7).
 *
 * La sauvegarde des médias est **séparée** de celle de la base (docs/11, D5) :
 * ils changent à un autre rythme, pèsent beaucoup plus, et une copie des médias
 * peut être incrémentale là où un snapshot de base doit rester fréquent. Un
 * manifeste fait le lien : il liste chaque fichier avec sa taille et son
 * empreinte, ce qui permet de **vérifier** une restauration au lieu de l'espérer.
 *
 * Les fichiers temporaires (`.part`) sont ignorés : ils ne sont pas encore des
 * médias, et les sauvegarder figerait un upload interrompu.
 */

export interface ManifestEntry {
  /** Clé relative au dossier racine, en séparateurs POSIX. */
  key: string;
  sizeBytes: number;
  sha256: string;
}

export interface StorageManifest {
  root: string;
  createdAt: number;
  totalBytes: number;
  fileCount: number;
  entries: ManifestEntry[];
}

export async function buildStorageManifest(
  root: string,
  nowMs = Date.now(),
): Promise<StorageManifest> {
  const entries: ManifestEntry[] = [];

  const walk = async (directory: string): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch {
      // Dossier absent : un dépôt neuf n'a pas encore de médias — pas une erreur.
      return;
    }
    for (const dirent of dirents) {
      const absolute = join(directory, dirent.name);
      if (dirent.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!dirent.isFile() || dirent.name.endsWith('.part')) continue;
      const info = await stat(absolute);
      entries.push({
        key: relative(root, absolute).split(sep).join('/'),
        sizeBytes: info.size,
        sha256: await sha256File(absolute),
      });
    }
  };

  await walk(root);
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  return {
    root,
    createdAt: nowMs,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    entries,
  };
}

export interface ManifestVerification {
  ok: boolean;
  missing: string[];
  mismatched: string[];
  verified: number;
}

/** Vérifie qu'un dossier correspond au manifeste : rien de perdu, rien d'altéré. */
export async function verifyStorageManifest(
  root: string,
  manifest: StorageManifest,
): Promise<ManifestVerification> {
  const missing: string[] = [];
  const mismatched: string[] = [];
  let verified = 0;

  for (const entry of manifest.entries) {
    const absolute = join(root, entry.key);
    try {
      const info = await stat(absolute);
      if (info.size !== entry.sizeBytes) {
        mismatched.push(entry.key);
        continue;
      }
      const digest = await sha256File(absolute);
      if (digest !== entry.sha256) {
        mismatched.push(entry.key);
        continue;
      }
      verified += 1;
    } catch {
      missing.push(entry.key);
    }
  }

  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, verified };
}
