import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import {
  BRIEF_SUMMARY,
  DRAFT_BODY_FRAGMENT,
  INTERVIEWER_REPLY,
  LINKEDIN_DRAFT_HOOK,
  LINKEDIN_TARGET,
  PLAN_FIRST_HOOK,
  PLAN_FIRST_SUBJECT,
  PROJECT,
  REDDIT_DRAFT_HOOK,
  REDDIT_EDIT,
  REDDIT_TARGET,
  REGENERATION_INSTRUCTION,
  REGENERATION_MARKER,
  REJECTION_REASON,
  USER_TURN,
  VIDEO_SOURCE_MIME,
  VIDEO_SOURCE_NAME,
  VIDEO_WINDOW_END,
  VIDEO_WINDOW_START,
} from './support/script';

/**
 * Parcours 1 (docs/09 §11) — **conversation → contenu** : de l'entretien au
 * contenu publié manuellement.
 *
 * Il traverse les cinq écrans dans l'ordre du produit, et chaque étape *consomme*
 * ce que la précédente a produit : sans mémoire acceptée, pas de fiche maître ;
 * sans fiche validée, le plan ne se produit pas ; sans angle retenu, rien à
 * générer ; sans relecture ouverte, l'approbation est refusée. Rien n'est
 * court-circuité par un appel d'API : ce que le parcours prouve, c'est le
 * câblage **des écrans et de la pile** ensemble.
 *
 * Il couvre aussi les trois vérifications « en plus de la fonctionnalité » de
 * docs/09 §11.1 qui concernent ce parcours : la progression en temps réel **se
 * reprend** après une coupure, le coût affiché est celui des appels réellement
 * passés, et le contenu approuvé est relu côté API — pas seulement à l'écran.
 *
 * La pile (API + worker, modèle scripté) est lancée par `support/stack.ts` ;
 * ses textes attendus viennent de `support/script.ts`, la même source que celle
 * qui les met dans la bouche du modèle.
 */

/** Les onglets de l'application : pas de routeur, une `nav` et cinq vues (docs/10 §1.3). */
async function openView(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name }).click();
}

/** Choisit une option d'un sélecteur par son libellé visible. */
async function selectByLabel(page: Page, label: string, option: string): Promise<void> {
  await page.getByLabel(label, { exact: true }).selectOption({ label: option });
}

/**
 * La carte d'une cible dans « Revue des contenus » : tout ce qui la concerne se
 * vérifie **à l'intérieur** — deux cibles différentes portent les mêmes boutons.
 */
function card(page: Page, target: string): Locator {
  return page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: target, exact: true }) });
}

/** Un lot de contenu tel que l'API le rend (`GET /projects/:id/content`). */
interface ContentBundle {
  item: {
    id: string;
    target: string;
    state: string;
    currentVersionId: string | null;
    approvedVersionId: string | null;
    regeneratedCount: number;
  };
  version: { id: string; body: string; generation: string | null };
}

interface ContentDetail {
  history: {
    versions: Array<{ versionNumber: number; generation: string | null; body: string }>;
  };
}

/**
 * Les vérifications de fin passent par l'API, pas seulement par l'écran : un
 * écran peut afficher une carte juste avec des données périmées. Ce que l'API a
 * écrit est la seule vérité sur « rien n'est perdu ».
 */
async function projectIdByName(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.get('/api/projects');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { projects: Array<{ id: string; name: string }> };
  const project = body.projects.find((item) => item.name === name);
  expect(project, `projet « ${name} » introuvable côté API`).toBeDefined();
  return project?.id ?? '';
}

async function contentBundles(
  request: APIRequestContext,
  projectId: string,
): Promise<ContentBundle[]> {
  const response = await request.get(`/api/projects/${projectId}/content`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { content: ContentBundle[] }).content;
}

async function contentDetail(request: APIRequestContext, itemId: string): Promise<ContentDetail> {
  const response = await request.get(`/api/content/${itemId}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as ContentDetail;
}

/** L'état, côté API, du job le plus récent d'un type donné. */
async function latestJobStatus(request: APIRequestContext, type: string): Promise<string> {
  const response = await request.get('/api/jobs?limit=5');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { jobs: Array<{ type: string; status: string }> };
  return body.jobs.find((job) => job.type === type)?.status ?? 'absent';
}

/** Les rendus vidéo d'un contenu, tels que l'API les a écrits (étape 7). */
interface VideoRender {
  id: string;
  status: string;
  contentVersionId: string;
  validatedAt: number | null;
  ffmpegArgs: string[];
  plan: { startMs: number; endMs: number; source: string } | null;
}

async function contentRenders(
  request: APIRequestContext,
  contentId: string,
): Promise<VideoRender[]> {
  const response = await request.get(`/api/content/${contentId}/renders`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { renders: VideoRender[] }).renders;
}

/**
 * Une vidéo source **minimale** : `ftypisom`, donc reconnue comme un MP4 par la
 * signature du contenu (docs/05 §5.1). Le lanceur FFmpeg du parcours étant
 * scripté, le fichier n'a pas besoin d'être décodable — ce qui compte, c'est que
 * l'API le refuse ou l'accepte selon son **en-tête**, jamais selon son nom.
 */
function videoFixture(bytes = 4_096): Buffer {
  const video = Buffer.alloc(bytes, 0x42);
  Buffer.from('\x00\x00\x00\x20ftypisom\x00\x00\x00\x00', 'binary').copy(video, 0);
  return video;
}

test.describe('parcours 1 — de l’entretien à la publication manuelle', () => {
  test('un entretien devient un plan, deux contenus, un publié et un rejeté', async ({
    page,
    request,
  }) => {
    await test.step('le socle répond avant tout le reste', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Automatisation IA' })).toBeVisible();

      const health = await request.get('/api/system/health');
      expect(health.ok()).toBe(true);
      const body = (await health.json()) as {
        status: string;
        checks: Array<{ id: string; status: string }>;
      };
      // « degraded » est l'état normal de la pile E2E : aucune clé IA n'est
      // configurée, et c'est justement le modèle scripté qui écrit.
      expect(['ok', 'degraded']).toContain(body.status);
      expect(body.checks.find((check) => check.id === 'database')?.status).toBe('ok');
    });

    await test.step('le projet se crée depuis l’écran « Projets »', async () => {
      await openView(page, 'Projets');
      await page.getByLabel('Nom du projet').fill(PROJECT.name);
      await page.getByLabel('Objectif').fill(PROJECT.goal);
      await page.getByLabel('Positionnement').fill(PROJECT.positioning);
      await page.getByLabel('Description').fill(PROJECT.description);
      await page.getByRole('button', { name: 'Créer le projet' }).click();
      await expect(page.getByRole('button', { name: PROJECT.name })).toBeVisible();
    });

    await test.step('l’entretien propose des écritures, sans rien écrire', async () => {
      await openView(page, 'Conversation');
      await selectByLabel(page, 'Projet', PROJECT.name);
      await page.getByRole('button', { name: 'Nouvel entretien' }).click();

      await page
        .getByPlaceholder('Répondez à la question, ou racontez ce que vous avez fait…')
        .fill(USER_TURN);
      // `exact` est nécessaire depuis l'étape 6 : la zone d'entrée vocale porte
      // aussi un bouton « Envoyer cette transcription », et deux boutons ne
      // peuvent pas répondre à la même question.
      await page.getByRole('button', { name: 'Envoyer', exact: true }).click();

      // La réponse scriptée arrive, et avec elle les propositions : rien n'est en
      // mémoire tant qu'elles ne sont pas acceptées.
      await expect(page.getByText(INTERVIEWER_REPLY)).toBeVisible();
      const proposals = page.getByRole('heading', { name: /^Écritures proposées/ }).locator('..');
      await expect(proposals).toBeVisible();
      await expect(proposals).toContainText('rien n’est en mémoire');
    });

    await test.step('accepter les écritures remplit la mémoire du projet', async () => {
      const proposals = page.getByRole('heading', { name: /^Écritures proposées/ }).locator('..');
      const boxes = proposals.locator('ul').getByRole('checkbox');
      await expect(boxes.first()).toBeVisible();

      const count = await boxes.count();
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        await boxes.nth(index).check();
      }
      // Les faits resteraient « proposés » sans cette case : le parcours coche donc
      // la confirmation explicite, comme le ferait un utilisateur qui veut avancer.
      await proposals.getByLabel(/confirmer immédiatement les faits/).check();
      await proposals.getByRole('button', { name: 'Accepter la sélection' }).click();

      // Aucun refus : les motifs de refus s'affichent en clair quand il y en a un.
      await expect(proposals).not.toContainText('refusée :');
    });

    await test.step('la fiche maître se relit puis se valide', async () => {
      await page.getByRole('button', { name: 'Générer la fiche maître' }).click();

      // La génération bascule sur l'onglet « Fiche maître » : la relecture est
      // imposée avant la validation, jamais un bouton qui valide à l'aveugle.
      await expect(page.getByRole('heading', { name: /^Fiche maître v1$/ })).toBeVisible();
      await expect(page.getByText(BRIEF_SUMMARY)).toBeVisible();

      await page.getByRole('button', { name: 'Valider cette version' }).click();
      await expect(page.getByRole('button', { name: 'Valider cette version' })).toHaveCount(0);
      await expect(page.getByText(/^validée il y a/)).toBeVisible();
    });

    await test.step('le plan ne se produit que sur une fiche validée', async () => {
      await openView(page, 'Plan éditorial');
      await selectByLabel(page, 'Projet du plan', PROJECT.name);

      await page.getByRole('button', { name: 'Produire le plan' }).click();
      await expect(page.getByRole('heading', { name: PLAN_FIRST_SUBJECT })).toBeVisible();
      await expect(page.getByText(PLAN_FIRST_HOOK)).toBeVisible();
    });

    await test.step('un angle retenu produit deux contenus, en un seul job', async () => {
      const angle = page.locator('article').filter({ hasText: PLAN_FIRST_HOOK });
      await angle.getByRole('button', { name: 'Retenir cet angle' }).click();

      await angle.getByLabel(LINKEDIN_TARGET).check();
      await angle.getByLabel(REDDIT_TARGET).check();

      // Le flux est coupé **avant** de lancer : c'est le cas « la connexion a
      // lâché pendant la génération ». La barre ne doit rien inventer — pas de
      // barre à zéro, pas de progression devinée.
      await page.route('**/api/events/jobs/**', (route) => route.abort());
      await angle.getByRole('button', { name: 'Générer 2 contenu(s)' }).click();

      // Le worker, lui, a bel et bien travaillé : c'est l'API qui le dit, pas
      // l'écran. Tant que le flux est mort, l'écran n'en sait rien.
      await expect.poll(() => latestJobStatus(request, 'generate_content')).toBe('completed');
      await expect(page.locator('section[aria-live="polite"]')).toHaveCount(0);
      await expect(page.getByText(/Génération terminée/)).toHaveCount(0);

      // Le flux revient : le navigateur se reconnecte seul, le serveur renvoie le
      // **snapshot** complet du job — dont les événements écrits pendant la
      // coupure — puis `done`. Si la reprise ne tenait pas, l'avis de fin
      // n'arriverait jamais : le job est pourtant terminé depuis longtemps.
      await page.unroute('**/api/events/jobs/**');
      await expect(page.getByText(/Génération terminée/)).toBeVisible();
    });

    await test.step('la revue montre les deux contenus, chacun en brouillon validé', async () => {
      await openView(page, 'Revue des contenus');
      await selectByLabel(page, 'Projet de la revue', PROJECT.name);

      await expect(page.getByText('2 contenu(s) · 0 approuvé(s)')).toBeVisible();

      const linkedin = card(page, LINKEDIN_TARGET);
      const reddit = card(page, REDDIT_TARGET);
      await expect(linkedin).toContainText('Généré');
      await expect(linkedin).toContainText(LINKEDIN_DRAFT_HOOK);
      await expect(linkedin).toContainText(DRAFT_BODY_FRAGMENT);
      await expect(reddit).toContainText('Généré');
      await expect(reddit).toContainText(REDDIT_DRAFT_HOOK);
    });

    await test.step('approuver sans avoir ouvert la relecture est refusé', async () => {
      const linkedin = card(page, LINKEDIN_TARGET);
      const approve = linkedin.getByRole('button', { name: 'Approuver', exact: true });

      // Le bouton est désactivé **et** la raison est affichée en clair : un clic
      // dans le vide n'est pas une réponse.
      await expect(approve).toBeDisabled();
      await expect(linkedin).toContainText('Approbation : Ouvrir la relecture');
    });

    await test.step('la relecture ouverte autorise l’approbation', async () => {
      const linkedin = card(page, LINKEDIN_TARGET);
      await linkedin.getByRole('button', { name: 'Ouvrir la relecture' }).click();

      // Ouvrir la relecture est une écriture : l'état change côté API.
      await expect(linkedin).toContainText('En relecture');
      await linkedin.getByRole('button', { name: 'Approuver', exact: true }).click();

      await expect(linkedin).toContainText('Approuvé');
      await expect(page.getByText('1 approuvé(s)')).toBeVisible();

      // La version approuvée est nommée : c'est elle qui sera publiée, et c'est
      // elle que la régénération d'à côté ne devra pas toucher.
      const detail = page.getByRole('heading', { name: 'Détail du contenu' }).locator('..');
      await expect(detail).toContainText('1 version(s)');
      await expect(detail).toContainText('Approuvée (v1)');
    });

    await test.step('le paquet niveau C publie manuellement la version approuvée exacte', async () => {
      const startedAt = Date.now();
      const linkedin = card(page, LINKEDIN_TARGET);
      await page.getByLabel('Libellé du compte').fill('LinkedIn personnel');
      await page.getByRole('button', { name: 'Ajouter le compte' }).click();
      await expect(page.getByText('LinkedIn personnel')).toBeVisible();

      await page.getByRole('button', { name: 'Préparer le paquet manuel' }).click();
      const manual = page.getByRole('heading', { name: /Paquet prêt — linkedin/ }).locator('..');
      await expect(manual).toContainText(LINKEDIN_DRAFT_HOOK);
      await expect(manual.getByRole('button', { name: 'Copier le texte' })).toBeVisible();
      await expect(manual.getByRole('button', { name: 'Copier le titre' })).toBeVisible();
      await expect(manual.getByRole('button', { name: 'Copier l’accroche' })).toBeVisible();
      await expect(manual.getByRole('button', { name: 'Copier la description' })).toBeVisible();
      await expect(manual.getByRole('button', { name: 'Copier les hashtags' })).toBeVisible();
      await expect(manual.getByRole('link', { name: 'Ouvrir la plateforme' })).toBeVisible();
      await manual
        .getByLabel('Compte utilisé pour publier')
        .selectOption({ label: 'LinkedIn personnel' });
      await manual.getByRole('button', { name: 'J’ai publié' }).click();
      await expect(linkedin).toContainText('Publié');
      expect(Date.now() - startedAt).toBeLessThan(60_000);
    });

    await test.step('le calendrier planifie, déplace et publie maintenant sans doublon', async () => {
      const projectId = await projectIdByName(request, PROJECT.name);
      const bundles = await contentBundles(request, projectId);
      const linkedin = bundles.find((bundle) => bundle.item.target === 'linkedin_post');
      expect(linkedin?.item.approvedVersionId).toBeTruthy();

      // Un second compte permet de vérifier une publication API sans modifier
      // l'historique niveau C que le parcours vient de produire.
      await openView(page, 'Revue des contenus');
      await page.getByLabel('Plateforme du compte').selectOption('linkedin');
      await page.getByLabel('Libellé du compte').fill('LinkedIn calendrier');
      await page.getByRole('button', { name: 'Ajouter le compte' }).click();
      await expect(page.getByText('LinkedIn personnel · LinkedIn calendrier')).toBeVisible();

      await openView(page, 'Calendrier');
      await page
        .getByRole('combobox', { name: 'Projet', exact: true })
        .selectOption({ value: projectId });
      await page
        .getByLabel('Contenu approuvé')
        .selectOption(linkedin?.item.approvedVersionId ?? '');
      await page
        .getByLabel('Plateforme / compte')
        .selectOption({ label: 'LinkedIn · LinkedIn calendrier' });

      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1_000);
      const tomorrowKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
      await page.getByLabel('Date', { exact: true }).fill(tomorrowKey);
      await page.getByLabel('Heure', { exact: true }).fill('10:00');
      await page.getByRole('combobox', { name: 'Rigidité' }).selectOption('FLEXIBLE');
      await page.getByRole('button', { name: 'Confirmer le créneau' }).click();
      await expect(page.getByText('Créneau enregistré.')).toBeVisible();

      // La semaine est un horizon glissant de sept jours : demain doit y être
      // visible même si le test s'exécute un dimanche.
      await expect(page.locator('article[data-calendar-slot]')).toHaveCount(1);
      await page.getByRole('button', { name: 'Demain' }).click();
      const slot = page.locator('article[data-calendar-slot]');
      await expect(slot).toHaveCount(1);
      await expect(slot).toContainText('10:00');
      await expect(slot).toContainText('FLEXIBLE');

      await slot.getByRole('button', { name: 'Modifier / déplacer' }).click();
      await slot.getByLabel('Heure').fill('11:00');
      await slot.getByRole('button', { name: 'Enregistrer le déplacement' }).click();
      await expect(slot).toContainText('11:00');

      // Étape 10 : une vraie source RSS est configurée dans l'interface. Le
      // transport est simulé dans la pile E2E, mais parser, normaliser, scorer,
      // dédupliquer et persister empruntent exactement le chemin de production.
      await openView(page, 'News / Veille');
      await page
        .getByRole('combobox', { name: 'Projet', exact: true })
        .selectOption({ label: PROJECT.name });
      await page.getByLabel('Nom de la source').fill('Flux React E2E');
      await page.getByLabel('URL publique').fill('https://e2e.test/feed.xml');
      await page.getByLabel('Catégories (virgules)').fill('react, typescript, dev, ia');
      await page.getByLabel('Confiance 1–5').fill('5');
      await page.getByLabel('Fréquence (heures)').fill('6');
      await page.getByRole('button', { name: 'Ajouter la source' }).click();
      const source = page.locator('article').filter({ hasText: 'Flux React E2E' });
      await expect(source).toBeVisible();
      await source.getByRole('button', { name: 'Collecter' }).click();

      const detected = page
        .locator('article[data-news-item]')
        .filter({ hasText: 'React 20 améliore TypeScript' });
      await expect(detected).toBeVisible();
      await expect(detected).toContainText(/\d+\/100/);
      await expect(detected).toContainText(PROJECT.name);
      await detected.getByRole('button', { name: 'Créer une idée' }).click();
      await expect(detected).toContainText('Idée :');

      await detected.getByRole('button', { name: 'Proposer dans le calendrier' }).click();
      await detected.getByLabel('Créneau à déplacer').selectOption({ index: 1 });
      await detected.getByLabel('Nouvelle date').fill(tomorrowKey);
      await detected.getByLabel('Nouvelle heure').fill('12:00');
      await detected.getByRole('button', { name: 'Créer la proposition' }).click();
      // Le déplacement reste seulement proposé tant que l'utilisateur ne l'a
      // pas accepté ; ce bouton est la frontière humaine obligatoire.
      await expect(detected.getByRole('button', { name: 'Accepter la proposition' })).toBeVisible();
      await detected.getByRole('button', { name: 'Accepter la proposition' }).click();

      await openView(page, 'Calendrier');
      await page
        .getByRole('combobox', { name: 'Projet', exact: true })
        .selectOption({ value: projectId });
      await page.getByRole('button', { name: 'Demain' }).click();
      await expect(slot).toContainText('12:00');

      // Validation responsive réelle : les actions restent tactiles et aucune
      // largeur 360/390 px ne produit de débordement horizontal.
      for (const width of [360, 390]) {
        await page.setViewportSize({ width, height: 800 });
        await expect(slot.getByRole('button', { name: 'Publier maintenant' })).toBeVisible();
        const sizes = await page.evaluate(() => ({
          scroll: document.documentElement.scrollWidth,
          client: document.documentElement.clientWidth,
        }));
        expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
      }
      await page.setViewportSize({ width: 1280, height: 800 });

      await slot.getByRole('button', { name: 'Publier maintenant' }).click();
      // Le créneau prend l'heure courante : il quitte logiquement « Demain »
      // et se retrouve dans « Aujourd'hui » pendant l'exécution.
      await page
        .getByRole('group', { name: 'Période du calendrier' })
        .getByRole('button', { name: 'Aujourd’hui' })
        .click();
      const publishedSlot = page.locator('article[data-calendar-slot]');
      await expect(publishedSlot).toContainText('published');

      const publications = await request.get(
        `/api/content/${linkedin?.item.id ?? ''}/publications`,
      );
      const publicationBody = (await publications.json()) as {
        publications: Array<{ platformAccountId: string; status: string; attempts: unknown[] }>;
      };
      const calendarPublication = publicationBody.publications.find(
        (publication) => publication.status === 'published' && publication.attempts.length === 1,
      );
      expect(calendarPublication).toBeDefined();

      const jobs = await request.get('/api/jobs?limit=50');
      const publishJobs = (
        (await jobs.json()) as { jobs: Array<{ type: string; status: string }> }
      ).jobs.filter((job) => job.type === 'publish_content');
      expect(publishJobs).toHaveLength(1);
      expect(publishJobs[0]?.status).toBe('completed');

      await openView(page, 'Revue des contenus');
      await selectByLabel(page, 'Projet de la revue', PROJECT.name);
    });

    await test.step('la correction manuelle crée une version, elle n’écrase rien', async () => {
      const reddit = card(page, REDDIT_TARGET);
      const detail = page.getByRole('heading', { name: 'Détail du contenu' }).locator('..');

      await reddit.getByRole('button', { name: 'Ouvrir la relecture' }).click();
      await reddit.getByRole('button', { name: 'Modifier', exact: true }).click();

      const body = reddit.getByLabel(/Corps du texte/);
      const original = await body.inputValue();
      await body.fill(`${original}\n\n${REDDIT_EDIT}`);
      await reddit.getByRole('button', { name: 'Enregistrer une nouvelle version' }).click();

      await expect(reddit).toContainText(REDDIT_EDIT);
      // La v1 est toujours là, nommée par son origine : c'est exactement ce que
      // « rien n'est perdu » veut dire.
      await expect(detail).toContainText('2 version(s)');
      await expect(detail).toContainText('v1 · Génération initiale');
      await expect(detail).toContainText('v2 · Modification manuelle');
    });

    await test.step('la régénération ajoute une troisième version, dans le plafond', async () => {
      const reddit = card(page, REDDIT_TARGET);
      const detail = page.getByRole('heading', { name: 'Détail du contenu' }).locator('..');

      await reddit.getByRole('button', { name: 'Régénérer', exact: true }).click();
      await reddit.getByLabel(/Consigne \(facultative\)/).fill(REGENERATION_INSTRUCTION);
      await reddit.getByRole('button', { name: 'Régénérer cette plateforme' }).click();

      // Le nouveau texte arrive par le flux de job, la relecture se rafraîchit sur
      // l'état terminal : la version courante change, les précédentes restent.
      await expect(reddit).toContainText(REGENERATION_MARKER);
      await expect(reddit).toContainText('1/3 régénérations');
      await expect(detail).toContainText('3 version(s)');
      await expect(detail).toContainText('v3 · Régénération IA');
      await expect(detail).toContainText('v2 · Modification manuelle');
    });

    await test.step('le rejet archive le contenu, avec son motif', async () => {
      const reddit = card(page, REDDIT_TARGET);
      await reddit.getByRole('button', { name: 'Rejeter', exact: true }).click();
      await reddit.getByLabel(/Motif du rejet/).fill(REJECTION_REASON);
      await reddit.getByRole('button', { name: 'Rejeter ce contenu' }).click();

      await expect(reddit).toContainText('Rejeté');
      await expect(reddit).toContainText(`Rejeté : ${REJECTION_REASON}`);
      await expect(page.getByText('1 rejeté(s)')).toBeVisible();
    });

    await test.step('le contenu publié n’a pas bougé d’un caractère', async () => {
      const linkedin = card(page, LINKEDIN_TARGET);
      await expect(linkedin).toContainText('Publié');
      await expect(linkedin).toContainText(LINKEDIN_DRAFT_HOOK);
      await expect(linkedin).toContainText(DRAFT_BODY_FRAGMENT);
      await expect(linkedin).not.toContainText(REGENERATION_MARKER);

      // L'écran dit ce que l'API a écrit ; on le lui demande aussi, pour que
      // « rien n'est perdu » ne repose pas sur une carte bien affichée.
      const projectId = await projectIdByName(request, PROJECT.name);
      const bundles = await contentBundles(request, projectId);

      const linkedinItem = bundles.find((bundle) => bundle.item.target === 'linkedin_post');
      expect(linkedinItem?.item.state).toBe('published');
      expect(linkedinItem?.item.approvedVersionId).toBe(linkedinItem?.item.currentVersionId);
      expect(linkedinItem?.item.regeneratedCount).toBe(0);
      expect(linkedinItem?.version.body).toContain(DRAFT_BODY_FRAGMENT);

      // Le Reddit, lui, est archivé — et ses trois versions sont toujours là,
      // dans l'ordre, la première intacte.
      const redditItem = bundles.find((bundle) => bundle.item.target === 'reddit_post');
      expect(redditItem?.item.state).toBe('archived');

      const detail = await contentDetail(request, redditItem?.item.id ?? '');
      expect(detail.history.versions.map((version) => version.generation)).toEqual([
        'initial',
        'edited',
        'regenerated',
      ]);
      expect(detail.history.versions[0]?.body).toContain(DRAFT_BODY_FRAGMENT);
      expect(detail.history.versions[0]?.body).not.toContain(REDDIT_EDIT);
      expect(detail.history.versions[2]?.body).toContain(REGENERATION_MARKER);
    });

    await test.step('le coût affiché est celui des appels réellement passés', async () => {
      // Le budget ne compte que ce que la chaîne de mesure a enregistré — les
      // appels des deux jobs d'écriture — et rien n'est estimé (docs/09 §11.1).
      const health = await request.get('/api/system/health');
      const body = (await health.json()) as {
        budget: { todayCalls: number; todayMicroUsd: number };
        lastCompletedJob: { type: string; costMicroUsd: number } | null;
      };
      expect(body.budget.todayCalls).toBeGreaterThan(0);
      expect(body.budget.todayMicroUsd).toBeGreaterThan(0);
      expect(body.lastCompletedJob?.type).toBe('generate_content');
      expect(body.budget.todayMicroUsd).toBeGreaterThanOrEqual(
        body.lastCompletedJob?.costMicroUsd ?? 0,
      );

      // L'écran de diagnostic affiche **exactement** ce que l'API a compté : la
      // vérification porte sur la chaîne de mesure, pas sur un chiffre décoratif.
      await openView(page, 'Diagnostic');
      // Le libellé « Budget du jour » existe deux fois (la carte de contrôle et
      // la carte de mesure) : on vise, dans le contenu, la carte qui porte le
      // nombre d'appels.
      const budgetCard = page
        .getByRole('main')
        .locator('div')
        .filter({ hasText: 'appel(s) facturé(s)' });
      await expect(budgetCard).toContainText(
        `$${(body.budget.todayMicroUsd / 1_000_000).toFixed(4)}`,
      );
      await expect(budgetCard).toContainText(`${body.budget.todayCalls} appel(s) facturé(s)`);
      await expect(budgetCard).not.toContainText('$0.0000');

      // Les deux jobs d'écriture sont visibles, avec leur coût.
      await expect(page.getByText('generate_content').first()).toBeVisible();
    });

    await test.step('le montage vidéo : import, transcription, plan édité, rendu, aperçu', async () => {
      // Le contenu LinkedIn est **publié** : sa version approuvée tient toujours,
      // donc il reste montable — c'est le cas normal d'un short destiné à une
      // autre plateforme, et l'API le vérifie sur `approvedVersionId`, pas sur
      // l'état courant du contenu.
      const projectId = await projectIdByName(request, PROJECT.name);
      const bundles = await contentBundles(request, projectId);
      const linkedin = bundles.find((bundle) => bundle.item.target === 'linkedin_post');
      expect(
        linkedin?.item.approvedVersionId,
        'version approuvée du contenu LinkedIn',
      ).toBeTruthy();

      await openView(page, 'Montage vidéo');
      await selectByLabel(page, 'Projet', PROJECT.name);
      await page.getByLabel('Contenu approuvé').selectOption(linkedin?.item.id ?? '');

      // 1. Importer la vidéo : reconnue par son en-tête, mesurée par ffprobe.
      await page.getByLabel('Fichier vidéo').setInputFiles({
        name: VIDEO_SOURCE_NAME,
        mimeType: VIDEO_SOURCE_MIME,
        buffer: videoFixture(),
      });
      const sourceCard = page.locator('li').filter({ hasText: '1920×1080' });
      await expect(sourceCard).toContainText('Aucune transcription');

      // 2. Transcrire : la progression vient du job réel, puis l'écran se rafraîchit.
      await sourceCard.getByRole('button', { name: 'Transcrire' }).click();
      await expect(page.getByText('Transcription de la vidéo')).toBeVisible();
      await expect(sourceCard).toContainText('Transcription prête');
      await expect(sourceCard).toContainText('3 segment(s)');

      // 3. Choisir la vidéo et proposer un plan : aucun agent de montage n'est
      //    configuré dans la pile, donc le repli calculé en code prend le relais
      //    — et l'écran le dit au lieu de faire croire à une proposition du modèle.
      await sourceCard.getByRole('button', { name: 'Choisir cette vidéo' }).click();
      await page.getByRole('button', { name: 'Proposer un montage' }).click();
      const planSummary = page.getByText(/Plan proposé/);
      await expect(planSummary).toContainText('0:00.000 → 1:00.000');
      await expect(page.getByText(/calculé par défaut/)).toBeVisible();

      // 4. Éditer la fenêtre de l'extrait, puis lancer le rendu.
      await page.getByLabel('Début de l’extrait').fill(VIDEO_WINDOW_START);
      await page.getByLabel('Fin de l’extrait').fill(VIDEO_WINDOW_END);
      await page.getByRole('button', { name: 'Lancer le rendu' }).click();

      // 5. Le rendu se suit en direct, puis l'aperçu apparaît — sans rechargement.
      const renderCard = page.locator('article[data-render]');
      await expect(page.getByText('Encodage du short')).toBeVisible();
      await expect(renderCard).toContainText('Terminé');
      await expect(renderCard).toContainText('0:05.000 → 0:25.000 (0:20.000)');
      await expect(renderCard).toContainText('rendu 0:20.000');
      const preview = renderCard.getByLabel('Aperçu du short');
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute('src', /\/api\/renders\/.+\/file$/);

      // 6. Valider : c'est la seule trace que quelqu'un a regardé ce montage.
      await renderCard.getByRole('button', { name: 'Valider le montage' }).click();
      await expect(renderCard.locator('[data-validated="true"]')).toBeVisible();

      // 7. Ce que l'API a écrit, et pas seulement ce que l'écran affiche : le
      //    rendu est rattaché à la **bonne** version de contenu, les bornes
      //    éditées sont celles compilées, et les sous-titres viennent d'un nom
      //    relatif (aucun chemin d'utilisateur dans le filtre FFmpeg).
      const renders = await contentRenders(request, linkedin?.item.id ?? '');
      expect(renders).toHaveLength(1);
      const render = renders[0]!;
      expect(render.contentVersionId).toBe(linkedin?.item.approvedVersionId);
      expect(render.status).toBe('completed');
      expect(render.validatedAt).not.toBeNull();
      expect(render.plan?.source).toBe('manual');
      expect(render.ffmpegArgs[render.ffmpegArgs.indexOf('-ss') + 1]).toBe('5.000');
      expect(render.ffmpegArgs[render.ffmpegArgs.indexOf('-t') + 1]).toBe('20.000');
      expect(render.ffmpegArgs.join(' ')).toContain('subtitles=subtitles.ass');

      // Le contenu publié n'a pas bougé : un rendu est un **nouvel** asset.
      const after = await contentBundles(request, projectId);
      const linkedinAfter = after.find((bundle) => bundle.item.target === 'linkedin_post');
      expect(linkedinAfter?.item.state).toBe('published');
      expect(linkedinAfter?.version.body).toContain(DRAFT_BODY_FRAGMENT);
    });
  });
});
