import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// Until the Rust HTTP server exists (Phase 4), answer API calls with an error instead of letting
// the SPA fallback serve index.html as if it were JSON, in `vite` and `vite preview` alike.
// Phase 4 replaces this with a proxy.
const noBackendYet: Plugin = {
  name: 'no-backend-yet',
  configureServer(server) {
    server.middlewares.use('/api', answerNoBackend);
  },
  configurePreviewServer(server) {
    server.middlewares.use('/api', answerNoBackend);
  },
};

function answerNoBackend(_req: IncomingMessage, res: ServerResponse) {
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'No backend yet: the Rust HTTP server arrives in Phase 4.' }));
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react(), noBackendYet],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // A fixed port the Tauri shell can point its dev URL at.
  server: { port: 5173, strictPort: true },
  // The bundle loads from disk in the desktop app, so one chunk of about 1 MB is fine.
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
