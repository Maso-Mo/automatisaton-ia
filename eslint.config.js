import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Les règles qui protègent l'architecture (docs/02 §3, §5, §11) :
 *
 * 1. `packages/shared` ne dépend d'aucun autre paquet du projet.
 * 2. Un paquet d'infrastructure ne dépend jamais de `packages/core`.
 * 3. Les imports profonds (`@aia/x/src/...`) sont interdits : chaque paquet expose
 *    son `index.ts` comme seule porte d'entrée.
 * 4. `drizzle-orm` est confiné à `packages/database`.
 * 5. Seul `packages/config` lit `process.env`.
 * 6. `dangerouslySetInnerHTML` est interdit dans tout le dépôt (docs/07 §3.3).
 *
 * Le contrôle du sens des dépendances *et des cycles* est fait par
 * `scripts/check-boundaries.ts` (appelé par `pnpm verify`) : ESLint ne peut pas
 * détecter un cycle sans résolveur de modules supplémentaire, et le script est
 * testable et sans dépendance.
 */

const DANGEROUS_HTML = {
  selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
  message:
    "Interdit dans tout le dépôt (docs/07 §3.3) : le contenu affiché vient d'un modèle et ne doit jamais être exécuté.",
};

const PROCESS_ENV = {
  selector: 'MemberExpression[object.name="process"][property.name="env"]',
  message: 'Seul packages/config lit process.env (docs/02 §11).',
};

const NO_DEEP_IMPORT = {
  group: ['**/src/**', '**/src', '**/migrations/**'],
  message:
    "Import profond interdit : chaque paquet expose son index.ts comme seule porte d'entrée (docs/02 §3).",
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'data/**',
      'coverage/**',
      'packages/database/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': ['error', DANGEROUS_HTML, PROCESS_ENV],
      'no-restricted-imports': ['error', { patterns: [NO_DEEP_IMPORT] }],
    },
  },
  // 3 + 4. Drizzle est confiné au paquet de persistance ; les imports profonds
  // restent interdits pour tout le monde.
  {
    files: ['packages/database/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [NO_DEEP_IMPORT] }],
    },
  },
  // 1. `shared` n'a aucune dépendance interne.
  {
    files: ['packages/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_DEEP_IMPORT,
            {
              group: ['@aia/*', 'drizzle-orm', 'drizzle-orm/*', 'fastify', 'pino'],
              message:
                'packages/shared ne dépend d’aucun autre paquet du projet et ne connaît aucune infrastructure (docs/02 §5).',
            },
          ],
        },
      ],
    },
  },
  // 2. Un paquet d'infrastructure ne dépend jamais du domaine.
  {
    files: [
      'packages/database/**/*.ts',
      'packages/queue/**/*.ts',
      'packages/ai/**/*.ts',
      'packages/analytics/**/*.ts',
      'packages/observability/**/*.ts',
      'packages/media/**/*.ts',
      'packages/news/**/*.ts',
      'packages/publishing/**/*.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            NO_DEEP_IMPORT,
            {
              group: ['@aia/core'],
              message:
                'Un paquet d’infrastructure ne dépend jamais de packages/core (docs/02 §5) : le domaine définit les ports, l’infrastructure les implémente.',
            },
          ],
        },
      ],
    },
  },
  // 5. `process.env` est autorisé au point de passage unique, dans les outils de
  // ligne de commande (qui s'exécutent avant tout chargement de configuration) et
  // dans les tests (qui doivent simuler un environnement absent ou invalide).
  {
    files: [
      'packages/config/**/*.ts',
      'scripts/**/*.ts',
      'tests/**/*.ts',
      '**/*.test.ts',
      'drizzle.config.ts',
      'vitest.config.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', DANGEROUS_HTML],
    },
  },
  // Les journaux de ligne de commande sont la sortie prévue des scripts et des
  // points d'entrée de processus (le produit journalise via @aia/observability).
  {
    files: [
      'scripts/**/*.ts',
      'apps/api/src/main.ts',
      'apps/worker/src/main.ts',
      'apps/worker/src/enqueue-noop.ts',
      'tests/**/*.ts',
      '**/*.test.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  // Les tests et les scripts d'outillage peuvent importer l'intérieur des
  // applications : les `apps/*` n'exposent pas d'`index.ts` (ce ne sont pas des
  // paquets). Le sens des dépendances, lui, reste contrôlé par
  // `scripts/check-boundaries.ts` sur les paquets et applications.
  {
    files: ['tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    ignores: ['**/*.js', '**/*.cjs', '**/*.mjs'],
  },
);
