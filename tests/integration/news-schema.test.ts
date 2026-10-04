import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNewsStore, listTables } from '@aia/database';
import { createProject } from '@aia/core';
import { createMemoryStack } from '../support/project-memory';
import { createTestContext, type TestContext } from '../support/harness';

/** Le schéma amorcé à l'étape 7, désormais complété par le pipeline de l'étape 10. */

let context: TestContext;
let projectId: string;

beforeEach(() => {
  context = createTestContext();
  projectId = createProject(createMemoryStack(context), { name: 'Veille de test' }).id;
});

afterEach(() => {
  context.cleanup();
});

function news() {
  return createNewsStore(context.handle, () => context.clock.nowMs());
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error('l’appel aurait dû échouer');
}

describe('tables de la veille : modèle et configuration', () => {
  it('crée les deux tables attendues, et rien de plus', () => {
    const tables = listTables(context.handle);
    expect(tables).toContain('news_sources');
    expect(tables).toContain('news_items');
  });

  it('une source déclarée : URL unique par projet, type et autorité contraints', () => {
    const store = news();
    const source = store.createSource({
      projectId,
      name: 'Veille IA',
      kind: 'rss',
      url: 'https://exemple.test/flux.xml',
      keywords: ['automatisation'],
    });
    expect(source).toMatchObject({ kind: 'rss', enabled: true, authority: 3 });
    // Le défaut vit dans le schéma : une source désactivée par cinq échecs
    // consécutifs ne se remet pas toute seule (docs/03 §13.1).
    expect(source.consecutiveFailures).toBe(0);

    // La même URL pour le même projet est refusée par l'index unique.
    expect(
      codeOf(() =>
        store.createSource({
          projectId,
          name: 'Doublon',
          kind: 'rss',
          url: 'https://exemple.test/flux.xml',
        }),
      ),
    ).toBeDefined();

    // Le type public `web` complète les formats historiques conservés en base.
    expect(
      codeOf(() => handleInsertBadSource(store, { kind: 'scraping' as unknown as 'rss' })),
    ).toBeDefined();
    // `authority` est bornée à 1–5, `refresh_hours` strictement positif.
    expect(codeOf(() => handleInsertBadSource(store, { authority: 9 }))).toBeDefined();
    expect(codeOf(() => handleInsertBadSource(store, { refreshHours: 0 }))).toBeDefined();
  });

  it('une actualité porte l’empreinte de son contenu et ne se duplique pas', () => {
    const store = news();
    const source = store.createSource({
      projectId,
      name: 'Veille IA',
      kind: 'rss',
      url: 'https://exemple.test/flux.xml',
    });

    const first = store.insertItem({
      projectId,
      sourceId: source.id,
      title: 'Une actualité',
      url: 'https://exemple.test/article',
      contentHash: 'a'.repeat(64),
      topicTags: ['automatisation'],
    });
    expect(first.created).toBe(true);
    expect(first.item).toMatchObject({ status: 'new', verified: true, llmEnriched: false });
    expect(first.item.topicTags).toEqual(['automatisation']);

    // Un flux relu ne crée pas de doublon : c'est le cas normal, pas une erreur.
    const again = store.insertItem({
      projectId,
      sourceId: source.id,
      title: 'Une actualité (relue)',
      url: 'https://exemple.test/article',
      contentHash: 'a'.repeat(64),
    });
    expect(again.created).toBe(false);
    expect(again.item.id).toBe(first.item.id);
    expect(store.listItems(projectId)).toHaveLength(1);
  });

  it('expire une actualité arrivée à sa limite sans supprimer sa provenance', () => {
    const store = news();
    const source = store.createSource({
      projectId,
      name: 'Flux avec rétention',
      kind: 'rss',
      url: 'https://exemple.test/retention.xml',
    });
    const inserted = store.insertItem({
      projectId,
      sourceId: source.id,
      title: 'Actualité arrivée à expiration',
      url: 'https://exemple.test/expiree',
      contentHash: 'b'.repeat(64),
      expiresAt: context.clock.nowMs() - 1,
    });
    expect(store.expireBefore(context.clock.nowMs())).toBe(1);
    expect(store.itemById(inserted.item.id)).toMatchObject({
      status: 'expired',
      sourceId: source.id,
    });
  });

  it('modifie catégories, fréquence et confiance, puis respecte l’échéance', () => {
    const store = news();
    const source = store.createSource({
      projectId,
      name: 'Flux configurable',
      kind: 'web',
      url: 'https://exemple.test/news.json',
      categories: ['dev'],
      refreshHours: 12,
    });
    const updated = store.updateSource(source.id, {
      categories: ['ia', 'outils'],
      authority: 5,
      refreshHours: 6,
      language: 'fr',
    });
    expect(updated).toMatchObject({
      categories: ['ia', 'outils'],
      authority: 5,
      refreshHours: 6,
      language: 'fr',
    });
    store.recordSourceSuccess(source.id);
    expect(store.listDueSources()).toHaveLength(0);
    context.clock.advance(6 * 60 * 60_000);
    expect(store.listDueSources()).toHaveLength(1);

    expect(store.claimCollectionCycle('2026-03-10T18:00:00.000Z')).toBe(true);
    expect(store.claimCollectionCycle('2026-03-10T18:00:00.000Z')).toBe(false);
    expect(store.claimCollectionCycle('2026-03-10T19:00:00.000Z')).toBe(true);
  });
});

/** Un helper pour tester les `CHECK` : la valeur fautive passe par le schéma SQL. */
function handleInsertBadSource(
  store: ReturnType<typeof createNewsStore>,
  overrides: {
    kind?: 'rss' | 'atom' | 'web' | 'api' | 'manual';
    authority?: number;
    refreshHours?: number;
  },
): void {
  store.createSource({
    projectId,
    name: 'Source contrainte',
    kind: overrides.kind ?? 'rss',
    url: `https://exemple.test/${String(overrides.authority ?? 0)}-${String(
      overrides.refreshHours ?? 12,
    )}.xml`,
    ...(overrides.authority === undefined ? {} : { authority: overrides.authority }),
    ...(overrides.refreshHours === undefined ? {} : { refreshHours: overrides.refreshHours }),
  });
}
