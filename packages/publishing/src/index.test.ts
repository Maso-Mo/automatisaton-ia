import { describe, expect, it } from 'vitest';
import { manualConnectors, type PublishRequest } from './index';

const targets = {
  linkedin: 'linkedin_post',
  reddit: 'reddit_post',
  tiktok: 'tiktok_short',
  youtube: 'youtube_short',
} as const;

describe('contrat PlatformConnector niveau C', () => {
  it.each(Object.entries(manualConnectors))(
    '%s produit toujours un paquet exploitable sans API',
    async (name, connector) => {
      const req: PublishRequest = {
        contentItemId: 'item',
        contentVersionId: 'version',
        target: targets[name as keyof typeof targets],
        platform: connector.platform,
        body: 'Texte final exact à publier.',
        title: 'Titre',
        hook: 'Hook',
        description: null,
        hashtags: ['#test'],
        mentions: [],
        idempotencyKey: 'key',
        assets: [],
      };
      expect(connector.capabilities().level).toBe('C');
      expect((await connector.publish(req)).outcome).toBe('manual_required');
      const pkg = await connector.buildManualPackage(req);
      expect(pkg.body).toBe(req.body);
      expect(pkg.instructions.length).toBeLessThan(600);
      expect(pkg.checklist.length).toBeGreaterThan(0);
      expect(connector.capabilities().textLimits.length).toBeGreaterThan(0);
    },
  );

  it('bloque uniquement une limite officielle stable et garde les limites prudentes en avertissement', async () => {
    const youtube = manualConnectors.youtube;
    const youtubeRequest: PublishRequest = {
      contentItemId: 'item',
      contentVersionId: 'version',
      target: 'youtube_short',
      platform: 'youtube',
      body: 'Script',
      title: 'x'.repeat(101),
      hook: 'Hook',
      description: 'Description',
      hashtags: [],
      mentions: [],
      idempotencyKey: 'youtube-limit',
      assets: [],
    };
    expect((await youtube.validateContent(youtubeRequest)).ok).toBe(false);

    const linkedin = manualConnectors.linkedin;
    const linkedinRequest = {
      ...youtubeRequest,
      target: 'linkedin_post' as const,
      platform: 'linkedin' as const,
      body: 'x'.repeat(3_001),
      title: null,
      idempotencyKey: 'linkedin-advisory',
    };
    const report = await linkedin.validateContent(linkedinRequest);
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});
