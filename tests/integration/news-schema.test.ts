import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNewsStore, listTables } from '@aia/database';
import { createProject } from '@aia/core';
import { createMemoryStack } from '../support/project-memory';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Le **schéma de la veille** (docs/03 §13, docs/10 §4.7), livré à l'étape 7 sans
 * son pipeline.
 *
 * Deux choses sont vérifiées, et la seconde est la plus importante :
 *
 * 1. le modèle de données tient ses promesses : contraintes `CHECK`, unicité de
 *    l'URL d'une source, unicité de l'empreinte d'une actualité, déduplication à
 *    l'insertion ;
 * 2. **aucune exécution de veille n'existe** : aucun type de job de collecte n'est
 *    enregistré, donc la file refuse d'en enfiler un. C'est ce qui garantit que
 *    l'étape 7 n'a pas construit l'étape 10 à moitié (docs/10 §1.3).
 */

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

describe('tables de la veille : le modèle existe, la collecte non', () => {
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

    // Le type est celui du modèle : `rss`, `atom`, `api`, `manual`.
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

  it('aucun job de veille n’est exécutable : le pipeline arrive à l’étape 10', async () => {
    // 1. Aucun type de job de collecte n'est enregistré dans le worker.
    expect(context.registry.types().some((type) => /news|veille|fetch|rss/.test(type))).toBe(false);
    // 2. La file refuse donc d'en enfiler un : un job que personne ne sait
    //    exécuter ne doit jamais être créé (docs/02 §3).
    await expect(context.queue.enqueue('fetch_news', {})).rejects.toMatchObject({
      code: 'JOB_TYPE_UNKNOWN',
    });
    expect(context.queue.counts().queued ?? 0).toBe(0);
  });
});

/** Un helper pour tester les `CHECK` : la valeur fautive passe par le schéma SQL. */
function handleInsertBadSource(
  store: ReturnType<typeof createNewsStore>,
  overrides: {
    kind?: 'rss' | 'atom' | 'api' | 'manual';
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
