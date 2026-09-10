import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Contrôle des frontières d'architecture (docs/02 §3, §5).
 *
 * ESLint couvre déjà les imports interdits au cas par cas ; ce script vérifie ce
 * qu'une règle d'import ne voit pas : le **sens global des dépendances** et
 * l'absence de **cycle**. Il tourne dans `pnpm verify`.
 *
 * « Un monolithe modulaire dérive naturellement en monolithe désordonné si les
 * frontières ne sont pas activement défendues. »
 */

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'data',
  'coverage',
  'migrations',
  '.husky',
  '.pnpm-store',
]);

const INFRA_PACKAGES = new Set([
  'database',
  'queue',
  'ai',
  'analytics',
  'observability',
  'media',
  'news',
  'publishing',
]);

const APP_NAMES = new Set(['api', 'worker', 'web']);

interface SourceFile {
  relPath: string;
  /** `packages/x`, `apps/y`, `scripts`, `tests` ou `racine`. */
  owner: string;
  content: string;
  imports: string[];
}

function listSourceFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (SKIP_DIRS.has(entry)) continue;
      const absolute = join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(absolute);
    }
  };

  walk(ROOT);
  return found;
}

function extractImports(content: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function ownerOf(relPath: string): string {
  const parts = relPath.split('/');
  if (parts[0] === 'packages' || parts[0] === 'apps') return `${parts[0]}/${parts[1] ?? ''}`;
  if (parts[0] === 'scripts' || parts[0] === 'tests') return parts[0];
  return 'racine';
}

function targetOwnerOf(targetName: string): string {
  return APP_NAMES.has(targetName) ? `apps/${targetName}` : `packages/${targetName}`;
}

function findCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    if (stack.includes(node)) {
      cycles.push([...stack.slice(stack.indexOf(node)), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
  };

  for (const node of graph.keys()) visit(node);
  return cycles;
}

function main(): void {
  const files: SourceFile[] = listSourceFiles().map((absolute) => {
    const relPath = relative(ROOT, absolute).split(sep).join('/');
    const content = readFileSync(absolute, 'utf8');
    return { relPath, owner: ownerOf(relPath), content, imports: extractImports(content) };
  });

  const violations: string[] = [];
  const add = (file: string, rule: string, detail: string): void => {
    violations.push(`${file}\n     ${rule} : ${detail}`);
  };
  const graph = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string): void => {
    if (!graph.has(from)) graph.set(from, new Set());
    graph.get(from)?.add(to);
  };

  for (const file of files) {
    const ownerName = file.owner.split('/')[1] ?? '';
    for (const specifier of file.imports) {
      if (/^drizzle-orm/.test(specifier) && file.owner !== 'packages/database') {
        add(file.relPath, 'Drizzle confiné', `${specifier} hors de packages/database`);
        continue;
      }

      const match = /^@aia\/([a-z-]+)/.exec(specifier);
      if (!match) continue;
      const targetName = match[1] ?? '';
      const targetOwner = targetOwnerOf(targetName);

      // 1. Imports profonds interdits : chaque paquet expose son index.ts.
      if (specifier !== `@aia/${targetName}`) {
        add(
          file.relPath,
          'Import profond',
          `${specifier} — utiliser @aia/${targetName} (seule porte d'entrée)`,
        );
      }

      // 2. `shared` n'a aucune dépendance interne.
      if (file.owner === 'packages/shared') {
        add(file.relPath, 'packages/shared isolé', `dépend de ${specifier}`);
      }

      // 3. Un paquet d'infrastructure ne dépend jamais du domaine.
      if (
        file.owner.startsWith('packages/') &&
        INFRA_PACKAGES.has(ownerName) &&
        targetName === 'core'
      ) {
        add(file.relPath, 'Infrastructure → domaine', `${file.owner} importe @aia/core`);
      }

      // 4. Un paquet ne dépend jamais d'une application.
      if (file.owner.startsWith('packages/') && APP_NAMES.has(targetName)) {
        add(file.relPath, 'Paquet → application', `${file.owner} importe @aia/${targetName}`);
      }

      // 5. Une application ne dépend pas d'une autre application.
      if (file.owner.startsWith('apps/') && APP_NAMES.has(targetName) && ownerName !== targetName) {
        add(file.relPath, 'Application → application', `${file.owner} importe @aia/${targetName}`);
      }

      if (file.owner.startsWith('packages/') || file.owner.startsWith('apps/')) {
        addEdge(file.owner, targetOwner);
      }
    }

    // 6. `process.env` : seul `packages/config` y accède.
    const allowedEnv =
      file.owner === 'packages/config' ||
      file.owner === 'scripts' ||
      file.owner === 'tests' ||
      file.relPath.endsWith('.config.ts');
    if (!allowedEnv && /process\.env/.test(file.content)) {
      add(file.relPath, 'process.env', 'seul packages/config lit process.env (docs/02 §11)');
    }
  }

  // 7. Cycles dans le graphe des paquets et applications.
  for (const cycle of findCycles(graph)) {
    violations.push(`cycle de dépendances détecté\n     ${cycle.join(' → ')}`);
  }

  // 8. Chaque paquet expose bien son point d'entrée.
  for (const packageName of graph.keys()) {
    if (!packageName.startsWith('packages/')) continue;
    try {
      statSync(join(ROOT, packageName, 'src', 'index.ts'));
    } catch {
      violations.push(`${packageName}\n     Point d'entrée manquant : src/index.ts`);
    }
  }

  if (violations.length > 0) {
    console.error(`❌ ${violations.length} violation(s) de frontières :\n`);
    for (const violation of violations) console.error(`  • ${violation}\n`);
    process.exit(1);
  }

  console.log(
    `✅ frontières respectées — ${files.length} fichiers analysés, ${graph.size} paquets/applications, aucun cycle`,
  );
}

main();
