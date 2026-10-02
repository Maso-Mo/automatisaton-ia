import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { connectorFor } from '@aia/publishing';
import { encryptToken } from '@aia/config';
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
}
