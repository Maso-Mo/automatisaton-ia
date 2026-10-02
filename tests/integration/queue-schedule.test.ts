import { afterEach, describe, expect, it } from 'vitest';
import { transcribeMediaSpec } from '@aia/queue';
import { TransientError } from '@aia/shared';
import { createTestContext, type TestContext } from '../support/harness';

/**
 * Les deux seules raisons pour lesquelles un job `queued` peut être
 * « pas encore disponible » : une **échéance** (cron, publication planifiée) ou
 * un **backoff de reprise**. Elles se ressemblent dans la table et ne doivent pas
 * se confondre dans le planificateur :
 *
 * - `promoteScheduled()` rend disponible un job dont l'échéance est atteinte ;
 * - il ne doit **jamais** libérer un backoff en cours, sinon la politique de
 *   reprise de docs/02 §12 (trente secondes entre deux tentatives) devient une
 *   reprise immédiate au tour de boucle suivant — invisible dans les journaux, et
 *   brutal pour un fournisseur déjà en difficulté.
 *
 * Le job utilisé est la vraie spécification `transcribe_media` : c'est celle de
 * l'étape 6, celle dont le backoff de 30 s est annoncé à l'utilisateur.
 */

let context: TestContext | null = null;

afterEach(() => {
  context?.cleanup();
  context = null;
});

describe('échéance et backoff : deux attentes distinctes (docs/08 §2.1)', () => {
  it('n’annule pas un backoff de reprise en promouvant les jobs échus', async () => {
    context = createTestContext();
    const { queue, registry, clock } = context;
    registry.registerSpec(transcribeMediaSpec);

    const jobId = await queue.enqueue('transcribe_media', {
      assetId: 'asset-1',
      language: 'fr',
    });

    // Première tentative : le job échoue de façon transitoire.
    const [claimed] = await queue.claim('worker-test', 1);
    expect(claimed?.id).toBe(jobId);
    expect(claimed?.attempt).toBe(1);
    await queue.fail(jobId, new TransientError('ffmpeg a échoué', { code: 'FFMPEG_TRANSIENT' }));

    const retried = queue.get(jobId);
    expect(retried?.status).toBe('queued');
    expect(retried?.attempt).toBe(1);
    expect(retried?.available_at).toBe(clock.nowMs() + 30_000);
    // L'échéance a suivi le backoff : c'est ce qui protège l'attente.
    expect(retried?.scheduled_for).toBe(retried?.available_at);
    expect(queue.events(jobId).some((event) => event.step === 'retry')).toBe(true);

    // **La régression** : un tour de planificateur ne doit rien libérer ici.
    expect(queue.promoteScheduled()).toBe(0);
    clock.advance(10_000);
    expect(await queue.claim('worker-test', 1)).toHaveLength(0);

    // L'attente est respectée jusqu'au bout, puis la reprise a lieu.
    clock.advance(21_000);
    const [second] = await queue.claim('worker-test', 1);
    expect(second?.id).toBe(jobId);
    expect(second?.attempt).toBe(2);
  });

  it('rend disponible un job planifié dont l’échéance est atteinte', async () => {
    context = createTestContext();
    const { queue, registry, clock } = context;
    registry.registerSpec(transcribeMediaSpec);

    const jobId = await queue.enqueue(
      'transcribe_media',
      { assetId: 'asset-2', language: 'fr' },
      { delayMs: 300_000 },
    );

    expect(await queue.claim('worker-test', 1)).toHaveLength(0);
    expect(queue.promoteScheduled()).toBe(0);

    // À l'échéance, c'est `available_at` qui libère le job : les deux colonnes
    // avancent ensemble (`insertJob` les pose à la même valeur), donc la
    // réservation suffit. Le planificateur, lui, ne force rien.
    clock.advance(301_000);
    const [claimed] = await queue.claim('worker-test', 1);
    expect(claimed?.id).toBe(jobId);
  });
});
