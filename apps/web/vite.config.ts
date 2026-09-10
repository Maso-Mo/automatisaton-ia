import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

/**
 * SPA React + Vite (docs/02 §6) : aucun besoin de rendu serveur, l'application
 * est privée et accessible en local.
 *
 * Le proxy `/api` est le point important ici : le navigateur ne connaît qu'une
 * seule origine (celle de Vite), donc **aucun CORS** n'est nécessaire en
 * développement, et le front n'a jamais accès à la base ni aux clés
 * (docs/02 §4 : `apps/web` dépend uniquement de `apps/api`).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4317',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
