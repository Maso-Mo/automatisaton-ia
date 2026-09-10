import { z } from 'zod';
import { APP_ENVS, ASR_ENGINES, LLM_PROVIDER_IDS, LOG_LEVELS, STORAGE_DRIVERS } from '@aia/shared';

/**
 * `packages/config` est le **seul** endroit du dépôt qui lit `process.env`
 * (docs/02 §11). Il valide tout avec Zod et expose un objet typé.
 * « Une variable manquante ou malformée = erreur au démarrage, pas au milieu
 * d'un job. »
 *
 * Résolution des deux tensions du corpus documentaire, écrite ici pour ne pas
 * être redécouverte :
 *
 * 1. `docs/02 §11` dit qu'une clé IA absente **ne bloque pas** le démarrage
 *    (l'application démarre, les appels échouent en `MissingCredentialError`),
 *    tandis que le critère de sortie de l'étape 1 (`docs/10 §4.1`) exige que
 *    « l'application refuse de démarrer si une clé requise manque ».
 *    → Sont **requises** les clés cryptographiques, sans lesquelles rien de
 *      fiable ne peut être fait plus tard : `SESSION_SECRET`, `ENCRYPTION_KEY`.
 *    → Les clés IA et plateformes restent **optionnelles** : leur présence est
 *      exposée en booléen, et on n'écrit jamais leur valeur (docs/07 §4.3).
 * 2. Le mot « clé requise » ne désigne donc jamais une clé de fournisseur.
 */

const emptyToUndefined = (value: unknown): unknown =>
  value === '' || value === undefined || value === null ? undefined : value;

/** Nombre entier lu depuis l'environnement, avec bornes et valeur par défaut. */
function integer(options: { default: number; min: number; max: number; label: string }) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce
      .number({ error: `${options.label} doit être un nombre entier` })
      .int(`${options.label} doit être un nombre entier`)
      .min(options.min, `${options.label} doit être supérieur ou égal à ${options.min}`)
      .max(options.max, `${options.label} doit être inférieur ou égal à ${options.max}`)
      .default(options.default),
  );
}

/** Texte optionnel : une variable présente mais vide vaut « absente ». */
function optionalText(maxLength = 1_000) {
  return z.preprocess(emptyToUndefined, z.string().max(maxLength).optional());
}

const BOOLEAN_VALUES = ['true', 'false', '1', '0', 'yes', 'no', 'oui', 'non'] as const;
const TRUE_VALUES = new Set<string>(['true', '1', 'yes', 'oui']);

function flag(defaultValue: boolean, label: string) {
  return z
    .enum(BOOLEAN_VALUES, { error: `${label} doit valoir true ou false` })
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => TRUE_VALUES.has(value));
}

export const envSchema = z.object({
  // --- Application
  APP_ENV: z.enum(APP_ENVS).default('development'),
  APP_HOST: z
    .string()
    .default('127.0.0.1')
    .refine(
      (host) => host !== '0.0.0.0' && host !== '::' && host !== '*',
      'APP_HOST ne peut pas écouter sur toutes les interfaces : 0.0.0.0 exposerait tous les jetons de publication au réseau local (docs/07 §3.1). Utiliser 127.0.0.1.',
    ),
  APP_PORT: integer({ default: 4317, min: 1, max: 65_535, label: 'APP_PORT' }),
  APP_URL: z.string().default('http://127.0.0.1:4317'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  LOG_PRETTY: flag(true, 'LOG_PRETTY'),

  // --- Base
  DATABASE_URL: z.string().default('file:./data/app.db'),
  DB_WAL: flag(true, 'DB_WAL'),
  DB_BUSY_TIMEOUT_MS: integer({
    default: 5_000,
    min: 0,
    max: 120_000,
    label: 'DB_BUSY_TIMEOUT_MS',
  }),

  // --- Stockage
  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default('local'),
  MEDIA_ROOT: z.string().default('data/media'),
  MEDIA_MAX_UPLOAD_MB: integer({
    default: 512,
    min: 1,
    max: 20_480,
    label: 'MEDIA_MAX_UPLOAD_MB',
  }),
  S3_ENDPOINT: optionalText(),
  S3_REGION: optionalText(64),
  S3_BUCKET: optionalText(200),
  S3_ACCESS_KEY_ID: optionalText(),
  S3_SECRET_ACCESS_KEY: optionalText(),

  // --- IA
  LLM_DEFAULT_PROVIDER: z.enum(LLM_PROVIDER_IDS).default('deepseek'),
  LLM_MODEL_LIGHT: optionalText(120),
  LLM_MODEL_STANDARD: optionalText(120),
  DEEPSEEK_API_KEY: optionalText(),
  OPENROUTER_API_KEY: optionalText(),
  OPENAI_API_KEY: optionalText(),
  ANTHROPIC_API_KEY: optionalText(),
  GEMINI_API_KEY: optionalText(),
  OLLAMA_BASE_URL: z.string().default('http://127.0.0.1:11434'),

  // --- Transcription
  ASR_ENGINE: z.enum(ASR_ENGINES).default('whisper_cpp'),
  WHISPER_BIN: z.string().default('whisper-cli'),
  WHISPER_MODEL_PATH: z.string().default('data/models/ggml-small.bin'),

  // --- Vidéo
  FFMPEG_BIN: z.string().default('ffmpeg'),
  FFPROBE_BIN: z.string().default('ffprobe'),

  // --- Plateformes
  LINKEDIN_CLIENT_ID: optionalText(),
  LINKEDIN_CLIENT_SECRET: optionalText(),
  REDDIT_CLIENT_ID: optionalText(),
  REDDIT_CLIENT_SECRET: optionalText(),
  TIKTOK_CLIENT_KEY: optionalText(),
  TIKTOK_CLIENT_SECRET: optionalText(),

  // --- Budget (docs/08 §8.1)
  MONTHLY_BUDGET_USD: z.coerce.number().min(0).max(100_000).default(5),
  DAILY_BUDGET_USD: z.coerce.number().min(0).max(100_000).default(1),
  DAILY_TOKEN_LIMIT: integer({
    default: 2_000_000,
    min: 1_000,
    max: 100_000_000,
    label: 'DAILY_TOKEN_LIMIT',
  }),
  REQUIRE_APPROVAL_ABOVE_USD: z.coerce.number().min(0).max(100_000).default(0),

  // --- Sécurité : les deux seules clés exigées au démarrage
  SESSION_SECRET: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: 'SESSION_SECRET est obligatoire' })
      .min(32, 'SESSION_SECRET doit faire au moins 32 caractères'),
  ),
  ENCRYPTION_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string({ error: 'ENCRYPTION_KEY est obligatoire' })
      .regex(
        /^[0-9a-fA-F]{64}$/,
        'ENCRYPTION_KEY doit contenir 64 caractères hexadécimaux (32 octets)',
      ),
  ),

  // --- File de jobs (docs/08 §2.3)
  QUEUE_CONCURRENCY: integer({ default: 3, min: 1, max: 10, label: 'QUEUE_CONCURRENCY' }),
  WORKER_POLL_MS: integer({ default: 60_000, min: 250, max: 600_000, label: 'WORKER_POLL_MS' }),
  JOB_LEASE_MS: integer({ default: 60_000, min: 5_000, max: 3_600_000, label: 'JOB_LEASE_MS' }),
  JOB_HEARTBEAT_MS: integer({
    default: 10_000,
    min: 500,
    max: 300_000,
    label: 'JOB_HEARTBEAT_MS',
  }),
  OFFLINE_MODE: flag(false, 'OFFLINE_MODE'),

  // --- Chemins
  PROMPTS_DIR: z.string().default('prompts'),
});

export type Env = z.infer<typeof envSchema>;

/** Toutes les variables connues — sert au test de parité avec `.env.example`. */
export const ENV_KEYS = Object.keys(envSchema.shape) as (keyof Env)[];

/** Variables secrètes : la valeur ne doit jamais apparaître dans un journal, même tronquée. */
export const SECRET_ENV_KEYS = [
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'LINKEDIN_CLIENT_SECRET',
  'REDDIT_CLIENT_SECRET',
  'TIKTOK_CLIENT_SECRET',
] as const satisfies readonly (keyof Env)[];

/** Variables exigées au démarrage : leur absence arrête le processus (docs/10 §4.1). */
export const REQUIRED_ENV_KEYS = [
  'SESSION_SECRET',
  'ENCRYPTION_KEY',
] as const satisfies readonly (keyof Env)[];

/** Message d'aide affiché avec une erreur de configuration. */
export const CONFIG_HELP = [
  'Copier `.env.example` en `.env`, puis générer les deux clés cryptographiques :',
  '  openssl rand -hex 32   # SESSION_SECRET',
  '  openssl rand -hex 32   # ENCRYPTION_KEY',
].join('\n');
