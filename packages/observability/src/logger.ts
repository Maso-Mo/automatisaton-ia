import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import type { LogLevel } from '@aia/shared';
import { redact, redactString } from '@aia/config';
import { currentLogContext } from './context';

export type AppLogger = Logger;

export interface CreateLoggerOptions {
  level?: LogLevel;
  /** Journaux lisibles en développement, JSON structuré sinon (docs/02 §6). */
  pretty?: boolean;
  /** Nom du processus : `api`, `worker`, `script`. */
  name?: string;
  /** Flux de destination (les tests y capturent les lignes). */
  destination?: DestinationStream;
}

/**
 * Journalisation : `pino` + les tables `job_events` / `errors` (docs/02 §6).
 *
 * Deux garanties tenues ici, et nulle part ailleurs :
 *
 * 1. **La rédaction est appliquée en sortie**, sur l'objet **et sur le message**.
 *    `formatters.log` ne reçoit pas le message (c'est une subtilité de pino) :
 *    la rédaction du message passe donc par `hooks.logMethod`. Sans elle, un
 *    secret collé dans un message de journal fuit en clair — ce que le test
 *    canari (`pnpm check:canary`) a effectivement détecté.
 * 2. **Le contexte de corrélation est ajouté automatiquement** (`mixin`), donc
 *    chaque ligne produite pendant un job porte son `job_id` et son étape.
 */
export function createLogger(options: CreateLoggerOptions = {}): AppLogger {
  const pinoOptions: LoggerOptions = {
    level: options.level ?? 'info',
    base: { app: 'automatisation-ia', ...(options.name ? { process: options.name } : {}) },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      log: (object) => redact(object) as Record<string, unknown>,
    },
    mixin: () => currentLogContext(),
    hooks: {
      logMethod(args, method) {
        const safeArgs = args.map((argument: unknown) =>
          typeof argument === 'string' ? redactString(argument) : argument,
        );
        method.apply(this, safeArgs as never);
      },
    },
  };

  if (options.destination) {
    // `transport` et un flux explicite s'excluent : le flux gagne (tests, fichiers).
    return pino(pinoOptions, options.destination);
  }

  if (options.pretty) {
    return pino({
      ...pinoOptions,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', colorize: true, ignore: 'pid,hostname,app' },
      },
    });
  }

  return pino(pinoOptions);
}

/** Niveaux acceptés par le réglage `LOG_LEVEL`, alignés sur docs/08 §5.1. */
export const LOG_LEVELS_ORDER: readonly LogLevel[] = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
];
