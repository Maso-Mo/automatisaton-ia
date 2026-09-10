import { buildWorker } from './bootstrap';

/**
 * Crée un job `noop` — la seule façon de créer un job à l'étape 1.
 *
 * Cette commande existe parce qu'aucune route d'action n'est exposée par l'API à
 * cette étape (docs/10 §4.1, « Interdits »). Elle exerce le **même chemin** que
 * celui qu'utiliseront les routes des étapes suivantes : validation Zod de
 * l'entrée, clé de déduplication, priorité, insertion dans `jobs`.
 *
 * Utilisation :
 *   pnpm job:noop            # crée le job et s'arrête
 *   pnpm job:noop -- --wait  # attend la fin et affiche le coût calculé
 */

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'dead']);

async function main(): Promise<void> {
  const wait = process.argv.includes('--wait');
  const worker = buildWorker();

  try {
    const jobId = await worker.queue.enqueue(
      'noop',
      { message: 'sonde manuelle de l’étape 1' },
      { dedupeKey: 'diagnostic:noop' },
    );
    console.log(`✅ job noop en file : ${jobId}`);
    console.log('   Le worker doit tourner : « pnpm dev:worker ».');

    if (!wait) return;

    const deadline = Date.now() + 60_000;
    for (;;) {
      const job = worker.queue.get(jobId);
      if (job && TERMINAL.has(job.status)) {
        console.log(`   statut : ${job.status} · tentative ${job.attempt}/${job.max_attempts}`);
        console.log(`   coût : ${job.cost_micro_usd} µUSD (${job.cost_micro_usd / 1_000_000} USD)`);
        console.log(`   durée : ${job.duration_ms ?? 0} ms`);
        for (const event of worker.queue.events(jobId)) {
          console.log(
            `   [${event.sequence}] ${event.level.padEnd(5)} ${event.step ?? '-'} ${event.message}`,
          );
        }
        if (job.status !== 'completed') process.exitCode = 1;
        return;
      }
      if (Date.now() > deadline) {
        console.error('⏱️  délai dépassé : le worker ne semble pas tourner');
        process.exitCode = 1;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } finally {
    await worker.shutdown();
  }
}

void main();
