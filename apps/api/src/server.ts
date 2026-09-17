import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandler } from './plugins/errors';
import { registerSecurity } from './plugins/security';
import { registerSystemRoutes } from './routes/system';
import { registerJobRoutes } from './routes/jobs';
import { registerProjectRoutes } from './routes/projects';
import { registerConversationRoutes } from './routes/conversations';
import { registerEditorialRoutes } from './routes/editorial';
import type { ApiContext } from './bootstrap';

/**
 * Le serveur est construit sans écouter : les tests d'intégration utilisent
 * `app.inject()` sur le même objet que la production. Un test qui ne peut pas
 * exécuter le code réel ne teste rien.
 */
export function buildServer(context: ApiContext): FastifyInstance {
  const app = Fastify({
    // `pino` satisfait l'interface attendue par Fastify ; le cast évite de perdre
    // le type par défaut de l'instance (c'est le même objet à l'exécution).
    loggerInstance: context.logger as unknown as FastifyBaseLogger,
    trustProxy: false,
  });

  registerSecurity(app, context);
  registerErrorHandler(app);

  app.get('/', async () => ({
    name: 'automatisation-ia',
    version: '0.1.0',
    step: 'étape 4 — génération éditoriale',
    endpoints: [
      'GET /system/health',
      'GET /jobs',
      'GET /jobs/:id',
      'GET /events/jobs/:id',
      'GET /projects',
      'POST /projects',
      'GET /projects/:id',
      'PATCH /projects/:id',
      'POST /projects/:id/archive',
      'GET /projects/:id/facts',
      'POST /projects/:id/facts',
      'PATCH /projects/:id/facts/:factId',
      'POST /projects/:id/facts/:factId/verification',
      'POST /projects/:id/facts/:factId/replacement',
      'GET /projects/:id/context',
      'GET /projects/:id/brief',
      'GET /projects/vocabulary',
      'GET /conversations',
      'POST /conversations',
      'GET /conversations/:id',
      'GET /conversations/:id/messages',
      'POST /conversations/:id/messages',
      'POST /conversations/:id/messages/:messageId/proposals',
      'POST /conversations/:id/close',
      'POST /conversations/:id/reopen',
      'POST /conversations/:id/brief',
      'GET /briefs/:briefId',
      'PATCH /briefs/:briefId',
      'POST /briefs/:briefId/validation',
      'GET /events/conversations/:id',
      'POST /projects/:id/plan',
      'GET /projects/:id/subjects',
      'GET /subjects/:subjectId',
      'POST /angles/:angleId/select',
      'POST /angles/:angleId/reject',
      'GET /projects/:id/content',
      'POST /projects/:id/content',
      'POST /content/:contentId/regenerate',
      'GET /content/:contentId',
      'POST /content/:contentId/review',
      'PATCH /content/:contentId',
      'POST /content/:contentId/approve',
      'POST /content/:contentId/reject',
    ],
  }));

  registerSystemRoutes(app, context);
  registerJobRoutes(app, context);
  registerProjectRoutes(app, context);
  registerConversationRoutes(app, context);
  registerEditorialRoutes(app, context);

  return app;
}
