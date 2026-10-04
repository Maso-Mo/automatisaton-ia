import { XMLParser } from 'fast-xml-parser';
import { normalizeRawNewsItem } from './normalize';
import type { NewsProvider, NormalizedNewsItem, ProviderHealth, RawNewsItem } from './types';

export type NewsFetch = (url: string, init?: RequestInit) => Promise<Response>;

function array<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return text(record['#text'] ?? record.href ?? record._);
  }
  return null;
}

function epoch(value: unknown): number | null {
  const parsed = text(value);
  if (!parsed) return null;
  const timestamp = Date.parse(parsed);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function rssItems(document: Record<string, unknown>): RawNewsItem[] {
  const rss = document.rss as Record<string, unknown> | undefined;
  const channel = rss?.channel as Record<string, unknown> | undefined;
  return array(channel?.item as Record<string, unknown> | Record<string, unknown>[]).map(
    (item) => ({
      externalId: text(item.guid),
      url: text(item.link) ?? '',
      title: text(item.title) ?? '',
      summary: text(item.description ?? item['content:encoded']),
      publishedAt: epoch(item.pubDate ?? item.date),
      author: text(item.author ?? item['dc:creator']),
      categories: array(item.category)
        .map(text)
        .filter((value): value is string => Boolean(value)),
    }),
  );
}

function atomItems(document: Record<string, unknown>): RawNewsItem[] {
  const feed = document.feed as Record<string, unknown> | undefined;
  return array(feed?.entry as Record<string, unknown> | Record<string, unknown>[]).map((item) => {
    const links = array(item.link as Record<string, unknown> | Record<string, unknown>[]);
    const link = links.find((candidate) => candidate.rel === 'alternate') ?? links[0] ?? item.link;
    return {
      externalId: text(item.id),
      url: text(link) ?? '',
      title: text(item.title) ?? '',
      summary: text(item.summary ?? item.content),
      publishedAt: epoch(item.published ?? item.updated),
      author: text((item.author as Record<string, unknown> | undefined)?.name),
      categories: array(item.category as Record<string, unknown> | Record<string, unknown>[])
        .map((category) => text(category.term ?? category))
        .filter((value): value is string => Boolean(value)),
    };
  });
}

function timeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Délai de collecte dépassé.')),
    timeoutMs,
  );
  timeout.unref?.();
  const abortFromParent = () => controller.abort(parent?.reason);
  parent?.addEventListener('abort', abortFromParent, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

export function createFeedProvider(options: {
  type: 'rss' | 'atom';
  fetch?: NewsFetch;
  timeoutMs?: number;
  nowMs?: () => number;
}): NewsProvider<string> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const nowMs = options.nowMs ?? Date.now;
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  return {
    type: options.type,
    async fetchLatest(source, signal) {
      const timeout = timeoutSignal(timeoutMs, signal);
      try {
        const response = await fetcher(source.url, {
          headers: {
            Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
          },
          signal: timeout.signal,
        });
        if (!response.ok)
          throw new Error(`Source ${source.name} indisponible (HTTP ${response.status}).`);
        return await response.text();
      } finally {
        timeout.dispose();
      }
    },
    normalize(payload, source) {
      let parsed: Record<string, unknown>;
      try {
        parsed = parser.parse(payload) as Record<string, unknown>;
      } catch (error) {
        throw new Error(
          `Flux XML invalide : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const raw = options.type === 'atom' ? atomItems(parsed) : rssItems(parsed);
      const normalized: NormalizedNewsItem[] = [];
      for (const item of raw) {
        if (!item.url || !item.title) continue;
        normalized.push(normalizeRawNewsItem(item, source));
      }
      if (normalized.length === 0)
        throw new Error('Le flux ne contient aucune entrée RSS/Atom valide.');
      return normalized;
    },
    async healthCheck(source): Promise<ProviderHealth> {
      try {
        const payload = await this.fetchLatest(source);
        const count = this.normalize(payload, source).length;
        return { ok: true, detail: `${count} entrée(s) lisible(s).`, checkedAt: nowMs() };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: nowMs(),
        };
      }
    },
  };
}

/** Provider WEB volontairement étroit : endpoint public JSON, jamais scraping HTML. */
export function createPublicJsonProvider(
  options: { fetch?: NewsFetch; timeoutMs?: number; nowMs?: () => number } = {},
): NewsProvider<unknown> {
  const fetcher = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const nowMs = options.nowMs ?? Date.now;
  return {
    type: 'web',
    async fetchLatest(source, signal) {
      const timeout = timeoutSignal(timeoutMs, signal);
      try {
        const response = await fetcher(source.url, {
          headers: { Accept: 'application/json' },
          signal: timeout.signal,
        });
        if (!response.ok)
          throw new Error(`Source ${source.name} indisponible (HTTP ${response.status}).`);
        return await response.json();
      } finally {
        timeout.dispose();
      }
    },
    normalize(payload, source) {
      const values = Array.isArray(payload)
        ? payload
        : payload &&
            typeof payload === 'object' &&
            Array.isArray((payload as { items?: unknown }).items)
          ? (payload as { items: unknown[] }).items
          : [];
      if (values.length === 0) throw new Error('La réponse JSON ne contient aucun tableau items.');
      return values.map((value) => {
        const item = value as Record<string, unknown>;
        return normalizeRawNewsItem(
          {
            externalId: text(item.id ?? item.externalId),
            url: text(item.url) ?? '',
            title: text(item.title) ?? '',
            summary: text(item.summary ?? item.description),
            publishedAt: epoch(item.publishedAt ?? item.date),
            author: text(item.author),
            categories: array(item.categories)
              .map(text)
              .filter((entry): entry is string => Boolean(entry)),
            language: text(item.language),
          },
          source,
        );
      });
    },
    async healthCheck(source) {
      try {
        const payload = await this.fetchLatest(source);
        const count = this.normalize(payload, source).length;
        return { ok: true, detail: `${count} entrée(s) lisible(s).`, checkedAt: nowMs() };
      } catch (error) {
        return {
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
          checkedAt: nowMs(),
        };
      }
    },
  };
}
