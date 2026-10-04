/**
 * Jeton d'accès local (étape 12 §22).
 *
 * L'application n'a **pas** d'utilisateurs : elle est mono-utilisateur et locale
 * (docs/01). Quand on l'expose au-delà de `localhost` (téléphone sur le Wi-Fi,
 * tunnel Tailscale), il faut une barrière ; le produit en a choisi une seule, et
 * la plus simple : un jeton partagé, vérifié par l'API (`AUTH_TOKEN`).
 *
 * Il vit dans `localStorage` — et c'est un choix assumé : ce n'est pas un
 * identifiant de session mais un secret de périmètre, sur une machine que
 * l'utilisateur contrôle. Il permet aux `<img>` et `<video>` d'appeler
 * `/media/.../file` **sans** bricoler d'en-tête dans l'URL, ce qu'un cookie ne
 * permettrait pas avec un `fetch` cross-origin.
 *
 * Module isolé pour une raison pratique : le jeton ne doit jamais sortir d'ici
 * (ni journal, ni message d'erreur, ni état React affiché).
 */

const STORAGE_KEY = 'aia.authToken';

function readStored(): string {
  // `window` est absent hors navigateur (tests unitaires en environnement node).
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    // Navigation privée avec stockage refusé : l'application reste utilisable en
    // local, seule l'exposition distante est impossible.
    return '';
  }
}

let token = readStored();

/** Le jeton courant, ou `''` si l'API n'en demande pas. */
export function getAuthToken(): string {
  return token;
}

/** Mémorise (`''` efface) le jeton. Un jeton n'est jamais renvoyé par cette API. */
export function setAuthToken(value: string): void {
  token = value.trim();
  if (typeof window === 'undefined') return;
  try {
    if (token === '') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Le jeton reste en mémoire pour la session en cours : dégradation, pas échec.
  }
}

/** Indique seulement si un jeton est mémorisé — jamais sa valeur. */
export function hasAuthToken(): boolean {
  return token !== '';
}
