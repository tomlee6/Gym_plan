import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    resolve: {
      // The plan format, reading and validation, shared with the backend.
      alias: { '@shared': path.resolve(here, '../shared') },
    },
    server: {
      // The backend builds share links from PUBLIC_WEB_URL, which defaults
      // to http://localhost:3000.
      port: 3000,
      strictPort: true,
      fs: { allow: [path.resolve(here, '..')] },
      // In development the page calls /v1/... on its own origin and Vite
      // forwards it to the backend, so no CORS setup is needed locally.
      proxy: {
        '/v1': env.GYM_PLAN_API ?? 'http://localhost:8080',
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.js',
    },
  };
});
