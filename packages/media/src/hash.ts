import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/**
 * Empreinte d'un fichier, **en flux**.
 *
 * Un rendu vidéo peut peser plusieurs centaines de mégaoctets : le lire en
 * mémoire pour calculer son SHA-256 ferait tomber le worker sur une machine
 * modeste. C'est la même règle que la purge des audios — un fichier se manipule
 * par flux, jamais par lecture complète (docs/02 §10).
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolvePromise());
  });
  return hash.digest('hex');
}
