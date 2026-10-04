import type { NewsStore } from '@aia/database';
import {
  extractClaims,
  scoreNews,
  titleSimilarity,
  type NewsProvider,
  type NewsSourceConfig,
  type NewsSourceType,
} from '@aia/news';
import { collectNewsSpec, type CollectNewsInput, type JobDefinition } from '@aia/queue';
import { NotFoundError, TransientError, type Clock } from '@aia/shared';

export interface CollectNewsHandlerDeps {
  news: NewsStore;
  provider(type: NewsSourceType): NewsProvider | undefined;
  projectContext(projectId: string): {
    name: string;
    terms: string[];
    audienceTerms: string[];
  } | null;
  clock: Clock;
}

function providerSource(
  source: NonNullable<ReturnType<NewsStore['sourceById']>>,
): NewsSourceConfig {
  if (!source.url) throw new Error(`La source « ${source.name} » n'a pas d'URL.`);
  return {
    id: source.id,
    name: source.name,
    type: source.kind === 'api' ? 'web' : (source.kind as NewsSourceType),
    url: source.url,
    categories: source.categories,
    trustLevel: source.authority,
    language: source.language,
  };
}

export function createCollectNewsHandler(
  deps: CollectNewsHandlerDeps,
): JobDefinition<
  CollectNewsInput,
  { sources: number; discovered: number; inserted: number; duplicates: number; failures: number }
> {
  return {
    ...collectNewsSpec,
    handler: async (input, ctx) => {
      const sources = input.sourceId
        ? [deps.news.sourceById(input.sourceId)].filter(
            (source): source is NonNullable<typeof source> => source !== null,
          )
        : deps.news.listDueSources(deps.clock.nowMs());
      if (input.sourceId && sources.length === 0) {
        throw new NotFoundError('Source de veille introuvable.', { code: 'NEWS_SOURCE_NOT_FOUND' });
      }

      let discovered = 0;
      let inserted = 0;
      let duplicates = 0;
      let failures = 0;
      for (const source of sources) {
        if (!source.enabled) continue;
        const configured = providerSource(source);
        const provider = deps.provider(configured.type);
        if (!provider) {
          deps.news.recordSourceFailure(source.id, `Provider ${configured.type} non configuré.`);
          failures += 1;
          continue;
        }
        try {
          await ctx.emitEvent({ step: 'fetch', message: `Lecture de ${source.name}.` });
          const payload = await provider.fetchLatest(configured, ctx.signal);
          const items = provider.normalize(payload, configured);
          discovered += items.length;
          const project = deps.projectContext(source.projectId);
          if (!project) throw new Error(`Projet ${source.projectId} introuvable.`);
          const recent = deps.news.recentForSimilarity(
            source.projectId,
            deps.clock.nowMs() - 30 * 24 * 60 * 60_000,
          );
          for (const item of items) {
            const excluded = source.excludeKeywords.some((keyword) =>
              `${item.title} ${item.summary ?? ''}`.toLowerCase().includes(keyword.toLowerCase()),
            );
            if (excluded) continue;
            const strict = deps.news.findDuplicate({
              projectId: source.projectId,
              sourceId: source.id,
              externalId: item.externalId,
              canonicalUrl: item.canonicalUrl,
              contentHash: item.contentHash,
            });
            const similar = recent.find(
              (candidate) => titleSimilarity(candidate.title, item.title) >= 0.85,
            );
            if (strict || similar) {
              duplicates += 1;
              continue;
            }
            const score = scoreNews(item, {
              nowMs: deps.clock.nowMs(),
              sourceTrustLevel: source.authority,
              sourceCategories: [...source.categories, ...source.keywords],
              projectName: project.name,
              projectTerms: project.terms,
              audienceTerms: project.audienceTerms,
            });
            const result = deps.news.insertItem({
              projectId: source.projectId,
              sourceId: source.id,
              externalId: item.externalId,
              title: item.title,
              summary: item.summary,
              url: item.url,
              canonicalUrl: item.canonicalUrl,
              author: item.author,
              contentHash: item.contentHash,
              publishedAt: item.publishedAt,
              language: item.language,
              rawJson: JSON.stringify(item),
              categories: item.categories,
              score,
              urgency: score.urgency,
              verificationStatus: 'source_confirmed',
              claims: extractClaims(item),
              expiresAt:
                item.publishedAt === null
                  ? deps.clock.nowMs() + 7 * 24 * 60 * 60_000
                  : item.publishedAt + 14 * 24 * 60 * 60_000,
            });
            if (result.created) {
              inserted += 1;
              recent.push(result.item);
            } else duplicates += 1;
          }
          deps.news.recordSourceSuccess(source.id);
        } catch (error) {
          failures += 1;
          const message = error instanceof Error ? error.message : String(error);
          deps.news.recordSourceFailure(source.id, message);
          await ctx.emitEvent({ step: 'source_error', level: 'warn', message });
          if (input.sourceId) {
            throw new TransientError(message, { code: 'NEWS_COLLECTION_FAILED' });
          }
        }
      }
      deps.news.expireBefore(deps.clock.nowMs());
      await ctx.emitEvent({
        step: 'done',
        progress: 100,
        message: `${inserted} actualité(s) ajoutée(s), ${duplicates} doublon(s), ${failures} source(s) en erreur.`,
      });
      return { sources: sources.length, discovered, inserted, duplicates, failures };
    },
  };
}
