import { afterEach, describe, expect, it } from 'vitest';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createTestContext, TEST_NOW, type TestContext } from '../support/harness';

/**
 * API de la mémoire des projets : la **vraie** instance Fastify, sur une base
 * SQLite réelle, via `inject()`. Ces tests protègent ce qu'aucun test unitaire
 * ne peut protéger : le contrat HTTP (statuts, corps, erreurs typées) et le
 * chemin complet route → domaine → base.
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function makeApi() {
  context = createTestContext();
  const api = buildApi({
    config: context.config,
    logger: context.logger,
    clock: context.clock,
  });
  return { api, app: buildServer(api), context: context as TestContext };
}

interface CreatedProject {
  project: { id: string; slug: string; status: string; name: string; archivedAt: number | null };
}

async function createProject(
  app: ReturnType<typeof makeApi>['app'],
  body: Record<string, unknown> = { name: 'Mémoire du projet' },
): Promise<CreatedProject> {
  const response = await app.inject({ method: 'POST', url: '/projects', payload: body });
  expect(response.statusCode).toBe(201);
  return response.json() as CreatedProject;
}

describe('API des projets (docs/10 §4.2)', () => {
  it('annonce l’étape et ses points d’entrée', async () => {
    const { app } = makeApi();
    const body = (await app.inject({ method: 'GET', url: '/' })).json();
    expect(body.step).toContain('étape 4');
    expect(body.endpoints).toContain('POST /projects');
    expect(body.endpoints).toContain('GET /projects/:id/context');
  });

  it('crée un projet, le relit et le liste', async () => {
    const { app } = makeApi();
    const { project } = await createProject(app, {
      name: 'Automatisation IA',
      targetGoal: '500 abonnés LinkedIn',
      description: 'Un outil personnel de mémoire et de contenu',
    });

    expect(project.status).toBe('discovery');
    expect(project.slug).toBe('automatisation-ia');

    const detail = await app.inject({ method: 'GET', url: `/projects/${project.id}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.project.name).toBe('Automatisation IA');
    expect(body.summary.total).toBe(1);
    // La description initiale est un fait, et le trou est nommé.
    expect(body.context.facts).toHaveLength(0);
    expect(body.context.missingCategories).toContain('stack');

    const list = await app.inject({ method: 'GET', url: '/projects' });
    expect(list.json().projects).toHaveLength(1);
  });

  it('refuse un projet sans nom (400 typé)', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'POST', url: '/projects', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.category).toBe('validation');
    expect(response.json().error.code).toBe('PROJECT_INPUT_INVALID');
  });

  it('répond 404 sans trace de pile pour un projet inconnu', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'GET', url: '/projects/inconnu' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('PROJECT_NOT_FOUND');
    expect(JSON.stringify(response.json())).not.toContain('at ');
  });

  it('modifie un projet et applique le cycle de vie', async () => {
    const { app } = makeApi();
    const { project } = await createProject(app);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/projects/${project.id}`,
      payload: { name: 'Mémoire du projet (v2)', status: 'active' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().project.name).toBe('Mémoire du projet (v2)');
    expect(renamed.json().project.status).toBe('active');
    expect(renamed.json().project.slug).toBe(project.slug); // le slug ne bouge pas

    const forbidden = await app.inject({
      method: 'PATCH',
      url: `/projects/${project.id}`,
      payload: { status: 'discovery' },
    });
    expect(forbidden.statusCode).toBe(409);
    expect(forbidden.json().error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('archive un projet : lecture seule, jamais supprimé', async () => {
    const { app, context } = makeApi();
    const { project } = await createProject(app);
    context.clock.set(TEST_NOW + 86_400_000);

    const archived = await app.inject({ method: 'POST', url: `/projects/${project.id}/archive` });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().project.status).toBe('archived');
    expect(archived.json().project.archivedAt).toBe(TEST_NOW + 86_400_000);

    const edit = await app.inject({
      method: 'PATCH',
      url: `/projects/${project.id}`,
      payload: { name: 'après archivage' },
    });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error.code).toBe('PROJECT_ARCHIVED');

    // Toujours lisible, et absent du listage par défaut.
    expect((await app.inject({ method: 'GET', url: `/projects/${project.id}` })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'GET', url: '/projects' })).json().projects).toHaveLength(0);
    expect(
      (await app.inject({ method: 'GET', url: '/projects?includeArchived=true' })).json().projects,
    ).toHaveLength(1);
  });
});

describe('API des faits', () => {
  it('ajoute un fait non confirmé, puis le confirme', async () => {
    const { app, context } = makeApi();
    const { project } = await createProject(app);

    const created = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts`,
      payload: { category: 'stack', statement: 'Node 20, TypeScript, SQLite', importance: 4 },
    });
    expect(created.statusCode).toBe(201);
    const fact = created.json().fact;
    expect(fact.verificationStatus).toBe('user_provided');
    expect(fact.verifiedByUser).toBe(false);
    expect(fact.verifiedAt).toBeNull();

    context.clock.set(TEST_NOW + 3_600_000);
    const verified = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts/${fact.id}/verification`,
      payload: { status: 'verified' },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().fact.verificationStatus).toBe('verified');
    expect(verified.json().fact.verifiedAt).toBe(TEST_NOW + 3_600_000);
    expect(verified.json().fact.verifiedByUser).toBe(true);
  });

  it('refuse un fait d’origine IA annoncé comme confirmé', async () => {
    const { app } = makeApi();
    const { project } = await createProject(app);

    const response = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts`,
      payload: {
        category: 'motivation',
        statement: 'motivation déduite',
        source: 'ai_proposal',
        verificationStatus: 'verified',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('AI_PROPOSAL_REQUIRES_HUMAN_VALIDATION');

    const proposed = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts`,
      payload: { category: 'motivation', statement: 'motivation déduite', source: 'ai_proposal' },
    });
    expect(proposed.json().fact.verificationStatus).toBe('proposed');
  });

  it('refuse une valeur d’énumération inconnue et une entrée hostile', async () => {
    const { app } = makeApi();
    const { project } = await createProject(app);

    const badCategory = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts`,
      payload: { category: 'sujet_secret', statement: 'x' },
    });
    expect(badCategory.statusCode).toBe(400);

    const badQuery = await app.inject({
      method: 'GET',
      url: `/projects/${project.id}/facts?status=inexistant`,
    });
    expect(badQuery.statusCode).toBe(400);
    expect(badQuery.json().error.code).toBe('FACT_QUERY_INVALID');

    const htmlStatement = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts`,
      payload: { category: 'note', statement: '<script>alert(1)</script>' },
    });
    // Le texte est stocké tel quel : l'échappement appartient à l'affichage,
    // `dangerouslySetInnerHTML` étant interdit dans tout le dépôt (docs/07 §3.3).
    expect(htmlStatement.json().fact.statement).toBe('<script>alert(1)</script>');
  });

  it('répond 404 pour un fait inconnu ou appartenant à un autre projet', async () => {
    const { app } = makeApi();
    const { project } = await createProject(app, { name: 'Premier' });
    const { project: autre } = await createProject(app, { name: 'Second' });
    const fact = (
      await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/facts`,
        payload: { category: 'note', statement: 'note du premier' },
      })
    ).json().fact;

    expect(
      (await app.inject({ method: 'GET', url: `/projects/${project.id}/facts/fact-inexistant` }))
        .statusCode,
    ).toBe(404);
    const crossProject = await app.inject({
      method: 'GET',
      url: `/projects/${autre.id}/facts/${fact.id}`,
    });
    expect(crossProject.statusCode).toBe(404);
    expect(crossProject.json().error.code).toBe('FACT_NOT_FOUND');
  });
});

describe('historique, contexte et absence de suppression', () => {
  it('remplace un fait en gardant l’ancien lisible', async () => {
    const { app } = makeApi();
    const { project } = await createProject(app);
    const ancien = (
      await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/facts`,
        payload: { category: 'etat_actuel', statement: 'version 1 en ligne' },
      })
    ).json().fact;
    await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts/${ancien.id}/verification`,
      payload: { status: 'verified' },
    });

    const replaced = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts/${ancien.id}/replacement`,
      payload: {
        category: 'etat_actuel',
        statement: 'version 2 en ligne',
        note: 'la version 1 est retirée',
      },
    });
    expect(replaced.statusCode).toBe(201);
    const body = replaced.json();
    expect(body.superseded.verificationStatus).toBe('superseded');
    expect(body.superseded.supersededByFactId).toBe(body.replacement.id);
    expect(body.replacement.supersedesFactId).toBe(ancien.id);

    const active = (
      await app.inject({ method: 'GET', url: `/projects/${project.id}/facts` })
    ).json();
    expect(active.facts.map((fact: { id: string }) => fact.id)).toEqual([body.replacement.id]);

    const all = (
      await app.inject({ method: 'GET', url: `/projects/${project.id}/facts?includeInactive=true` })
    ).json();
    expect(all.facts).toHaveLength(2);
    expect(all.summary.byStatus.superseded).toBe(1);

    // Remplacer un fait déjà remplacé est un conflit, pas un doublon silencieux.
    const again = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/facts/${ancien.id}/replacement`,
      payload: { category: 'etat_actuel', statement: 'version 3' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('expose un contexte déterministe filtré par catégorie, état et date', async () => {
    const { app, context } = makeApi();
    const { project } = await createProject(app);

    for (const [category, statement] of [
      ['stack', 'Node, TypeScript'],
      ['architecture', 'API + SQLite'],
      ['decision', 'Drizzle plutôt que Prisma'],
    ] as const) {
      const fact = (
        await app.inject({
          method: 'POST',
          url: `/projects/${project.id}/facts`,
          payload: { category, statement },
        })
      ).json().fact;
      if (category !== 'stack') {
        await app.inject({
          method: 'POST',
          url: `/projects/${project.id}/facts/${fact.id}/verification`,
          payload: { status: 'verified' },
        });
      }
    }

    const strict = (
      await app.inject({ method: 'GET', url: `/projects/${project.id}/context` })
    ).json();
    expect(strict.facts).toHaveLength(2);
    expect(strict.excluded.unverified).toBe(1);
    expect(strict.missingCategories).toContain('motivation');

    const brouillon = (
      await app.inject({
        method: 'GET',
        url: `/projects/${project.id}/context?includeUnverified=true`,
      })
    ).json();
    expect(brouillon.facts).toHaveLength(3);

    const parCategorie = (
      await app.inject({
        method: 'GET',
        url: `/projects/${project.id}/context?category=decision&includeUnverified=true`,
      })
    ).json();
    expect(
      parCategorie.facts.map((entry: { fact: { category: string } }) => entry.fact.category),
    ).toEqual(['decision']);

    context.clock.set(TEST_NOW + 86_400_000);
    const apres = (
      await app.inject({
        method: 'GET',
        url: `/projects/${project.id}/context?since=${TEST_NOW + 1}`,
      })
    ).json();
    expect(apres.facts).toHaveLength(0);
    // Chaque fait est compté **une fois**, dans l'ordre des filtres : les deux
    // faits confirmés sont écartés par la date, le fait non confirmé l'est par
    // son état (docs/03 §6.6 : les faits non confirmés n'entrent pas).
    expect(apres.excluded.filtered).toBe(2);
    expect(apres.excluded.unverified).toBe(1);
  });

  it('n’expose aucune route de suppression (la mémoire est conservée)', async () => {
    const { app } = makeApi();
    const { project } = await createProject(app);
    const fact = (
      await app.inject({
        method: 'POST',
        url: `/projects/${project.id}/facts`,
        payload: { category: 'note', statement: 'à conserver' },
      })
    ).json().fact;

    for (const request of [
      { method: 'DELETE' as const, url: `/projects/${project.id}` },
      { method: 'DELETE' as const, url: `/projects/${project.id}/facts/${fact.id}` },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json().error.category).toBe('not_found');
    }

    expect(
      (await app.inject({ method: 'GET', url: `/projects/${project.id}/facts` })).json().facts,
    ).toHaveLength(1);
  });

  it('sert le vocabulaire attendu par l’interface (une seule source de vérité)', async () => {
    const { app } = makeApi();
    const vocab = (await app.inject({ method: 'GET', url: '/projects/vocabulary' })).json();

    expect(vocab.knowledgeCategories).toHaveLength(16);
    expect(vocab.factVerificationStatuses.map((entry: { value: string }) => entry.value)).toEqual([
      'proposed',
      'user_provided',
      'verified',
      'uncertain',
      'obsolete',
      'superseded',
    ]);
    expect(
      vocab.projectStatuses.find((e: { value: string }) => e.value === 'archived').next,
    ).toEqual([]);
    expect(vocab.limits.factStatementMaxLength).toBeGreaterThan(0);
  });
});
