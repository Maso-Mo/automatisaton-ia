import type { ZodType } from 'zod';

/**
 * JSON : colonnes `TEXT` contenant du JSON valide, préfixées `_json`
 * (docs/03 §2.5). « Chaque colonne JSON possède un schéma Zod dans le code. Le
 * JSON est un moyen de stockage, pas une excuse pour ne pas typer. »
 *
 * On ne lève jamais d'exception à la lecture de la base : on renvoie un résultat
 * typé, à charge de l'appelant de décider (traitement en erreur `internal` ou
 * valeur par défaut).
 */

export type JsonDecodeResult<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function decodeJson<T>(
  schema: ZodType<T>,
  raw: string | null | undefined,
  label = 'json',
): JsonDecodeResult<T> {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, issues: [`${label} : valeur absente`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [`${label} : JSON illisible (${message})`] };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, value: result.data };
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : label;
      return `${path} : ${issue.message}`;
    }),
  };
}

/** Sérialise une valeur destinée à une colonne `_json`. */
export function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Valeur non sérialisable en JSON');
  }
  return encoded;
}

export function parseJsonUnknown(raw: string): JsonDecodeResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, issues: [`JSON illisible (${message})`] };
  }
}
