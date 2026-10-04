/**
 * Masquage des secrets dans les adresses (étape 12 §22).
 *
 * `EventSource` (SSE) et les balises `<img>`/`<video>` ne peuvent pas porter
 * d'en-tête `Authorization` : le jeton d'accès peut donc arriver en **paramètre
 * d'URL**. Une URL journalisée est une URL relue, copiée, collée dans un ticket —
 * le jeton doit disparaître avant l'écriture, dans **tous** les journaux, pas
 * seulement dans celui du filtre de sécurité.
 */
export function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/gi, '$1***');
}
