import {
  applyProposals,
  briefDetail,
  briefEditBodySchema,
  closeConversation,
  closeConversationBodySchema,
  CONVERSATION_SLOT_LABELS,
  conversationListQuerySchema,
  createConversation,
  createConversationBodySchema,
  currentBrief,
  getConversation,
  listConversations,
  listMasterBriefs,
  listMessages,
  messageListQuerySchema,
  parseOrThrow,
  postMessageBodySchema,
  proposalDecisionBodySchema,
  reopenConversation,
  updateMasterBrief,
  validateMasterBrief,
  type ConversationPorts,
} from '@aia/core';
import type { FastifyInstance } from 'fastify';
import type { ApiContext } from '../bootstrap';
import { generateMasterBrief, runConversationTurn } from '../features/conversation';

/**
 * Conversation et fiche maître (docs/10 §4.2, docs/05 §3).
 *
 * Deux principes gouvernent ces routes :
 *
 * 1. **le domaine décide** : la route valide une entrée (`parseOrThrow`), appelle
 *    un cas d'usage de `@aia/core`, et rend le résultat. Aucune règle métier ici ;
 * 2. **l'écriture proposée n'est jamais appliquée par le modèle** : le tour
 *    enregistre un plan (`POST /conversations/:id/messages`), et c'est
 *    `POST …/proposals` qui applique les décisions de l'utilisateur.
 */

export function registerConversationRoutes(app: FastifyInstance, context: ApiContext): void {
  const ports: ConversationPorts = context.conversation;

  app.get('/conversations', async (request) => {
    const query = parseOrThrow(
      conversationListQuerySchema,
      request.query,
      'CONVERSATION_QUERY_INVALID',
    );
    return {
      conversations: listConversations(ports, {
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      }),
    };
  });

  app.post('/conversations', async (request, reply) => {
    const body = parseOrThrow(
      createConversationBodySchema,
      request.body,
      'CONVERSATION_INPUT_INVALID',
    );
    const conversation = createConversation(ports, body.projectId, {
      ...(body.kind ? { kind: body.kind } : {}),
      ...(body.title !== undefined ? { title: body.title } : {}),
    });
    reply.status(201);
    return { conversation };
  });

  app.get('/conversations/:id', async (request) => {
    const { id } = request.params as { id: string };
    const conversation = getConversation(ports, id);
    const messages = listMessages(ports, id);
    const briefs = listMasterBriefs(ports, id);
    return {
      conversation,
      messages,
      briefs,
      /** La phase courante dit *pourquoi* la question posée est celle-là. */
      nextSlot: conversation.missingSlots[0] ?? null,
      slotLabels: CONVERSATION_SLOT_LABELS,
    };
  });

  app.get('/conversations/:id/messages', async (request) => {
    const { id } = request.params as { id: string };
    const query = parseOrThrow(messageListQuerySchema, request.query, 'MESSAGE_QUERY_INVALID');
    return {
      messages: listMessages(ports, id, {
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
        ...(query.includeDeleted !== undefined ? { includeDeleted: query.includeDeleted } : {}),
      }),
    };
  });

  app.post('/conversations/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(postMessageBodySchema, request.body, 'MESSAGE_INPUT_INVALID');
    const result = await runConversationTurn(context.conversationFeature, id, {
      content: body.content,
    });
    reply.status(201);
    return {
      conversation: result.conversation,
      userMessage: result.userMessage,
      message: result.assistantMessage,
      plan: result.plan,
      usage: result.usage,
      repaired: result.repaired,
    };
  });

  /** Acceptation des propositions d'un message assistant : le seul chemin d'écriture. */
  app.post('/conversations/:id/messages/:messageId/proposals', async (request) => {
    const { id, messageId } = request.params as { id: string; messageId: string };
    const body = parseOrThrow(
      proposalDecisionBodySchema,
      request.body,
      'PROPOSAL_DECISION_INVALID',
    );
    const result = applyProposals(ports, id, messageId, {
      accept: body.accept,
      ...(body.confirmFacts === undefined ? {} : { confirmFacts: body.confirmFacts }),
    });
    return {
      plan: result.plan,
      facts: result.facts,
      skills: result.skills,
      audiences: result.audiences,
      styles: result.styles,
      refused: result.refused,
      conversation: result.conversation,
    };
  });

  app.post('/conversations/:id/close', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(
      closeConversationBodySchema,
      request.body ?? {},
      'CLOSE_INPUT_INVALID',
    );
    return {
      conversation: body.closed ? closeConversation(ports, id) : reopenConversation(ports, id),
    };
  });

  app.post('/conversations/:id/reopen', async (request) => {
    const { id } = request.params as { id: string };
    return { conversation: reopenConversation(ports, id) };
  });

  // --- Fiche maître ----------------------------------------------------------

  /**
   * Génération **explicite** : aucune fiche ne se produit pendant un tour de
   * conversation (docs/05 §3.4). Le refus « positionnement ou public manquant »
   * vient du domaine (`ProjectNotReadyError`).
   */
  app.post('/conversations/:id/brief', async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await generateMasterBrief(context.conversationFeature, id);
    reply.status(201);
    return {
      brief: result.brief,
      missing: briefDetail(ports, result.brief.id).missing,
      usage: result.usage,
      repaired: result.repaired,
      conversation: result.conversation,
    };
  });

  app.get('/briefs/:briefId', async (request) => {
    const { briefId } = request.params as { briefId: string };
    return briefDetail(ports, briefId);
  });

  /** Corriger la fiche = créer une version. L'ancienne reste lisible, intacte. */
  app.patch('/briefs/:briefId', async (request, reply) => {
    const { briefId } = request.params as { briefId: string };
    const body = parseOrThrow(briefEditBodySchema, request.body, 'BRIEF_EDIT_INVALID');
    const brief = updateMasterBrief(ports, briefId, body);
    reply.status(201);
    return { brief, missing: briefDetail(ports, brief.id).missing };
  });

  /** Valider : un acte humain, daté — c'est aussi ce qui fixe le positionnement. */
  app.post('/briefs/:briefId/validation', async (request) => {
    const { briefId } = request.params as { briefId: string };
    return { brief: validateMasterBrief(ports, briefId) };
  });

  app.get('/projects/:id/brief', async (request) => {
    const { id } = request.params as { id: string };
    return { brief: currentBrief(ports, id) ?? null };
  });

  // --- Flux temps réel -------------------------------------------------------

  /**
   * SSE **reprenable** (docs/02 §13) : un état complet d'abord, puis les
   * événements incrémentaux. Le client qui se reconnecte après avoir fermé son
   * onglet ne perd rien — c'est ce qui permet de reprendre un entretien.
   */
  app.get('/events/conversations/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { intervalMs?: string };
    const conversation = getConversation(ports, id);
    const intervalMs = Math.min(Math.max(Number(query.intervalMs ?? 1_500) || 1_500, 500), 10_000);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.hijack();

    const send = (event: string, data: unknown): void => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let seen = new Set<string>();
    const flush = (): void => {
      const messages = listMessages(ports, id);
      for (const message of messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        send('message', message);
      }
    };

    send('snapshot', {
      conversation: getConversation(ports, id),
      messages: listMessages(ports, id),
    });
    seen = new Set(listMessages(ports, id).map((message) => message.id));

    const interval = setInterval(() => {
      try {
        const current = getConversation(ports, id);
        send('progress', {
          stage: current.stage,
          missingSlots: current.missingSlots,
          nextSlot: current.missingSlots[0] ?? null,
        });
        flush();
      } catch (error) {
        context.logger.error({ err: error, conversationId: id }, 'flux SSE interrompu');
        send('closed', { reason: 'erreur interne' });
        clearInterval(interval);
        reply.raw.end();
      }
    }, intervalMs);

    request.raw.on('close', () => {
      clearInterval(interval);
      context.logger.debug(
        { conversationId: id, snapshot: conversation.stage },
        'client SSE déconnecté',
      );
    });
  });
}
