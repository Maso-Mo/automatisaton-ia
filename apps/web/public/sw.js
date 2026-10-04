/*
 * Service worker minimal (étape 12 §21).
 *
 * Il ne fait qu'une chose : permettre d'**ouvrir l'application quand le réseau
 * local est absent** (API éteinte, tunnel coupé). Trois règles, et pas une de
 * plus :
 *
 * 1. `/api/**` n'est **jamais** mis en cache — une donnée mise en cache serait
 *    une donnée périmée affichée comme vraie ;
 * 2. réseau d'abord : le cache n'est qu'un repli hors ligne ;
 * 3. la coquille de l'application est pré-cachée, ses ressources étant
 *    empreintes par Vite (un nom de fichier change quand son contenu change).
 *
 * Un déploiement ne peut donc pas servir un `index.html` ancien avec des
 * ressources disparues : le réseau gagne dès qu'il répond.
 */

const CACHE = 'aia-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached ?? caches.match('/index.html'))),
  );
});
