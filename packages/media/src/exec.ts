import { spawn } from 'node:child_process';

/**
 * L'exécution de processus externes, en un seul endroit.
 *
 * Une seule règle, mais elle n'est pas négociable : **`shell: false`**. Un
 * chemin de fichier, un nom de projet ou une transcription ne deviennent jamais
 * une commande shell, seulement un élément d'un tableau d'arguments
 * (`spawn(binaire, argv)`). C'est la même règle que l'entrée vocale (docs/16 §4)
 * et que le pipeline vidéo (docs/05 §5.1).
 *
 * Ce module est volontairement **bas niveau** : il ne sait rien de FFmpeg ni de
 * whisper.cpp. C'est ce qui permet aux tests d'injecter un exécutant qui écrit
 * de vrais fichiers, sans binaire installé (docs/09 §1.1).
 */

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Vrai si le délai maximal a été atteint et le processus tué. */
  timedOut?: boolean;
  /** Vrai si le processus a été interrompu (arrêt du worker). */
  aborted?: boolean;
}

export interface CommandRunOptions {
  /** Répertoire de travail : permet de n'utiliser que des **noms relatifs** dans les filtres. */
  cwd?: string;
  /** Délai maximal avant SIGTERM puis SIGKILL. */
  timeoutMs?: number;
  /** Annulation coopérative : l'arrêt du worker termine le processus en cours. */
  signal?: AbortSignal;
  /** Appelé au fil de l'eau sur la sortie standard (progression FFmpeg, JSON de whisper). */
  onStdout?: (chunk: string) => void;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandRunOptions,
) => Promise<CommandResult>;

/** Sortie capturée bornée : un `stderr` de FFmpeg peut être très bavard. */
const OUTPUT_LIMIT_BYTES = 512 * 1024;

export const spawnCommand: CommandRunner = async (command, args, options = {}) =>
  new Promise<CommandResult>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        // LA ligne qui compte : aucun shell n'interprète ces arguments.
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
    } catch (error) {
      reject(error);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const collect = (target: Buffer[], chunk: Buffer): void => {
      if (outputSize >= OUTPUT_LIMIT_BYTES) return;
      outputSize += chunk.length;
      target.push(chunk.subarray(0, Math.max(0, OUTPUT_LIMIT_BYTES - outputSize + chunk.length)));
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      collect(stdout, chunk);
      options.onStdout?.(chunk.toString('utf8'));
    });
    child.stderr?.on('data', (chunk: Buffer) => collect(stderr, chunk));

    const stop = (signal: NodeJS.Signals): void => {
      if (child.killed) return;
      child.kill(signal);
    };

    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            timedOut = true;
            stop('SIGTERM');
            setTimeout(() => stop('SIGKILL'), 5_000).unref();
          }, options.timeoutMs);
    timer?.unref();

    const onAbort = (): void => {
      aborted = true;
      stop('SIGTERM');
      setTimeout(() => stop('SIGKILL'), 5_000).unref();
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (): void => {
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(error);
    });

    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      finish();
      resolvePromise({
        exitCode: exitCode ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        aborted,
      });
    });
  });
