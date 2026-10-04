import { describe, expect, it, vi } from 'vitest';
import {
  canonicalizeNewsUrl,
  classifyUrgency,
  createEditorialSuggestion,
  createFeedProvider,
  enrichWithinBudget,
  normalizeRawNewsItem,
  scoreNews,
  titleSimilarity,
  type NewsSourceConfig,
} from '.';

const source: NewsSourceConfig = {
  id: 'source-1',
  name: 'Flux React',
  type: 'rss',
  url: 'https://example.test/feed.xml',
  categories: ['react', 'typescript', 'dev'],
  trustLevel: 5,
  language: 'fr',
};

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Tech</title><item>
<guid>react-20</guid><title>React 20 améliore TypeScript</title>
<link>https://example.test/react-20?utm_source=rss</link>
<description>La nouvelle version simplifie les applications frontend.</description>
<pubDate>Sun, 04 Oct 2026 08:00:00 GMT</pubDate><author>Équipe React</author>
<category>React</category></item></channel></rss>`;

describe('providers et normalisation news', () => {
  it('lit un RSS valide et conserve sa provenance', async () => {
    const provider = createFeedProvider({
      type: 'rss',
      fetch: async () => new Response(RSS, { status: 200 }),
    });
    const payload = await provider.fetchLatest(source);
    const [item] = provider.normalize(payload, source);
    expect(item).toMatchObject({
      externalId: 'react-20',
      canonicalUrl: 'https://example.test/react-20',
      author: 'Équipe React',
      language: 'fr',
    });
    expect(item?.categories).toEqual(expect.arrayContaining(['react', 'typescript']));
  });

  it('refuse un flux invalide et expose un healthCheck en échec', async () => {
    const provider = createFeedProvider({
      type: 'rss',
      fetch: async () => new Response('<html>pas un flux</html>', { status: 200 }),
    });
    const health = await provider.healthCheck(source);
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('aucune entrée');
  });

  it('borne la collecte et propage un timeout abortable', async () => {
    vi.useFakeTimers();
    const provider = createFeedProvider({
      type: 'rss',
      timeoutMs: 100,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });
    const pending = provider.fetchLatest(source);
    const rejected = expect(pending).rejects.toThrow('Délai');
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    vi.useRealTimers();
  });

  it('canonise les URLs et détecte une similarité déterministe cross-source', () => {
    expect(canonicalizeNewsUrl('https://EXAMPLE.test/article/?utm_campaign=x&b=2&a=1#partie')).toBe(
      'https://example.test/article?a=1&b=2',
    );
    expect(
      titleSimilarity(
        'React 20 améliore fortement TypeScript',
        'React 20 : TypeScript fortement amélioré',
      ),
    ).toBeGreaterThan(0.7);
  });
});

describe('scoring, urgence, suggestion et budget', () => {
  const item = normalizeRawNewsItem(
    {
      externalId: 'react-20',
      url: 'https://example.test/react-20',
      title: 'React 20 améliore TypeScript pour les développeurs',
      summary: 'Une nouvelle API aide les équipes frontend et les outils IA.',
      publishedAt: Date.UTC(2026, 9, 4, 8),
    },
    source,
  );

  it('calcule chaque composante et explique le rapprochement projet', () => {
    const score = scoreNews(item, {
      nowMs: Date.UTC(2026, 9, 4, 10),
      sourceTrustLevel: source.trustLevel,
      sourceCategories: source.categories,
      projectName: 'Finance React',
      projectTerms: ['frontend', 'typescript'],
      audienceTerms: ['développeurs', 'équipes'],
    });
    expect(score.final).toBeGreaterThan(70);
    expect(score.trust).toBe(100);
    expect(score.freshness).toBe(100);
    expect(score.explanation.join(' ')).toContain('Correspondance projet');
    expect(createEditorialSuggestion({ item, score, projectId: 'project-1' })).toMatchObject({
      platform: 'linkedin',
      projectId: 'project-1',
      verificationRequired: true,
    });
  });

  it.each([
    [{ finalScore: 90, freshnessScore: 100, categories: [] }, 'BREAKING'],
    [{ finalScore: 75, freshnessScore: 85, categories: [] }, 'HIGH'],
    [{ finalScore: 60, freshnessScore: 65, categories: [] }, 'NORMAL'],
    [{ finalScore: 90, freshnessScore: 100, categories: ['evergreen'] }, 'EVERGREEN'],
  ] as const)('classe l’urgence %s en %s', (input, expected) => {
    expect(classifyUrgency(input)).toBe(expected);
  });

  it('retient un enrichissement payant quand le budget est insuffisant', async () => {
    let calls = 0;
    const result = await enrichWithinBudget({
      items: [item, { ...item, externalId: 'second' }],
      remainingMicroUsd: 50,
      enricher: {
        estimateMicroUsd: () => 40,
        enrich: async () => {
          calls += 1;
          return { angle: 'Angle vérifié' };
        },
      },
    });
    expect(calls).toBe(1);
    expect(result.enriched).toHaveLength(1);
    expect(result.held).toHaveLength(1);
    expect(result.spentMicroUsd).toBe(40);
  });
});
