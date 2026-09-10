import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';

/**
 * En-têtes et CORS (docs/07 §3.3). Le CSP est la protection principale contre le
 * XSS ici, parce que le contenu affiché vient d'un modèle et peut contenir du
 * HTML : rien n'est autorisé en ligne, et `dangerouslySetInnerHTML` est interdit
 * dans tout le dépôt (règle ESLint).
 *
 * CORS : **une seule origine**, celle de `APP_URL`. Un `*` avec cookies est
 * refusé par les navigateurs et traduit un malentendu.
 */
export function registerSecurity(app: FastifyInstance, context: ApiContext): void {
  const allowedOrigin = context.config.env.APP_URL;

  void app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", allowedOrigin],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    frameguard: { action: 'deny' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  void app.register(cors, {
    origin: [allowedOrigin],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  // Le port est fixe et l'accès reste local : on l'écrit au démarrage, une fois.
  app.addHook('onRequest', async (request) => {
    request.log.debug({ url: request.url, method: request.method }, 'requête reçue');
  });
}
