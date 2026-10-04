/// <reference types="vite/client" />
/**
 * Types fournis par Vite (`import.meta.env`, imports d'actifs).
 *
 * Ils sont déclarés ici parce que le contrôle de types du dépôt part d'un
 * `tsconfig.json` unique à la racine : sans cette référence, `import.meta.env`
 * n'existe pas pour TypeScript, et `apps/web/src/main.tsx` ne pourrait pas
 * distinguer le développement de la production (étape 12 §21).
 */
