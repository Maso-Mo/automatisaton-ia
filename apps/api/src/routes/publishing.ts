import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectorFor, publicationIdempotencyKey } from '@aia/publishing';
import { encryptToken } from '@aia/config';
import { PUBLISH_CONTENT_JOB } from '@aia/queue';
import { ConflictError, NotFoundError, ValidationError, hashText } from '@aia/shared';
import { contentBundle, parseOrThrow } from '@aia/core';
import type { ApiContext } from '../bootstrap';

const supportedPlatformSchema = z.enum(['linkedin', 'reddit', 'tiktok', 'youtube']);
const accountBodySchema = z.object({
  platform: supportedPlatformSchema,
  accountLabel: z.string().min(1).max(120),
  remoteAccountId: z.string().max(300).nullable().optional(),
  accessToken: z.string().min(1).max(8_000).nullable().optional(),
  refreshToken: z.string().min(1).max(8_000).nullable().optional(),
});
const markPublishedSchema = z.object({ platformAccountId: z.string().min(1) });
const publicationRequestSchema = z.object({
  platformAccountId: z.string().min(1),
  scheduledFor: z.number().int().nonnegative().nullable().optional(),
});
const publicationDecisionSchema = z.object({
  decision: z.enum(['published', 'retry', 'abandon']),
  note: z.string().max(2_000).nullable().optional(),
});

export function registerPublishingRoutes(app: FastifyInstance, context: ApiContext): void {
  app.get('/projects/:id/platform-accounts', async (request) => {
    const { id } = request.params as { id: string };
    return { accounts: context.publishing.listAccounts(id) };
  });

  app.post('/projects/:id/platform-accounts', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(accountBodySchema, request.body, 'PLATFORM_ACCOUNT_INVALID');
    const connector = connectorFor(body.platform);
    if (!connector) {
      throw new ValidationError('Plateforme non prise en charge.', {
        code: 'PLATFORM_UNSUPPORTED',
      });
    }
    const account = context.publishing.createAccount({
      projectId: id,
      platform: body.platform,
      accountLabel: body.accountLabel,
      remoteAccountId: body.remoteAccountId ?? null,
      accessTokenEncrypted: body.accessToken
        ? encryptToken(body.accessToken, context.config.encryptionKey)
        : null,
      refreshTokenEncrypted: body.refreshToken
        ? encryptToken(body.refreshToken, context.config.encryptionKey)
        : null,
      capabilities: connector.capabilities(),
    });
    return reply.status(201).send({ account });
  });

  app.post('/content/:contentId/manual-package', async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    const bundle = contentBundle(context.editorial.ports, contentId);
    const { item, version } = bundle;
    if (
      !version ||
      item.state !== 'approved' ||
      item.approvedVersionId !== version.id ||
      version.approvedAt === null
    ) {
      throw new ConflictError(
        'Le paquet manuel exige la version courante explicitement approuvée.',
        { code: 'MANUAL_PACKAGE_REQUIRES_APPROVAL' },
      );
    }
    const connector = connectorFor(item.platform);
    if (!connector) {
      throw new ValidationError('Plateforme non prise en charge.', {
        code: 'PLATFORM_UNSUPPORTED',
      });
    }
    const requestData = {
      contentItemId: item.id,
      contentVersionId: version.id,
      target: item.target,
      platform: item.platform,
      body: version.body,
      title: version.title,
      hook: version.hook,
      description: version.body,
      hashtags: version.hashtags,
      mentions: version.mentions,
      idempotencyKey: hashText(`${version.id}:${item.platform}:manual`),
      assets: version.mediaAssetIds.map((path) => ({ path, kind: 'media' })),
    };
    const validation = await connector.validateContent(requestData);
    if (!validation.ok) {
      throw new ValidationError('Le paquet ne peut pas être construit : contenu invalide.', {
        code: 'MANUAL_PACKAGE_INVALID',
        details: { issues: validation.issues },
      });
    }
    const built = await connector.buildManualPackage(requestData);
    const manualPackage = context.publishing.upsertManualPackage({
      contentItemId: item.id,
      contentVersionId: version.id,
      platform: item.platform,
      body: built.body,
      title: built.title,
      copyBlocks: {
        body: built.body,
        title: built.title,
        hook: built.hook,
        description: built.description,
        hashtags: built.hashtags.join(' '),
        mentions: built.mentions.join(' '),
        checklist: built.checklist,
        expectedMedia: built.expectedMedia,
      },
      assetPaths: built.assets.map((asset) => asset.path),
      instructions: built.instructions,
      deepLink: built.deepLink,
    });
    return reply.status(201).send({ manualPackage, validation });
  });

  app.post('/manual-packages/:packageId/published', async (request) => {
    const { packageId } = request.params as { packageId: string };
    const body = parseOrThrow(markPublishedSchema, request.body, 'MANUAL_PUBLICATION_INVALID');
    const pkg = context.publishing.getManualPackage(packageId);
    if (!pkg) {
      throw new NotFoundError('Paquet manuel introuvable.', { code: 'MANUAL_PACKAGE_NOT_FOUND' });
    }
    const account = context.publishing.getAccount(body.platformAccountId);
    if (!account) {
      throw new NotFoundError('Compte plateforme introuvable.', {
        code: 'PLATFORM_ACCOUNT_NOT_FOUND',
      });
    }
    const item = context.editorial.ports.store.getContentItem(pkg.contentItemId);
    const version = context.editorial.ports.store.getVersion(pkg.contentVersionId);
    if (!item || !version) {
      throw new NotFoundError('Contenu du paquet introuvable.', { code: 'CONTENT_NOT_FOUND' });
    }
    if (account.projectId !== item.projectId || account.platform !== pkg.platform) {
      throw new ConflictError(
        'Le compte ne correspond pas au projet et à la plateforme du paquet.',
        { code: 'PLATFORM_ACCOUNT_MISMATCH' },
      );
    }
    if (
      item.state !== 'approved' ||
      item.approvedVersionId !== version.id ||
      version.approvedAt === null
    ) {
      throw new ConflictError('Publication impossible : cette version n’est plus approuvée.', {
        code: 'PUBLICATION_REQUIRES_APPROVAL',
      });
    }
    const confirmedAt = context.clock.nowMs();
    const result = context.publishing.markPublished({
      packageId: pkg.id,
      projectId: item.projectId,
      contentItemId: item.id,
      contentVersionId: version.id,
      platform: pkg.platform,
      platformAccountId: account.id,
      idempotencyKey: hashText(`${version.id}:${account.id}:manual`),
      exactRequest: {
        platform: pkg.platform,
        accountId: account.id,
        contentItemId: item.id,
        contentVersionId: version.id,
        body: pkg.body,
        title: pkg.title,
        copyBlocks: pkg.copyBlocks,
        confirmedAt,
      },
    });
    context.editorial.ports.store.updateContentItem(item.id, {
      state: 'publishing',
      publishedAt: result.publishedAt,
    });
    context.editorial.ports.store.updateContentItem(item.id, { state: 'published' });
    return {
      publication: {
        ...result,
        status: 'published',
        contentVersionId: version.id,
        exactText: pkg.body,
      },
    };
  });

  /**
   * Le déclencheur « publier maintenant » (docs/05 §8.1, §8.4). Trois refus
   * explicites **avant** toute mise en file, dans cet ordre :
   *
   * 1. une **version approuvée courante** doit exister — l'invariant n° 1 du
   *    produit : aucune publication sans approbation ;
   * 2. le compte doit appartenir au **même projet** et à la **même plateforme**
   *    que le contenu (publication sur une autre plateforme « à la place » :
   *    jamais, docs/06 §9.3) ;
   * 3. la publication est **idempotente** : deux clics produisent une seule ligne
   *    (`ensurePublication`) et un seul job (clé de déduplication).
   *
   * Un `scheduledFor` futur n'exécute rien à l'avance : le job est créé avec sa
   * date (`delayMs`), et le planificateur de l'étape 9 le promeut à l'échéance.
   */
  app.post('/content/:contentId/publications', async (request, reply) => {
    const { contentId } = request.params as { contentId: string };
    const body = parseOrThrow(
      publicationRequestSchema,
      request.body,
      'PUBLICATION_REQUEST_INVALID',
    );
    const { item, version } = contentBundle(context.editorial.ports, contentId);
    if (
      !version ||
      item.state !== 'approved' ||
      item.approvedVersionId !== version.id ||
      version.approvedAt === null
    ) {
      throw new ConflictError(
        'Publication impossible : aucune version approuvée courante pour ce contenu.',
        { code: 'PUBLICATION_REQUIRES_APPROVAL' },
      );
    }
    const account = context.publishing.getAccount(body.platformAccountId);
    if (!account) {
      throw new NotFoundError('Compte plateforme introuvable.', {
        code: 'PLATFORM_ACCOUNT_NOT_FOUND',
      });
    }
    if (account.projectId !== item.projectId || account.platform !== item.platform) {
      throw new ConflictError(
        'Le compte ne correspond pas au projet et à la plateforme du contenu.',
        { code: 'PLATFORM_ACCOUNT_MISMATCH' },
      );
    }

    const scheduledFor = body.scheduledFor ?? null;
    const idempotencyKey = publicationIdempotencyKey({
      contentVersionId: version.id,
      platformAccountId: account.id,
      scheduledFor,
    });
    const { publication, created } = context.publishing.ensurePublication({
      projectId: item.projectId,
      contentItemId: item.id,
      contentVersionId: version.id,
      platformAccountId: account.id,
      platform: item.platform,
      idempotencyKey,
      scheduledFor,
      status: 'planned',
    });
    const delayMs = scheduledFor === null ? 0 : Math.max(0, scheduledFor - context.clock.nowMs());
    const jobId = await context.editorial.queue.enqueue(
      PUBLISH_CONTENT_JOB,
      { publicationId: publication.id },
      { delayMs, projectId: item.projectId, contentItemId: item.id },
    );
    reply.status(202);
    return { publication, created, jobId };
  });

  app.get('/content/:contentId/publications', async (request) => {
    const { contentId } = request.params as { contentId: string };
    const publications = context.publishing.listByContentItem(contentId).map((publication) => ({
      ...publication,
      attempts: context.publishing.listAttempts(publication.id),
    }));
    return { publications };
  });

  /**
   * **La décision humaine sur une ambiguïté** (docs/05 §8.3). C'est le seul
   * chemin qui sort une publication de l'état `ambiguous`, et il est explicite :
   * l'utilisateur a vérifié la plateforme et tranche — « c'est publié »,
   * « republier », ou « abandonner ». Aucune reprise automatique n'existe pour
   * cet état, précisément parce que rejouer un POST ambigu crée un doublon.
   */
  app.post('/publications/:id/decision', async (request) => {
    const { id } = request.params as { id: string };
    const body = parseOrThrow(
      publicationDecisionSchema,
      request.body,
      'PUBLICATION_DECISION_INVALID',
    );
    const publication = context.publishing.getPublication(id);
    if (!publication) {
      throw new NotFoundError('Publication introuvable.', { code: 'PUBLICATION_NOT_FOUND' });
    }
    if (!publication.needsHumanDecision) {
      throw new ConflictError('Cette publication n’attend aucune décision humaine.', {
        code: 'PUBLICATION_NO_DECISION_PENDING',
      });
    }
    const note = body.note ?? null;

    if (body.decision === 'published') {
      const settled = context.publishing.settlePublication(id, {
        status: 'published',
        needsHumanDecision: false,
        decisionNote: note ?? 'Marquée publiée après vérification humaine.',
        publishedAt: context.clock.nowMs(),
      });
      return { publication: settled };
    }
    if (body.decision === 'retry') {
      const settled = context.publishing.settlePublication(id, {
        status: 'planned',
        needsHumanDecision: false,
        decisionNote: note ?? 'Reprise décidée après vérification humaine.',
      });
      const jobId = await context.editorial.queue.enqueue(
        PUBLISH_CONTENT_JOB,
        { publicationId: id },
        { projectId: publication.projectId, contentItemId: publication.contentItemId },
      );
      return { publication: settled, jobId };
    }
    const settled = context.publishing.settlePublication(id, {
      status: 'cancelled',
      needsHumanDecision: false,
      decisionNote: note ?? 'Publication abandonnée après vérification humaine.',
    });
    return { publication: settled };
  });
}
