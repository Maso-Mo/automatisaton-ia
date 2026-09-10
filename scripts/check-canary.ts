import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { createLogger, runWithLogContext } from '@aia/observability';
import { describeConfig, loadConfig, redact, type Config } from '@aia/config';

/**
 * Test **canari** : « aucun secret dans les journaux » (docs/07 §4.2, §9).
 *
 * Il écrit volontairement des secrets par tous les chemins de journalisation
 * existants — message, champ nommé, erreur, contexte, puis il relit le fichier.
 * Un seul oubli de rédaction suffit à écrire un jeton en clair : c'est le test
 * qui échoue à chaque nouveau chemin ajouté.
 */

const FAKE_SECRETS = [
  'sk-proj-canari-abcdefghijklmnopqrstuvwxyz012345',
  'sk-ant-api03-canari-abcdefghijklmnopqrstuvwxyz',
  'AIzaSyCanari1234567890abcdefghijklmnopqrstu',
  'eyJhbGciOiJIUzI1NiJ9.eyJjYW5hcmkiOiJ0cnVlIn0.canari-signature',
  'f'.repeat(64),
];

function main(): void {
  const directory = mkdtempSync(join(tmpdir(), 'aia-canary-'));
  const file = join(directory, 'canary.log');

  const config: Config | null = (() => {
    try {
      return loadConfig();
    } catch {
      return null;
    }
  })();

  const stream = createWriteStream(file, { flags: 'w' });
  const logger = createLogger({
    level: 'trace',
    pretty: false,
    name: 'canary',
    destination: stream,
  });

  runWithLogContext({ jobId: 'job-canari', task: 'canary', step: 'llm_call' }, () => {
    logger.info({ DEEPSEEK_API_KEY: FAKE_SECRETS[0] }, `appel avec ${FAKE_SECRETS[0]}`);
    logger.warn({ nested: { authorization: `Bearer ${FAKE_SECRETS[3]}` } }, 'en-tête transmis');
    logger.error(
      { err: new Error(`échec avec ${FAKE_SECRETS[2]}`), apiKey: FAKE_SECRETS[1] },
      'erreur du fournisseur',
    );
    logger.debug({ env: { ENCRYPTION_KEY: FAKE_SECRETS[4] } }, 'configuration');
  });

  // Le résumé de configuration passe par le même point de rédaction.
  if (config) {
    logger.info(redact({ summary: describeConfig(config) }), 'résumé de démarrage');
  }

  // Il faut attendre la fin de l'écriture disque : pino écrit de façon asynchrone.
  stream.end(() => {
    verify(file, directory);
  });
}

function verify(file: string, directory: string): void {
  const content = readFileSync(file, 'utf8');
  const leaked = FAKE_SECRETS.filter((secret) => content.includes(secret));
  rmSync(directory, { recursive: true, force: true });

  if (leaked.length > 0) {
    console.error(`❌ ${leaked.length} secret(s) présent(s) en clair dans le journal :`);
    for (const secret of leaked) {
      console.error(`   ${secret.slice(0, 12)}…`);
    }
    process.exit(1);
  }

  const redactedCount = (content.match(/\[REDACTED\]/g) ?? []).length;
  const lines = content.split('\n').filter((line) => line.trim().length > 0).length;
  console.log(
    `✅ aucun secret dans les journaux — ${redactedCount} substitution(s), ${lines} ligne(s) écrite(s)`,
  );
}

main();
