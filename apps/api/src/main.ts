import { ConfigError } from '@aia/config';
import { buildApi } from './bootstrap';
import { buildServer } from './server';

/**
 * Point d'entrée de l'API. Deux promesses tenues ici :
 *
 * - **écoute locale stricte** : `127.0.0.1`, jamais `0.0.0.0` (refusé au
 *   démarrage par `packages/config`, docs/07 §3.1) ;
 * - **arrêt propre** : on ferme le serveur, puis la base.
 */

async function main(): Promise<void> {
  let context: ReturnType<typeof buildApi>;

  try {
    context = buildApi();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const app = buildServer(context);
  const { logger, config } = context;

  await app.listen({ host: config.env.APP_HOST, port: config.env.APP_PORT });

  const health = context.health();
  logger.info(
    { url: `http://${config.env.APP_HOST}:${config.env.APP_PORT}`, status: health.status },
    'API démarrée — diagnostic disponible sur GET /system/health',
  );
  for (const check of health.checks) {
    const icon = check.status === 'ok' ? '✅' : check.status === 'warn' ? '⚠️ ' : '❌';
    logger.info(`${icon} ${check.label} — ${check.detail}`);
  }

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'signal reçu : arrêt propre en cours');
    void app
      .close()
      .then(() => {
        context.handle.close();
        logger.info('API arrêtée proprement');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'échec de l’arrêt propre');
        process.exit(1);
      });
  };

  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

void main();
