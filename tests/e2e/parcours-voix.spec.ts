import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { E2E_DATA_DIR } from './support/environment';
import {
  VOICE_CORRECTION,
  VOICE_OPENING_TURN,
  VOICE_PROJECT,
  VOICE_TRANSCRIPT,
} from './support/script';

/**
 * Parcours 2 (docs/09 §11) — **l'entrée vocale** : enregistrer, transcrire
 * localement, corriger, confirmer.
 *
 * Ce qu'il prouve, et qu'aucun test d'intégration ne peut prouver : le
 * navigateur **enregistre vraiment** (`MediaRecorder` + périphérique audio
 * factice de Chromium), l'audio part par le vrai chemin (`POST
 * /conversations/:id/voice`), la file le fait transcrire par le worker, le texte
 * revient dans la zone de relecture, et **rien n'est envoyé avant le clic de
 * confirmation** — la règle de docs/05 §3.2, vérifiée côté API autant qu'à
 * l'écran.
 *
 * Le moteur de transcription est scripté (`support/stack.ts` : le même moteur
 * sert à l'API qui annonce la capacité et au worker qui transcrit), le texte
 * attendu vient de `support/script.ts`. Le reste de la chaîne est celle de
 * production : Fastify, SQLite, la file, le stockage local sur disque.
 */

/** Les onglets de l'application : pas de routeur, une `nav` et cinq vues (docs/10 §1.3). */
async function openView(page: Page, name: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Vues' }).getByRole('button', { name }).click();
}

/** Choisit une option d'un sélecteur par son libellé visible. */
async function selectByLabel(page: Page, label: string, option: string): Promise<void> {
  await page.getByLabel(label, { exact: true }).selectOption({ label: option });
}

/** Un message tel que l'API le rend (`GET /conversations/:id`). */
interface MessageRow {
  id: string;
  role: string;
  content: string;
  inputMode: string | null;
}

interface TranscriptResponse {
  asset: { id: string; mimeType: string; sizeBytes: number; usageCount: number };
  transcript: {
    engine: string;
    model: string | null;
    text: string;
    editedBody: string | null;
    durationMs: number | null;
  } | null;
}

/**
 * Les vérifications passent par l'API, pas seulement par l'écran : ce que le
 * pipeline texte a reçu est ce que l'API a écrit, et c'est la seule preuve de
 * « rien n'est parti sans confirmation ».
 */
async function conversationIdOf(request: APIRequestContext, projectName: string): Promise<string> {
  const projects = await request.get('/api/projects');
  expect(projects.ok()).toBe(true);
  const { projects: rows } = (await projects.json()) as {
    projects: Array<{ id: string; name: string }>;
  };
  const project = rows.find((row) => row.name === projectName);
  expect(project, `projet « ${projectName} » introuvable côté API`).toBeDefined();

  const conversations = await request.get(`/api/conversations?projectId=${project?.id ?? ''}`);
  expect(conversations.ok()).toBe(true);
  const body = (await conversations.json()) as { conversations: Array<{ id: string }> };
  const conversationId = body.conversations[0]?.id;
  expect(conversationId, 'entretien introuvable côté API').toBeDefined();
  return conversationId ?? '';
}

async function messagesOf(
  request: APIRequestContext,
  conversationId: string,
): Promise<MessageRow[]> {
  const response = await request.get(`/api/conversations/${conversationId}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { messages: MessageRow[] }).messages;
}

/** Le transcript **stocké** pour un audio : la sortie du moteur et la correction. */
async function transcriptOf(
  request: APIRequestContext,
  conversationId: string,
  assetId: string,
): Promise<TranscriptResponse> {
  const response = await request.get(
    `/api/conversations/${conversationId}/voice/${assetId}/transcript`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as TranscriptResponse;
}

test.describe('parcours 2 — la voix devient un tour relu', () => {
  test('un enregistrement est transcrit localement, corrigé, puis envoyé sur confirmation', async ({
    page,
    request,
  }) => {
    // Ce que l'API annonce sur sa capacité d'enregistrement, recopié tel que
    // l'écran doit le répéter : l'assertion d'affichage ne peut donc pas passer
    // si le composant invente une limite que le serveur n'applique pas.
    let acceptedFormat = '';

    await test.step('l’API annonce un moteur de transcription disponible', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Automatisation IA' })).toBeVisible();

      const response = await request.get('/api/media/capabilities');
      expect(response.ok()).toBe(true);
      const capabilities = (await response.json()) as {
        transcription: { available: boolean; engine: string };
        maxUploadBytes: number;
        maxDurationMs: number;
        acceptedMimeTypes: string[];
      };

      // C'est cette réponse, et elle seule, qui active le bouton « Enregistrer » :
      // une capacité annoncée mais absente ferait un écran qui ment.
      expect(capabilities.transcription.available).toBe(true);
      expect(capabilities.transcription.engine).toBe('whisper_cpp');
      expect(capabilities.acceptedMimeTypes).toContain('audio/webm');
      expect(capabilities.maxUploadBytes).toBeGreaterThan(0);
      expect(capabilities.maxDurationMs).toBeGreaterThan(0);

      // La ligne de limite affichée par le composant, calculée comme lui
      // (`VoiceInput`) à partir de la réponse : 512 Mo et 900 s aujourd'hui,
      // mais c'est la réponse qui fait foi, pas une constante du parcours.
      acceptedFormat = `Format accepté : audio jusqu’à ${Math.floor(
        capabilities.maxDurationMs / 60_000,
      )} min et ${Math.floor(capabilities.maxUploadBytes / (1024 * 1024))} Mo.`;
    });

    await test.step('le projet et l’entretien existent', async () => {
      await openView(page, 'Projets');
      await page.getByLabel('Nom du projet').fill(VOICE_PROJECT.name);
      await page.getByLabel('Objectif').fill(VOICE_PROJECT.goal);
      await page.getByLabel('Positionnement').fill(VOICE_PROJECT.positioning);
      await page.getByLabel('Description').fill(VOICE_PROJECT.description);
      await page.getByRole('button', { name: 'Créer le projet' }).click();
      await expect(page.getByRole('button', { name: VOICE_PROJECT.name })).toBeVisible();

      await openView(page, 'Conversation');
      await selectByLabel(page, 'Projet', VOICE_PROJECT.name);
      await page.getByRole('button', { name: 'Nouvel entretien' }).click();

      // Le micro répond à une question : le tour de texte ouvre l'entretien par le
      // chemin déjà éprouvé (parcours 1), et la voix vient ensuite.
      await page
        .getByPlaceholder('Répondez à la question, ou racontez ce que vous avez fait…')
        .fill(VOICE_OPENING_TURN);
      // `exact` est nécessaire : « Envoyer cette transcription » contient aussi
      // « Envoyer », et deux boutons ne peuvent pas répondre à la même question.
      await page.getByRole('button', { name: 'Envoyer', exact: true }).click();
      await expect(page.getByRole('list', { name: 'Messages' })).toContainText(VOICE_OPENING_TURN);
    });

    const voice = page.getByRole('region', { name: 'Entrée vocale' });
    /** L'audio téléversé : son identifiant relie l'écran aux vérifications d'API. */
    let assetId = '';

    await test.step('le microphone s’ouvre et l’enregistrement démarre', async () => {
      await expect(voice.getByRole('status')).toHaveText(
        'Le texte ne sera envoyé qu’après votre relecture.',
      );
      // L'écran annonce la limite que l'API applique vraiment, pas une constante
      // recopiée dans le composant.
      expect(acceptedFormat.length).toBeGreaterThan(0);
      await expect(voice.getByText(acceptedFormat, { exact: false })).toBeVisible();

      /*
       * On enregistre **vraiment**. Les libellés d'attente (téléversement, file,
       * transcription) sont trop brefs pour qu'une assertion qui interroge
       * l'écran les attrape un jour : le worker local est à quelques
       * centimètres de la file. Un observateur posé avant l'arrêt enregistre la
       * séquence réellement affichée — c'est la progression en temps réel de
       * docs/09 §11.1, lue au lieu d'être devinée.
       */
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __voiceStages?: string[] }).__voiceStages = seen;
        const observer = new MutationObserver(() => {
          const element = document.querySelector('[aria-label="Entrée vocale"] [role="status"]');
          const text = element?.textContent?.trim() ?? '';
          if (text.length > 0 && seen[seen.length - 1] !== text) seen.push(text);
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      });

      const upload = page.waitForResponse(
        (response) => response.request().method() === 'POST' && response.url().includes('/voice'),
      );

      const record = voice.getByRole('button', { name: 'Enregistrer' });
      await expect(record).toBeEnabled();
      await record.click();
      await expect(voice.getByRole('status')).toContainText('Enregistrement en cours');
      await page.waitForTimeout(1_500);
      await voice.getByRole('button', { name: 'Arrêter' }).click();

      // Ce qui est parti est un vrai conteneur audio, non vide, et c'est ce que
      // l'API a **écrit sur le disque** — pas un fichier fabriqué pour le test.
      //
      // La taille du corps n'est volontairement pas lue depuis la requête :
      // Playwright ne donne pas le corps d'un `Blob` envoyé par la page (CDP ne
      // transmet pas les corps binaires). Le fait vérifiable est donc le
      // fichier stocké, avec sa taille annoncée et son en-tête EBML.
      const uploaded = await upload;
      expect(uploaded.ok()).toBe(true);
      expect(uploaded.request().headers()['content-type']).toContain('audio/webm');

      const { asset } = (await uploaded.json()) as {
        asset: { id: string; mimeType: string; sizeBytes: number; storageKey: string };
      };
      expect(asset.mimeType).toBe('audio/webm');
      // Un enregistrement de 1,5 s fait des milliers d'octets : un conteneur
      // vide ne doit pas passer pour un enregistrement réussi.
      expect(asset.sizeBytes).toBeGreaterThan(1_000);
      expect(asset.storageKey).not.toContain('..');

      const stored = await readFile(join(E2E_DATA_DIR, 'media', asset.storageKey));
      expect(stored.byteLength).toBe(asset.sizeBytes);
      // En-tête EBML : ce qui est rangé sur le disque est bien le WebM produit
      // par `MediaRecorder`, et non un fichier vide portant la bonne extension.
      expect(stored.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      assetId = asset.id;

      // Ce qui a été enregistré reste écoutable : l'utilisateur peut se relire
      // avant d'envoyer.
      await expect(voice.getByLabel('Enregistrement à relire')).toBeVisible();
    });

    await test.step('la transcription locale arrive, et rien n’est envoyé', async () => {
      const textarea = voice.getByLabel(/Texte reconnu/);
      // Le texte vient du worker : temps réel désormais observable, étape par
      // étape, sur la barre d'état.
      await expect(textarea).toBeVisible();
      await expect(textarea).toHaveValue(VOICE_TRANSCRIPT);
      await expect(voice.getByRole('status')).toHaveText(
        'Transcription prête : relisez-la, corrigez-la, puis envoyez-la.',
      );

      const stages = await page.evaluate(
        () => (window as unknown as { __voiceStages?: string[] }).__voiceStages ?? [],
      );
      // L'attente a été **dite** : le téléversement, la file, ou whisper.cpp —
      // au moins l'une des trois, et seul l'écran peut le montrer.
      expect(
        stages.some((label) =>
          /Téléversement vers l’API locale|En attente du worker local|Transcription locale par whisper\.cpp/.test(
            label,
          ),
        ),
        `aucun état d’attente affiché : ${JSON.stringify(stages)}`,
      ).toBe(true);

      const conversationId = await conversationIdOf(request, VOICE_PROJECT.name);
      const messages = await messagesOf(request, conversationId);
      // La garantie de docs/05 §3.2, côté serveur : après l'enregistrement et la
      // transcription, **aucun** tour vocal n'existe. Un seul clic peut en créer.
      expect(messages.filter((message) => message.inputMode === 'voice')).toHaveLength(0);

      const stored = await transcriptOf(request, conversationId, assetId);
      expect(stored.transcript?.text).toBe(VOICE_TRANSCRIPT);
      expect(stored.transcript?.editedBody).toBeNull();
      expect(stored.transcript?.engine).toBe('whisper_cpp');
      expect(stored.transcript?.durationMs).toBeGreaterThan(0);
    });

    await test.step('la correction part à la place de la sortie brute', async () => {
      const textarea = voice.getByLabel(/Texte reconnu/);
      await textarea.fill(VOICE_CORRECTION);
      // Corriger ne doit envoyer **rien** : c'est le clic qui envoie.
      const conversationId = await conversationIdOf(request, VOICE_PROJECT.name);
      expect((await messagesOf(request, conversationId)).length).toBe(2);

      await voice.getByRole('button', { name: 'Envoyer cette transcription' }).click();

      // Le tour apparaît dans le fil, marqué comme relu par l'utilisateur.
      const bubble = page
        .getByRole('list', { name: 'Messages' })
        .locator('li')
        .filter({ hasText: VOICE_CORRECTION });
      await expect(bubble).toContainText('Vous');
      await expect(bubble).toContainText('voix relue');

      // Le brouillon a disparu : un envoi confirmé ne se rejoue pas deux fois.
      await expect(voice.getByLabel(/Texte reconnu/)).toHaveCount(0);
    });

    await test.step('l’API confirme le tour vocal, la correction et l’audio rattaché', async () => {
      const conversationId = await conversationIdOf(request, VOICE_PROJECT.name);
      const messages = await messagesOf(request, conversationId);

      // Le tour de texte d'ouverture, la réponse, puis le tour vocal et sa
      // réponse : rien de plus, rien de moins.
      expect(messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      const voiceTurn = messages[2];
      expect(voiceTurn?.content).toBe(VOICE_CORRECTION);
      expect(voiceTurn?.content).not.toBe(VOICE_TRANSCRIPT);
      expect(voiceTurn?.inputMode).toBe('voice');
      // La réponse de l'assistant suit le tour vocal : le pipeline texte a bien
      // consommé ce que la voix a produit.
      expect(messages[3]?.content.length ?? 0).toBeGreaterThan(0);

      const stored = await transcriptOf(request, conversationId, assetId);
      // La correction est **datée dans le transcript**, pas seulement affichée :
      // la sortie du moteur reste intacte à côté.
      expect(stored.transcript?.editedBody).toBe(VOICE_CORRECTION);
      expect(stored.transcript?.text).toBe(VOICE_TRANSCRIPT);
      // L'audio est rattaché à un message : il est la preuve de ce qui a été
      // envoyé, donc il n'est plus supprimable (docs/03 §12.1).
      expect(stored.asset.usageCount).toBe(1);
    });
  });
});
