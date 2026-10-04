import type { FastifyInstance } from 'fastify';
import { AppError, ValidationError, serializeError, toAppError } from '@aia/shared';
import { CATEGORY_TO_STATUS } from '../http-status';
import { redactToken } from '../redact';

/** Corps d'erreur envoyé au client : jamais de trace de pile (docs/08 §6.3). */
export function errorBody(error: unknown): { error: Record<string, unknown> } {
  const serialized = serializeError(toAppError(error));
  const { stack: _stack, ...safe } = serialized;
  return { error: safe };
}

/**
 * Un corps de requête qui dépasse la limite déclarée par la route
 * (`bodyLimit`, cf. `routes/media.ts`) est refusé par Fastify **avant** le
 * gestionnaire : c'est une erreur de format, pas une panne. Sans cette
 * traduction, un enregistrement trop volumineux produirait un `500` et l'écran
 * afficherait « erreur interne » au lieu de « fichier trop volumineux ».
 */
function tooLargeBody(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  );
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
    if (tooLargeBody(error)) {
      request.log.warn({ url: redactToken(request.url) }, 'corps de requête au-delà de la limite');
      reply.status(413).send(
        errorBody(
          new ValidationError('Le fichier envoyé dépasse la taille maximale.', {
            code: 'UPLOAD_TOO_LARGE',
          }),
        ),
      );
      return;
    }

    const appError = toAppError(error);

    if (appError.category === 'internal') {
      request.log.error({ err: appError, url: redactToken(request.url) }, 'erreur interne');
    } else {
      request.log.warn(
        { category: appError.category, code: appError.code, url: redactToken(request.url) },
        appError.message,
      );
    }

    const status = CATEGORY_TO_STATUS[appError.category] ?? 500;
    reply.status(status).send(errorBody(appError));
  });

  app.setNotFoundHandler((request, reply) => {
    // L'URL est nommée dans le message — donc masquée : une route inconnue
    // peut être une URL d'image ou de flux qui portait un jeton de lecture.
    const error = new AppError(
      `Route inconnue : ${request.method} ${redactToken(request.url)}`,
      'not_found',
    );
    reply.status(404).send(errorBody(error));
  });
}
