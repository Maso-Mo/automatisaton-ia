import { createHash, timingSafeEqual } from 'node:crypto';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';
import { redactToken } from '../redact';

/**
 * En-têtes, CORS et contrôle d'accès (docs/07 §3.3).
 *
 * Le CSP est la protection principale contre le XSS ici, parce que le contenu
 * affiché vient d'un modèle et peut contenir du HTML : rien n'est autorisé en
 * ligne, et `dangerouslySetInnerHTML` est interdit dans tout le dépôt (règle
 * ESLint).
 *
 * CORS : **une seule origine**, celle de `APP_URL`. Un `*` avec cookies est
 * refusé par les navigateurs et traduit un malentendu.
 */

/**
 * Routes publiques même quand `AUTH_TOKEN` est défini : ce sont les sondes de
 * supervision (`/health`, `/ready`). Elles ne lisent aucune donnée utilisateur,
 * seulement l'état du processus et de la base — un superviseur n'a pas à
 * connaître un secret pour savoir si le service est vivant (docs/10 §12).
 */
const PUBLIC_PATHS = new Set(['/health', '/ready']);

/** Comparaison à temps constant : la comparaison de chaînes fuit par sa durée. */
function tokenMatches(expected: string, provided: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(provided));
}

/** En-têtes acceptés : `Authorization: Bearer …` ou `X-Auth-Token: …`. */
function providedToken(headers: Record<string, string | string[] | undefined>): string {
  const authorization = headers.authorization;
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim();
  }
  const header = headers['x-auth-token'];
  if (typeof header === 'string') return header.trim();
  if (Array.isArray(header)) return (header[0] ?? '').trim();
  return '';
}

function isLocalHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Le jeton peut aussi arriver **en paramètre d'URL** : `EventSource` (SSE) et les
 * balises `<img>`/`<video>` ne peuvent pas porter d'en-tête `Authorization`. Il
 * n'est accepté que pour une **lecture** (`GET`/`HEAD`) — jamais pour une
 * écriture, où un jeton d'URL finirait dans un historique ou un journal.
 */
function tokenFromQuery(url: string): string {
  const index = url.indexOf('?');
  if (index === -1) return '';
  return new URLSearchParams(url.slice(index + 1)).get('token')?.trim() ?? '';
}

/** Retire le jeton d'une URL avant de la journaliser : un journal n'est pas un coffre. */

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
    request.log.debug({ url: redactToken(request.url), method: request.method }, 'requête reçue');
  });

  // ------------------------------------------------------------------------
  // Protection d'accès (étape 12 §22).
  //
  // Défaut sûr : sans `AUTH_TOKEN`, l'API suppose un accès local (localhost). On
  // n'invente pas d'authentification — il n'y a qu'un utilisateur (docs/01). Dès
  // qu'on ouvre l'accès à autre chose que la machine locale (LAN, tunnel), un
  // jeton devient **nécessaire** ; le refus se fait alors par défaut, jamais par
  // oubli : si le jeton est absent, on prévient au démarrage.
  // ------------------------------------------------------------------------
  const authToken = context.config.env.AUTH_TOKEN ?? '';

  if (authToken === '') {
    if (!isLocalHost(context.config.env.APP_HOST)) {
      app.log.warn(
        { host: context.config.env.APP_HOST },
        'API exposée hors localhost sans AUTH_TOKEN : définir AUTH_TOKEN dans .env',
      );
    }
  } else {
    app.addHook('onRequest', async (request, reply) => {
      if (request.method === 'OPTIONS') return;
      const path = request.url.split('?')[0] ?? '';
      if (PUBLIC_PATHS.has(path)) return;

      const readOnly = request.method === 'GET' || request.method === 'HEAD';
      const provided =
        providedToken(request.headers) || (readOnly ? tokenFromQuery(request.url) : '');
      if (provided === '' || !tokenMatches(authToken, provided)) {
        request.log.warn(
          { url: redactToken(request.url), method: request.method },
          'accès refusé (jeton absent ou invalide)',
        );
        reply.code(401).send({
          error: 'UNAUTHORIZED',
          message: 'Jeton d’accès requis (en-tête Authorization: Bearer … ou X-Auth-Token).',
        });
        return reply;
      }
    });
  }
}
