import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  root: 'client',
  publicDir: false,
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    // In dev the API + WebSocket live on the Express process; in prod Express
    // serves the built client itself, so there is only ever one origin.
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true },
      '/api': { target: 'http://localhost:3000' },
      '/card': { target: 'http://localhost:3000' },
    },
  },
});
