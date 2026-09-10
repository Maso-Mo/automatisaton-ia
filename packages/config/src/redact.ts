/**
 * Rédaction des secrets, **au point de passage unique** (docs/07 §2, §8) :
 * appelée par le journal, le client HTTP et le journal des appels LLM.
 * « Un seul oubli de rédaction suffit à écrire un jeton dans un log. »
 *
 * Le test canari (`scripts/check-canary.ts`, `pnpm check:canary`) échoue si un
 * secret traverse cette fonction sans être masqué.
 */

export const REDACTED = '[REDACTED]';

/** Noms de champs qui contiennent un secret par convention. */
const SECRET_KEY_PATTERN =
  /(api[_-]?key|secret|token|password|passwd|pwd|authorization|cookie|session|credential|private[_-]?key|access[_-]?key|encryption)/i;

/**
 * Motifs de valeurs secrètes reconnues, appliqués au texte libre.
 *
 * Le motif hexadécimal long (≥ 64) masque aussi les empreintes SHA-256 : c'est
 * une **sur-rédaction volontaire**. Un hash masqué dans un journal est une
 * gêne ; une clé qui fuit est un incident.
 */
const VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b[A-Fa-f0-9]{64,}\b/g,
];

export function redactString(value: string): string {
  let output = value;
  for (const pattern of VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Masque une valeur si son nom ressemble à un secret ou si son contenu en contient un. */
export function redactValue(key: string, value: unknown): unknown {
  if (isSecretKey(key)) return REDACTED;
  return redact(value);
}

/** Profondeur maximale explorée : au-delà, on journalise un marqueur, jamais un objet géant. */
export const MAX_REDACT_DEPTH = 6;

const CIRCULAR = '[référence circulaire]';
const TOO_DEEP = '[profondeur maximale atteinte]';

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Rédaction récursive d'une structure quelconque (journaux, erreurs, JSON).
 *
 * Trois garde-fous indispensables en production, chacun appris d'un crash réel :
 * - **références circulaires** : `JSON` d'une requête HTTP, objet Fastify, etc. ;
 * - **profondeur bornée** : un objet de 40 niveaux ne doit pas produire 40 niveaux de log ;
 * - **objets non simples** (`Buffer`, `Request`, client HTTP) : on écrit le nom du type,
 *   pas le contenu — un journal n'a rien à faire d'un objet de transport.
 */
export function redact<T>(input: T): T {
  return redactInternal(input, new WeakSet<object>(), MAX_REDACT_DEPTH) as T;
}

function redactInternal(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object' || value === null) return value;

  if (value instanceof Date) return value;
  if (value instanceof Error) return redactErrorMessage(value);
  if (value instanceof RegExp || value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value))
    return `[${value.constructor.name} de ${String((value as { length?: number }).length ?? '?')} octets]`;

  if (depth <= 0) return TOO_DEEP;
  if (seen.has(value)) return CIRCULAR;

  if (Array.isArray(value)) {
    seen.add(value);
    const output = value.map((item) => redactInternal(item, seen, depth - 1));
    seen.delete(value);
    return output;
  }

  if (!isPlainObject(value)) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? 'objet';
    return `[${name}]`;
  }

  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = redactValueInternal(key, item, seen, depth);
  }
  seen.delete(value);
  return output;
}

function redactValueInternal(
  key: string,
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (isSecretKey(key)) return REDACTED;
  return redactInternal(value, seen, depth - 1);
}

function redactErrorMessage(error: Error): Error {
  const message = redactString(error.message);
  // La trace de pile contient le message : la rédiger aussi est indispensable,
  // sinon le secret fuit par la pile (détecté par `pnpm check:canary`).
  const stack = typeof error.stack === 'string' ? redactString(error.stack) : undefined;
  if (message === error.message && (stack === error.stack || stack === undefined)) return error;

  const clone = new Error(message);
  clone.name = error.name;
  if (stack !== undefined) clone.stack = stack;
  return clone;
}
