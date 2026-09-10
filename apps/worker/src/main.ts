import { describeConfig, ConfigError } from '@aia/config';
import { buildWorker } from './bootstrap';

/**
 * Point d'entrée du worker : un processus, aucune requête HTTP, uniquement des
 * jobs. Il ne sert jamais de réponse utilisateur, donc un rendu long ne gèle
 * jamais l'interface (docs/02 §3).
 */

async function main(): Promise<void> {
  let worker: ReturnType<typeof buildWorker>;

  try {
    worker = buildWorker();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const { logger, config, loop, shutdown, workerId } = worker;

  logger.info(
    { version: config.env.APP_ENV, workerId },
    `worker démarré — ${describeConfig(config).join(' · ')}`,
  );

  loop.start();

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'signal reçu : arrêt propre en cours');

    const forced = setTimeout(() => {
      logger.error('arrêt forcé : le délai de grâce est dépassé');
      process.exit(1);
    }, 35_000);
    forced.unref();

    void shutdown()
      .then(() => {
        logger.info('worker arrêté proprement');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'échec de l’arrêt propre');
        process.exit(1);
      });
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Un worker qui sort sans raison visible est un worker qu'on ne comprend pas.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'promesse rejetée non gérée');
  });
}

void main();
