import type { ErrorCategory } from '@aia/shared';

/** Catégorie d'erreur → statut HTTP (docs/02 §12). Une seule table, deux usages. */
export const CATEGORY_TO_STATUS: Record<ErrorCategory, number> = {
  validation: 400,
  auth: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  transient: 503,
  budget: 429,
  capability: 501,
  ambiguous: 409,
  internal: 500,
};
