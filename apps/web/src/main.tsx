import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

/**
 * État serveur : TanStack Query (docs/02 §6). Le serveur est la source de vérité,
 * le cache et les états de chargement sont gérés par la librairie — pas à la main.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 2_000,
    },
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Élément #root introuvable dans index.html');
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

/**
 * Service worker (étape 12 §21) : **uniquement en production**.
 *
 * En développement, un cache de coquille servirait un `index.html` périmé et
 * ferait croire à un bug de l'application alors qu'il n'y en a pas. Hors ligne,
 * l'application s'ouvre ; elle reste inutilisable sans API — c'est voulu, les
 * données ne sont jamais inventées côté navigateur.
 *
 * Un échec d'enregistrement n'est pas une panne : l'application fonctionne sans
 * (mode privé, navigateur ancien, service worker désactivé). On ne le signale
 * donc pas à l'écran — ce serait inquiéter pour rien — et on n'écrit pas dans la
 * console, qui n'est pas un canal d'alerte du produit.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}
