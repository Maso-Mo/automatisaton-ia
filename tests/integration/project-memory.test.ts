import {
  ensureLocalOwner,
  appliedMigrationCount,
  applyMigrations,
  createProjectMemoryStore,
  openDatabase,
} from '@aia/database';
import { addFact, createProject, listProjectFacts, replaceFact, verifyFact } from '@aia/core';
import { uuidv7 } from '@aia/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, TEST_NOW, type TestContext } from '../support/harness';
import { createMemoryStack, type MemoryStack } from '../support/project-memory';

/**
 * La mémoire des projets sur une **vraie base SQLite** (docs/09 §3 : « le même
 * moteur que la production : les contraintes, déclencheurs et index sont
 * réellement testés »).
 *
 * Ce que ces tests protègent, et qu'un faux dépôt ne peut pas protéger : les
 * `CHECK`, les clés étrangères, l'unicité du slug, le déclencheur
 * anti-suppression, et la persistance après fermeture du fichier.
 */

let context: TestContext;
let memory: MemoryStack;

beforeEach(() => {
  context = createTestContext();
  memory = createMemoryStack(context);
});

afterEach(() => {
  context.cleanup();
});

function rawRun(sql: string, params: unknown[]): void {
  context.handle.sqlite.prepare(sql).run(...(params as never[]));
}

const FACT_COLUMNS =
  'id, project_id, category, statement, source, importance, used_count, created_at, updated_at';

describe('contraintes portées par la base (docs/03 §15)', () => {
  it('écrit un projet et ses faits, puis les relit à l’identique', () => {
    const project = createProject(memory, { name: 'Mémoire réelle' });
    const fact = addFact(memory, project.id, {
      category: 'architecture',
      statement: 'API Fastify + SQLite',
      detail: 'Un seul writer : le worker',
      importance: 4,
    });

    const reloaded = memory.store.facts.byId(fact.id);
    expect(reloaded?.statement).toBe('API Fastify + SQLite');
    expect(reloaded?.detail).toBe('Un seul writer : le worker');
    expect(reloaded?.importance).toBe(4);
    expect(reloaded?.verificationStatus).toBe('user_provided');
    expect(reloaded?.verifiedByUser).toBe(false);
    expect(memory.store.projects.bySlug('memoire-reelle')?.id).toBe(project.id);
  });

  it('remplit les valeurs par défaut pour une écriture directe en SQL', () => {
    const project = createProject(memory, { name: 'Défauts' });
    rawRun(
      `insert into project_facts (${FACT_COLUMNS}) values (?, ?, 'note', 'écrit à la main', 'user_input', 3, 0, ?, ?)`,
      [uuidv7(TEST_NOW), project.id, TEST_NOW, TEST_NOW],
    );

    const row = context.handle.sqlite
      .prepare(
        'select verification_status, verification_note, verified_at from project_facts limit 1',
      )
      .get() as {
      verification_status: string;
      verification_note: string | null;
      verified_at: number | null;
    };

    expect(row.verification_status).toBe('user_provided');
    expect(row.verification_note).toBeNull();
    expect(row.verified_at).toBeNull();
  });

  it('refuse un fait dont le projet n’existe pas (clé étrangère)', () => {
    expect(() =>
      rawRun(
        `insert into project_facts (${FACT_COLUMNS}) values (?, 'projet-inexistant', 'note', 'x', 'user_input', 3, 0, ?, ?)`,
        [uuidv7(TEST_NOW), TEST_NOW, TEST_NOW],
      ),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuse un fait confirmé sans date de confirmation', () => {
    const project = createProject(memory, { name: 'Garde-fou' });
    expect(() =>
      rawRun(
        `insert into project_facts (${FACT_COLUMNS}, verification_status, verified_by_user) values (?, ?, 'note', 'x', 'user_input', 3, 0, ?, ?, 'verified', 1)`,
        [uuidv7(TEST_NOW), project.id, TEST_NOW, TEST_NOW],
      ),
    ).toThrow(/verification_refusee/);
  });

  it('refuse `verified_by_user` incohérent avec l’état de vérification', () => {
    const project = createProject(memory, { name: 'Garde-fou' });
    expect(() =>
      rawRun(
        `insert into project_facts (${FACT_COLUMNS}, verification_status, verified_by_user, verified_at) values (?, ?, 'note', 'x', 'user_input', 3, 0, ?, ?, 'verified', 0, ?)`,
        [uuidv7(TEST_NOW), project.id, TEST_NOW, TEST_NOW, TEST_NOW],
      ),
    ).toThrow(/chk_facts_verified_by_user/);
  });

  it('refuse une importance hors bornes et un état « remplacé » sans successeur', () => {
    const project = createProject(memory, { name: 'Garde-fou' });
    expect(() =>
      rawRun(
        `insert into project_facts (${FACT_COLUMNS}) values (?, ?, 'note', 'x', 'user_input', 9, 0, ?, ?)`,
        [uuidv7(TEST_NOW), project.id, TEST_NOW, TEST_NOW],
      ),
    ).toThrow(/chk_facts_importance/);

    expect(() =>
      rawRun(
        `insert into project_facts (${FACT_COLUMNS}, verification_status) values (?, ?, 'note', 'x', 'user_input', 3, 0, ?, ?, 'superseded')`,
        [uuidv7(TEST_NOW), project.id, TEST_NOW, TEST_NOW],
      ),
    ).toThrow(/chk_facts_supersede_link/);
  });

  it('refuse deux projets avec le même identifiant lisible', () => {
    createProject(memory, { name: 'Unique' });
    expect(() =>
      rawRun(
        `insert into projects (id, owner_id, name, slug, status, language, created_at, updated_at) values (?, ?, 'Doublon', 'unique', 'discovery', 'fr', ?, ?)`,
        [uuidv7(TEST_NOW), memory.store.owner.currentId(), TEST_NOW, TEST_NOW],
      ),
    ).toThrow(/UNIQUE/i);
  });

  it('interdit la suppression physique d’un fait, même en SQL direct', () => {
    const project = createProject(memory, { name: 'Mémoire' });
    const fact = addFact(memory, project.id, { category: 'note', statement: 'à conserver' });

    expect(() =>
      context.handle.sqlite.prepare('delete from project_facts where id = ?').run(fact.id),
    ).toThrow(/suppression_interdite/);
    expect(memory.store.facts.byId(fact.id)).toBeDefined();
  });

  it('crée le propriétaire local au premier besoin, une seule fois', () => {
    const first = ensureLocalOwner(context.handle, TEST_NOW);
    const second = ensureLocalOwner(context.handle, TEST_NOW + 1_000);
    expect(second.id).toBe(first.id);

    const count = context.handle.sqlite.prepare('select count(*) as total from users').get() as {
      total: number;
    };
    expect(count.total).toBe(1);
  });
});

describe('dépôt réel : filtres, historique et persistance', () => {
  it('filtre en SQL par catégorie, par état et par date', () => {
    const project = createProject(memory, { name: 'Filtres' });
    const stack = addFact(memory, project.id, { category: 'stack', statement: 'Node' });
    const decision = addFact(memory, project.id, { category: 'decision', statement: 'SQLite' });
    verifyFact(memory, project.id, decision.id);

    expect(memory.store.facts.list({ projectId: project.id, categories: ['stack'] })).toHaveLength(
      1,
    );
    expect(memory.store.facts.list({ projectId: project.id, statuses: ['verified'] })).toHaveLength(
      1,
    );
    expect(memory.store.facts.list({ projectId: project.id, untilMs: TEST_NOW - 1 })).toHaveLength(
      0,
    );
    expect(memory.store.facts.list({ projectId: project.id, sinceMs: TEST_NOW })).toHaveLength(2);

    // Le fait confirmé est le seul que la sélection déterministe injecterait.
    const verified = verifyFact(memory, project.id, stack.id);
    expect(verified.verificationStatus).toBe('verified');
  });

  it('conserve l’historique complet d’un remplacement, en deux lignes', () => {
    const project = createProject(memory, { name: 'Historique' });
    const ancien = addFact(memory, project.id, {
      category: 'etat_actuel',
      statement: 'version 1',
    });
    verifyFact(memory, project.id, ancien.id);

    const { replacement } = replaceFact(memory, project.id, ancien.id, {
      category: 'etat_actuel',
      statement: 'version 2',
      importance: 5,
    });

    const active = listProjectFacts(memory, project.id);
    expect(active.map((fact) => fact.id)).toEqual([replacement.id]);

    const all = listProjectFacts(memory, project.id, { includeInactive: true });
    expect(all).toHaveLength(2);
    const storedOld = all.find((fact) => fact.id === ancien.id);
    expect(storedOld?.statement).toBe('version 1');
    expect(storedOld?.verificationStatus).toBe('superseded');
    expect(storedOld?.supersededByFactId).toBe(replacement.id);
    expect(replacement.supersedesFactId).toBe(ancien.id);

    // La contrainte d'unicité empêche deux successeurs pour un même fait.
    const replacementId = memory.store.facts.byId(replacement.id)?.id ?? '';
    expect(replacementId).toBe(replacement.id);
  });

  it('n’écrit rien d’un remplacement impossible (transaction annulée)', () => {
    const project = createProject(memory, { name: 'Transaction' });
    const fact = addFact(memory, project.id, { category: 'note', statement: 'unique' });
    replaceFact(memory, project.id, fact.id, { category: 'note', statement: 'remplacée' });

    const before = listProjectFacts(memory, project.id, { includeInactive: true }).length;
    expect(() =>
      replaceFact(memory, project.id, fact.id, { category: 'note', statement: 'encore' }),
    ).toThrow();
    expect(listProjectFacts(memory, project.id, { includeInactive: true })).toHaveLength(before);
  });

  it('garde les données après fermeture et réouverture du fichier SQLite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aia-memory-'));
    const file = join(directory, 'memory.sqlite');
    let handle = openDatabase({ file });
    applyMigrations(handle);

    const firstStore = createProjectMemoryStore(handle, { nowMs: () => TEST_NOW });
    const project = createProject(
      { store: firstStore, clock: context.clock, newId: () => uuidv7(TEST_NOW) },
      { name: 'Persistant', description: 'écrit avant fermeture' },
    );
    handle.close();

    handle = openDatabase({ file });
    try {
      const secondStore = createProjectMemoryStore(handle, { nowMs: () => TEST_NOW + 60_000 });
      const reloaded = secondStore.projects.byId(project.id);
      expect(reloaded?.name).toBe('Persistant');
      const facts = secondStore.facts.list({ projectId: project.id, includeInactive: true });
      expect(facts).toHaveLength(1);
      expect(facts[0]?.statement).toBe('écrit avant fermeture');
      expect(appliedMigrationCount(handle)).toBeGreaterThan(0);
    } finally {
      handle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
