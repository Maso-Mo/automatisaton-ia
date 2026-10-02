import { ConfigError, ensureLocalDirectories, loadConfig } from '@aia/config';
import { createMediaStore, openDatabase } from '@aia/database';
import { DEFAULT_AUDIO_RETENTION_MS, LocalStorageAdapter, sweepOrphanAudio } from '@aia/media';
import { createLogger } from '@aia/observability';
import { createSystemClock } from '@aia/shared';

/**
 * Purge des enregistrements vocaux orphelins (docs/03 §12.1).
 *
 * Un audio orphelin est un audio que **aucun message ne référence** : un
 * enregistrement transcrit mais jamais envoyé, ou dont l'envoi a été abandonné.
 * Il est conservé le temps de la fenêtre de rétention (trente jours par défaut),
 * parce que l'utilisateur peut encore vouloir récupérer son texte — puis
 * supprimé, fichier et lignes, par `sweepOrphanAudio` (`@aia/media`).
 *
 * Deux principes :
 *
 * 1. **Rien d'irréversible par défaut.** `pnpm media:purge` ne fait que
 *    montrer ce qui serait supprimé ; il faut `--apply` pour supprimer
 *    réellement. C'est la seule commande du projet qui efface des fichiers.
 * 2. **Un audio rattaché à un message n'est jamais touché.** Le filtre est dans
 *    la requête (`usage_count = 0`) *et* dans la règle (`decideAudioPurge`) :
 *    deux verrous indépendants, parce qu'une erreur ici détruirait la preuve de
 *    ce qui a été publié.
 *
 * Usage :
 *   pnpm media:purge                          # simulation, valeurs par défaut
 *   pnpm media:purge --apply                  # suppression réelle
 *   pnpm media:purge -- --apply --retention-days=7 --limit=500
 */

interface Options {
  apply: boolean;
  retentionDays: number;
  limit: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    apply: argv.includes('--apply'),
    retentionDays: DEFAULT_AUDIO_RETENTION_MS / 86_400_000,
    limit: 200,
  };

  for (const arg of argv) {
    const retention = /^--retention-days=(\d+)$/.exec(arg);
    if (retention?.[1] !== undefined) {
      options.retentionDays = Number(retention[1]);
    }
    const limit = /^--limit=(\d+)$/.exec(arg);
    if (limit?.[1] !== undefined) {
      options.limit = Number(limit[1]);
    }
  }

  if (!Number.isFinite(options.retentionDays) || options.retentionDays < 1) {
    throw new Error('--retention-days doit être un entier ≥ 1.');
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    throw new Error('--limit doit être un entier ≥ 1.');
  }
  return options;
}

async function main(): Promise<void> {
  const logger = createLogger({ level: 'info', pretty: true, name: 'media-purge' });
  const options = parseArgs(process.argv.slice(2));

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }

  ensureLocalDirectories(config);
  const handle = openDatabase({
    file: config.paths.databaseFile,
    wal: config.env.DB_WAL,
    busyTimeoutMs: config.env.DB_BUSY_TIMEOUT_MS,
  });

  const clock = createSystemClock();
  const media = createMediaStore(handle, () => clock.nowMs());
  const storage = new LocalStorageAdapter(config.paths.mediaRoot);
  const retentionMs = Math.round(options.retentionDays * 86_400_000);

  let report;
  try {
    report = await sweepOrphanAudio({
      store: media,
      storage,
      nowMs: clock.nowMs(),
      retentionMs,
      limit: options.limit,
      dryRun: !options.apply,
    });
  } finally {
    handle.close();
  }

  const summary = {
    mode: report.dryRun ? 'simulation' : 'suppression',
    retentionDays: options.retentionDays,
    examined: report.examined,
    purged: report.purged.length,
    kept: report.kept.length,
    mediaRoot: config.paths.mediaRoot,
  };

  if (report.purged.length > 0) {
    logger.info(summary, report.dryRun ? 'à supprimer (aucune modification)' : 'audios purgés');
    for (const entry of report.purged) {
      logger.info(
        { assetId: entry.assetId, storageKey: entry.storageKey },
        report.dryRun ? 'candidat' : 'supprimé',
      );
    }
  } else {
    logger.info(summary, 'aucun audio orphelin à purger');
  }

  if (report.kept.length > 0) {
    logger.info({ kept: report.kept.length }, 'audios conservés (fenêtre encore ouverte)');
  }
}

await main();
