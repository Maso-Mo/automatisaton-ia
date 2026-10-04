import { createHash } from 'node:crypto';
import type { NewsSourceConfig, NormalizedNewsItem, RawNewsItem } from './types';

const TRACKING_KEYS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'ref',
  'source',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
]);

export function canonicalizeNewsUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL de news non HTTP(S).');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_KEYS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function normalizeNewsText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function newsContentHash(title: string, summary?: string | null): string {
  const stable = `${normalizeNewsText(title)}\n${normalizeNewsText(summary ?? '').slice(0, 500)}`;
  return createHash('sha256').update(stable).digest('hex');
}

export function normalizeRawNewsItem(
  raw: RawNewsItem,
  source: NewsSourceConfig,
): NormalizedNewsItem {
  const title = raw.title.replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('Une actualité sans titre est refusée.');
  const canonicalUrl = canonicalizeNewsUrl(raw.url);
  const categories = [...new Set([...(raw.categories ?? []), ...source.categories])]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return {
    sourceId: source.id,
    externalId: raw.externalId?.trim() || null,
    url: raw.url,
    canonicalUrl,
    title,
    summary:
      raw.summary
        ?.replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || null,
    publishedAt: raw.publishedAt ?? null,
    author: raw.author?.trim() || null,
    categories,
    language: raw.language ?? source.language ?? null,
    contentHash: newsContentHash(title, raw.summary),
  };
}

export function titleSimilarity(left: string, right: string): number {
  const a = new Set(
    normalizeNewsText(left)
      .split(' ')
      .filter((word) => word.length > 2),
  );
  const b = new Set(
    normalizeNewsText(right)
      .split(' ')
      .filter((word) => word.length > 2),
  );
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((word) => b.has(word)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}
