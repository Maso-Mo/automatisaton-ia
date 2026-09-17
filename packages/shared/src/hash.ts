import { createHash } from 'node:crypto';

/**
 * Empreinte d'un texte destiné à être **comparé**, jamais affiché.
 *
 * Normalisation avant hachage : espaces multiples et fins de ligne ne doivent pas
 * produire deux empreintes différentes pour le même contenu (un copier-coller
 * depuis un éditeur change les `\n`). La casse et la ponctuation, elles, sont
 * conservées : elles changent le texte.
 *
 * Sert au champ `content_hash` des versions (docs/03 §9.2) — détecter qu'une
 * régénération a rendu le même texte, et retrouver les doublons — et à
 * l'empreinte des erreurs (`fingerprint`, docs/03 §14.5), qui doit être
 * indépendante des identifiants et des horodatages.
 */
export function hashText(value: string): string {
  const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Empreinte d'un incident, stable entre deux occurrences du **même** problème.
 *
 * On ne hache que ce qui identifie la cause : le type, le message normalisé (les
 * chiffres variables — identifiants, durées — sont remplacés, sinon chaque
 * occurrence produirait une empreinte différente et le regroupement ne servirait
 * à rien) et l'origine. Ni identifiant, ni horodatage, ni contexte.
 */
export function hashErrorFingerprint(input: {
  errorType: string;
  message: string;
  surface: string;
  origin?: string | null;
}): string {
  const normalizedMessage = input.message
    .normalize('NFC')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return hashText(
    [input.errorType, normalizedMessage, input.surface, input.origin ?? ''].join('|'),
  );
}
