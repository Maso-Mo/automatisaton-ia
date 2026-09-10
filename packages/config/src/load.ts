import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import dotenv from 'dotenv';
import { ConfigError } from '@aia/shared';
import { CONFIG_HELP, SECRET_ENV_KEYS, envSchema, type Env } from './env';

export interface Paths {
  /** Racine du dépôt (ou du déploiement) : tous les chemins relatifs partent d'ici. */
  root: string;
  dataDir: string;
  databaseFile: string;
  mediaRoot: string;
  promptsDir: string;
}

/**
 * Racine du monorepo : le premier dossier ancêtre qui contient
 * `pnpm-workspace.yaml`.
 *
 * Sans cela, `pnpm dev:worker` (exécuté depuis `apps/worker`) chercherait `.env`
 * et `data/app.db` **dans le dossier de l'application** : l'application refuserait
 * de démarrer (clés absentes) et, pire, créerait une base par application. La
 * racine doit être une propriété du dépôt, pas du répertoire courant.
 */
export function findWorkspaceRoot(startDir: string = process.cwd(), maxDepth = 12): string {
  let current = resolve(startDir);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(startDir);
}

export interface Config {
  env: Env;
  paths: Paths;
  /** Clé AES-256-GCM prête à l'emploi (32 octets), jamais journalisée. */
  encryptionKey: Buffer;
  /** Présence des variables secrètes : on écrit le nom, jamais la valeur (docs/07 §4.3). */
  secretPresence: Record<(typeof SECRET_ENV_KEYS)[number], boolean>;
}

export interface LoadConfigOptions {
  /** Environnement à valider. Par défaut `process.env`. */
  source?: NodeJS.ProcessEnv;
  /** Chemin du fichier `.env`, ou `null` pour n'en charger aucun (tests). */
  dotenvPath?: string | null;
  /** Racine utilisée pour résoudre les chemins relatifs. Par défaut le dossier courant. */
  rootDir?: string;
}

interface IssueLike {
  path: ReadonlyArray<string | number | symbol>;
  message: string;
}

export function formatConfigIssues(issues: readonly IssueLike[]): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.map(String).join('.') : '(racine)';
    return `${path} : ${issue.message}`;
  });
}

function databaseFileFrom(url: string, root: string): string {
  if (url === ':memory:' || url.includes(':memory:')) {
    // Base en mémoire : uniquement pour les tests les plus courts.
    return ':memory:';
  }
  const withoutScheme = url.startsWith('file:') ? url.slice('file:'.length) : url;
  return isAbsolute(withoutScheme) ? withoutScheme : resolve(root, withoutScheme);
}

/**
 * Charge, valide et expose la configuration.
 *
 * Refuse de démarrer si une variable requise manque ou si une valeur est
 * incohérente : l'erreur arrive au démarrage, avec la commande à exécuter —
 * jamais au milieu d'un job.
 */
export function loadConfig(options: LoadConfigOptions = {}): Config {
  // `resolve` normalise le chemin : `paths.root` est utilisé tel quel dans les
  // journaux et les comparaisons, il ne doit pas porter de barre oblique finale.
  const root = resolve(options.rootDir ?? findWorkspaceRoot());

  if (options.dotenvPath !== null) {
    dotenv.config({ path: options.dotenvPath ?? resolve(root, '.env'), quiet: true });
  }

  const raw: NodeJS.ProcessEnv = { ...process.env, ...(options.source ?? {}) };
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const details = formatConfigIssues(parsed.error.issues);
    throw new ConfigError(
      ['Configuration invalide :', ...details.map((line) => `  • ${line}`), CONFIG_HELP].join('\n'),
      { details: { issues: details } },
    );
  }

  const env = parsed.data;
  const dataDir = resolve(root, 'data');
  const paths: Paths = {
    root,
    dataDir,
    databaseFile: databaseFileFrom(env.DATABASE_URL, root),
    mediaRoot: isAbsolute(env.MEDIA_ROOT) ? env.MEDIA_ROOT : resolve(root, env.MEDIA_ROOT),
    promptsDir: isAbsolute(env.PROMPTS_DIR) ? env.PROMPTS_DIR : resolve(root, env.PROMPTS_DIR),
  };

  const secretPresence = Object.fromEntries(
    SECRET_ENV_KEYS.map((key) => {
      const value = env[key];
      return [key, typeof value === 'string' && value.length > 0];
    }),
  ) as Config['secretPresence'];

  return {
    env,
    paths,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    secretPresence,
  };
}

/** Crée les dossiers locaux nécessaires (base, médias). Idempotent. */
export function ensureLocalDirectories(config: Config): void {
  if (config.paths.databaseFile !== ':memory:') {
    mkdirSync(dirname(config.paths.databaseFile), { recursive: true });
  }
  mkdirSync(config.paths.mediaRoot, { recursive: true });
}

/**
 * Résumé sûr pour les journaux de démarrage : les **noms** des variables
 * présentes, jamais leur valeur, même tronquée (docs/07 §4.3).
 */
export function describeConfig(config: Config): string[] {
  const lines = [
    `APP_ENV=${config.env.APP_ENV}`,
    `écoute=${config.env.APP_HOST}:${config.env.APP_PORT}`,
    `base=${config.paths.databaseFile}`,
    `stockage=${config.env.STORAGE_DRIVER}`,
    `fournisseur IA par défaut=${config.env.LLM_DEFAULT_PROVIDER}`,
    `budget=${config.env.DAILY_BUDGET_USD} $/jour, ${config.env.MONTHLY_BUDGET_USD} $/mois`,
  ];
  for (const key of SECRET_ENV_KEYS) {
    lines.push(`${key}: ${config.secretPresence[key] ? 'présent' : 'absent'}`);
  }
  return lines;
}
