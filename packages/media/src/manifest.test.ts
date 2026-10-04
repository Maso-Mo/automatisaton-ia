import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStorageManifest, verifyStorageManifest } from './manifest';

/**
 * Manifeste des médias (étape 12 §7, décision D5).
 *
 * La sauvegarde des médias est **séparée** de celle de la base : elle n'a de sens
 * que si l'on peut ensuite **vérifier** qu'un dossier restauré est complet et
 * intact. C'est le rôle du manifeste, et c'est ce que ces tests figent : une
 * empreinte qui change doit être détectée, un fichier perdu doit être nommé.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'aia-media-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('manifeste de stockage', () => {
  it('décrit chaque fichier avec sa taille et son empreinte, en clés POSIX', async () => {
    await mkdir(join(root, 'assets', 'video'), { recursive: true });
    await writeFile(join(root, 'assets', 'video', 'clip.mp4'), 'contenu-video');
    await writeFile(join(root, 'assets', 'audio.webm'), 'contenu-audio');

    const manifest = await buildStorageManifest(root, 1_700_000_000_000);

    expect(manifest.fileCount).toBe(2);
    expect(manifest.totalBytes).toBe('contenu-video'.length + 'contenu-audio'.length);
    expect(manifest.createdAt).toBe(1_700_000_000_000);
    expect(manifest.entries.map((entry) => entry.key)).toEqual([
      'assets/audio.webm',
      'assets/video/clip.mp4',
    ]);
    for (const entry of manifest.entries) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('ignore les fichiers temporaires `.part` : un téléversement interrompu n’est pas un média', async () => {
    await writeFile(join(root, 'upload.webm.part'), 'morceau incomplet');
    await writeFile(join(root, 'upload.webm'), 'fichier complet');

    const manifest = await buildStorageManifest(root);
    expect(manifest.entries.map((entry) => entry.key)).toEqual(['upload.webm']);
  });

  it('accepte un dossier vide ou absent : un dépôt neuf n’a pas de médias', async () => {
    const empty = await buildStorageManifest(join(root, 'absent'));
    expect(empty.fileCount).toBe(0);
    expect(empty.entries).toEqual([]);
    expect(empty.totalBytes).toBe(0);
  });

  it('valide un dossier intact, fichier par fichier', async () => {
    await writeFile(join(root, 'a.txt'), 'aaa');
    await mkdir(join(root, 'sous-dossier'), { recursive: true });
    await writeFile(join(root, 'sous-dossier', 'b.txt'), 'bbb');

    const manifest = await buildStorageManifest(root);
    const verification = await verifyStorageManifest(root, manifest);

    expect(verification).toEqual({ ok: true, missing: [], mismatched: [], verified: 2 });
  });

  it('détecte un fichier altéré **et** un fichier manquant, sans confondre les deux', async () => {
    await writeFile(join(root, 'intact.txt'), 'intact');
    await writeFile(join(root, 'altere.txt'), 'version-originale');
    await writeFile(join(root, 'perdu.txt'), 'contenu-qui-va-disparaitre');

    const manifest = await buildStorageManifest(root);
    await writeFile(join(root, 'altere.txt'), 'version-modifiee!');
    await rm(join(root, 'perdu.txt'));

    const verification = await verifyStorageManifest(root, manifest);
    expect(verification.ok).toBe(false);
    expect(verification.mismatched).toEqual(['altere.txt']);
    expect(verification.missing).toEqual(['perdu.txt']);
    expect(verification.verified).toBe(1);
  });

  it('détecte une altération de même taille (l’empreinte, pas seulement la taille)', async () => {
    await writeFile(join(root, 'egal.txt'), 'AAAA');
    const manifest = await buildStorageManifest(root);
    await writeFile(join(root, 'egal.txt'), 'BBBB');

    const verification = await verifyStorageManifest(root, manifest);
    expect(verification.mismatched).toEqual(['egal.txt']);
    expect(verification.verified).toBe(0);
  });

  it('produit un manifeste sérialisable tel quel (relu après écriture disque)', async () => {
    await writeFile(join(root, 'media.bin'), Buffer.from([0, 1, 2, 3]));
    const manifest = await buildStorageManifest(root, 42);
    const manifestFile = join(root, 'manifest.json');
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));

    const reloaded = JSON.parse(await readFile(manifestFile, 'utf8')) as typeof manifest;
    expect(await verifyStorageManifest(root, reloaded)).toEqual({
      ok: true,
      missing: [],
      mismatched: [],
      verified: 1,
    });
  });
});
