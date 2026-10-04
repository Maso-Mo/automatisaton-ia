import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase } from '@aia/database';
import { buildApi } from '../../apps/api/src/bootstrap';
import { buildServer } from '../../apps/api/src/server';
import { createTestContext, TEST_NOW, type TestContext } from '../support/harness';

/**
 * Sondes et panneau d'exploitation (étape 12 §14).
 *
 * Les trois routes ne répondent pas à la même question, et c'est ce que ces
 * tests figent :
 *
 * - `/health` : *le processus est-il vivant ?* — aucune lecture de base, donc
 *   appelable souvent ;
 * - `/ready` : *peut-on lui envoyer du travail ?* — 503 tant que la base ou un
 *   dossier d'écriture manque, pour qu'aucun trafic n'arrive sur une instance
 *   incomplète ;
 * - `/system/diagnostics` : *où en est-on ?* — disque, sauvegarde, jobs en
 *   échec, services configurés — et **jamais la valeur d'un secret**.
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

function makeApi(env: Record<string, string> = {}) {
  const created = createTestContext({ env });
  context = created;
  const api = buildApi({ config: created.config, logger: created.logger, clock: created.clock });
  return { context: created, app: buildServer(api) };
}

describe('sondes de supervision et diagnostic d’exploitation', () => {
  it('répond à /health sans toucher à la base', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'api' });
  });

  it('se déclare prêt quand la base, les médias et les sauvegardes sont accessibles', async () => {
    const { app } = makeApi();
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ready).toBe(true);
    expect(body.storage).toEqual({ database: true, media: true, backups: true });
    expect(body.blocking).toEqual([]);
  });

  it('répond 503 quand un dossier d’écriture a disparu, sans se croire prêt', async () => {
    const { app, context: created } = makeApi();
    // Le dossier média disparaît (disque démonté, chemin effacé) **après** le
    // démarrage : c'est précisément le cas qu'une sonde doit rattraper.
    rmSync(created.config.paths.mediaRoot, { recursive: true, force: true });

    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json().ready).toBe(false);
    expect(response.json().storage.media).toBe(false);
  });
});

describe('panneau d’exploitation', () => {
  it('décrit le disque, la dernière sauvegarde, les échecs et les services', async () => {
    const { app, context: created } = makeApi();

    // Aucune sauvegarde au départ : le diagnostic le dit sans échouer.
    const empty = await app.inject({ method: 'GET', url: '/system/diagnostics' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().lastBackup).toBeNull();
    expect(empty.json().backupCount).toBe(0);
    expect(empty.json().disk.length).toBeGreaterThan(0);
    for (const disk of empty.json().disk as Array<Record<string, number>>) {
      expect(disk.usedPercent).toBeGreaterThanOrEqual(0);
      expect(disk.usedPercent).toBeLessThanOrEqual(100);
    }

    // Une sauvegarde réelle, puis une lecture : le diagnostic la voit.
    const backupDir = join(created.config.paths.backupDir, 'db', '20260310-120000');
    mkdirSync(backupDir, { recursive: true });
    const result = await backupDatabase(created.handle, { targetFile: join(backupDir, 'app.db') });
    writeFileSync(
      join(backupDir, 'metadata.json'),
      JSON.stringify({
        kind: 'db',
        createdAt: TEST_NOW,
        sizeBytes: result.sizeBytes,
        migrations: result.migrations,
        checksum: result.checksum,
      }),
    );

    // Un job en échec : les échecs ne sont jamais supprimés automatiquement, donc
    // les compter est le seul moyen de les rendre visibles.
    created.handle.sqlite
      .prepare(
        "insert into jobs (id, type, status, priority, input_json, scheduled_for, available_at, attempt, max_attempts, idempotent, requires_network, progress, cost_micro_usd, created_at, updated_at) values (?, 'noop', 'failed', 5, '{}', ?, ?, 1, 3, 1, 0, 0, 0, ?, ?)",
      )
      .run('job-en-echec', TEST_NOW, TEST_NOW, TEST_NOW, TEST_NOW);

    const response = await app.inject({ method: 'GET', url: '/system/diagnostics' });
    const body = response.json();
    expect(body.lastBackup.label).toBe('20260310-120000');
    expect(body.lastBackup.checksum).toBe(result.checksum.slice(0, 12));
    expect(body.backupCount).toBe(1);
    expect(body.failedJobs).toBe(1);

    const ids = (body.services as Array<{ id: string }>).map((service) => service.id);
    expect(ids).toEqual(
      expect.arrayContaining(['ffmpeg', 'whisper', 'llm', 'linkedin', 'reddit', 'tiktok', 'auth']),
    );
    // Un service optionnel absent est signalé comme tel : il dégrade une
    // fonctionnalité, il n'empêche pas de démarrer.
    const whisper = (body.services as Array<{ id: string; optional: boolean }>).find(
      (service) => service.id === 'whisper',
    );
    expect(whisper?.optional).toBe(true);
  });

  it('ne renvoie jamais la valeur d’un secret, seulement sa présence', async () => {
    const secret = 'cle-factice-jamais-divulguee-0123456789';
    const token = 'jeton-factice-0123456789';
    const { app } = makeApi({ DEEPSEEK_API_KEY: secret, AUTH_TOKEN: token });
    // Le jeton est fourni pour pouvoir lire le panneau : il n'a rien à y faire.
    const response = await app.inject({
      method: 'GET',
      url: '/system/diagnostics',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain(token);
    const services = response.json().services as Array<{ id: string; configured: boolean }>;
    expect(services.find((service) => service.id === 'llm')?.configured).toBe(true);
    expect(services.find((service) => service.id === 'auth')?.configured).toBe(true);
  });
});
