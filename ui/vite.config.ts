import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// `yarn dev` and `yarn preview` forward /api to a running `ca-server` and add its token, so the
// browser never holds it. Start the server with the same values:
//   cargo run -p code-automata-server --bin ca-server -- --port 7878 --token dev
const serverUrl = process.env.CA_SERVER_URL ?? 'http://127.0.0.1:7878';
const serverToken = process.env.CA_SERVER_TOKEN ?? 'dev';
const proxy = {
  '/api': {
    target: serverUrl,
    // The server accepts only its own Host (127.0.0.1:<port>).
    changeOrigin: true,
    headers: { Authorization: `Bearer ${serverToken}` },
  },
};

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // A fixed port the Tauri shell can point its dev URL at.
  server: { port: 5173, strictPort: true, proxy },
  preview: { proxy },
  // The bundle loads from disk in the desktop app, so one chunk of about 1 MB is fine.
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
  },
});
