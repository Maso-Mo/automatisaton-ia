import type { FastifyInstance } from 'fastify';
import { AppError, serializeError, toAppError } from '@aia/shared';
import { CATEGORY_TO_STATUS } from '../http-status';

/** Corps d'erreur envoyé au client : jamais de trace de pile (docs/08 §6.3). */
export function errorBody(error: unknown): { error: Record<string, unknown> } {
  const serialized = serializeError(toAppError(error));
  const { stack: _stack, ...safe } = serialized;
  return { error: safe };
}

/**
 * Gestionnaire d'erreurs unique : la **catégorie** de l'erreur détermine le
 * statut HTTP, jamais son type concret ni un test sur le message (docs/02 §12).
 *
 * Le corps renvoyé est le `SerializedError` complet — catégorie comprise — pour
 * que l'interface puisse afficher « pourquoi ça a échoué » sans deviner.
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);

    if (appError.category === 'internal') {
      request.log.error({ err: appError, url: request.url }, 'erreur interne');
    } else {
      request.log.warn(
        { category: appError.category, code: appError.code, url: request.url },
        appError.message,
      );
    }

    const status = CATEGORY_TO_STATUS[appError.category] ?? 500;
    reply.status(status).send(errorBody(appError));
  });

  app.setNotFoundHandler((request, reply) => {
    const error = new AppError(`Route inconnue : ${request.method} ${request.url}`, 'not_found');
    reply.status(404).send(errorBody(error));
  });
}
