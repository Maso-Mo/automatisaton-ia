import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DestinationStream } from 'pino';

/**
 * Destination de journal **fichier avec rotation** (docs/08 §5, étape 12 §16).
 *
 * Le problème résolu est simple et concret : un worker qui tourne des mois remplit
 * le disque d'une machine personnelle. La politique est volontairement minimale —
 * **rotation par taille**, nombre de fichiers borné — parce qu'un `logrotate`
 * externe n'est pas disponible partout et qu'un service distant serait
 * sur-dimensionné pour un usage personnel (docs/11 §5.2).
 *
 * Trois garanties :
 *
 * 1. **Une écriture n'échoue jamais bruyamment.** Si le disque refuse l'écriture,
 *    on le signale une fois sur la sortie d'erreur et on continue : un journal
 *    cassé ne doit pas arrêter le produit.
 * 2. **La rotation est synchrone et atomique** (`rename`) : jamais deux fichiers
 *    ouverts sur le même nom, jamais de ligne perdue au milieu d'un renommage.
 * 3. **Le nombre de fichiers est borné** : `LOG_MAX_FILES` plus le fichier courant.
 */
export interface RotatingFileOptions {
  /** Dossier des journaux (créé si absent). */
  dir: string;
  /** Nom du fichier courant, ex. `api.log`. */
  file?: string;
  /** Taille maximale d'un fichier avant rotation (octets). */
  maxBytes: number;
  /** Nombre de fichiers historiques conservés (`api.log.1` … `api.log.N`). */
  maxFiles: number;
}

export interface RotatingFileDestination extends DestinationStream {
  /** Chemin du fichier courant. */
  readonly filePath: string;
  /** Force une rotation au prochain écrit (utile aux tests). */
  rotate(): void;
  /** Ferme le descripteur ouvert. */
  close(): void;
}

export function createRotatingFileDestination(
  options: RotatingFileOptions,
): RotatingFileDestination {
  const file = options.file ?? 'app.log';
  const maxBytes = Math.max(1_024, Math.floor(options.maxBytes));
  const maxFiles = Math.max(1, Math.floor(options.maxFiles));

  mkdirSync(options.dir, { recursive: true });
  const filePath = join(options.dir, file);

  let fd: number | null = null;
  let size = 0;
  let warned = false;

  const open = (): void => {
    fd = openSync(filePath, 'a');
    size = existsSync(filePath) ? statSync(filePath).size : 0;
  };

  open();

  const rotateOnce = (): void => {
    if (fd !== null) {
      closeSync(fd);
      fd = null;
    }
    // `app.log.(N-1)` → `app.log.N` … `app.log` → `app.log.1`. Le plus ancien
    // est supprimé : au-delà de `maxFiles`, on assume la perte de l'historique.
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const from = `${filePath}.${index}`;
      const to = `${filePath}.${index + 1}`;
      if (existsSync(from)) renameSync(from, to);
    }
    if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
    const oldest = `${filePath}.${maxFiles + 1}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    open();
  };

  return {
    filePath,

    write(chunk: string): void {
      const buffer = Buffer.from(chunk, 'utf8');
      try {
        if (size + buffer.length > maxBytes && size > 0) {
          rotateOnce();
        }
        if (fd === null) open();
        writeSync(fd as number, buffer);
        size += buffer.length;
      } catch (error) {
        if (!warned) {
          warned = true;
          process.stderr.write(
            `[observability] écriture de journal impossible (${filePath}) : ${(error as Error).message}\n`,
          );
        }
      }
    },

    rotate(): void {
      rotateOnce();
    },

    close(): void {
      if (fd !== null) {
        closeSync(fd);
        fd = null;
      }
    },
  };
}

/** Nom de fichier par défaut du journal d'un processus. */
export function logFileNameFor(processName: string): string {
  return `${processName}.log`;
}

/** Chemin absolu d'un dossier de journal fourni en relatif. */
export function resolveLogDir(root: string, logDir: string): string {
  return logDir.startsWith('/') ? logDir : join(root, logDir);
}
