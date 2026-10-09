import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The production Content-Security-Policy (H-05), from csp.json.
 *
 * `%API_ORIGIN%` becomes the origin of VITE_API_URL (nothing when the API
 * is reverse-proxied on this origin) and `%EXTRA_CONNECT%` the
 * space-separated VITE_CSP_CONNECT_SRC (e.g. a model bucket's own domain).
 * `header: true` keeps every directive, for the CloudFront response header;
 * the <meta> form drops those browsers ignore there (frame-ancestors).
 */
export function cspFor(env, { header = false } = {}) {
  const spec = JSON.parse(fs.readFileSync(path.resolve(here, 'csp.json'), 'utf8'));
  let apiOrigin = '';
  try {
    apiOrigin = env.VITE_API_URL ? new URL(env.VITE_API_URL).origin : '';
  } catch {
    apiOrigin = '';
  }
  const extra = (env.VITE_CSP_CONNECT_SRC ?? '').split(/\s+/).filter(Boolean);
  return Object.entries(spec.directives)
    .filter(([name]) => header || !spec.headerOnly?.includes(name))
    .map(([name, values]) => {
      const list = values
        .flatMap((v) => (v === '%API_ORIGIN%' ? [apiOrigin] : v === '%EXTRA_CONNECT%' ? extra : [v]))
        .filter(Boolean);
      return `${name} ${[...new Set(list)].join(' ')}`;
    })
    .join('; ');
}

/**
 * Writes the policy into the built index.html only. In development Vite
 * and the React plugin inject inline scripts for hot reload, which this
 * policy rightly refuses, so `npm run dev` runs without it.
 */
function contentSecurityPolicy(env) {
  return {
    name: 'gymplan-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(env)}" />`;
      return html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    ${meta}`);
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), contentSecurityPolicy(env)],
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
      // The dev Hub (/dev-hub, HUB_DRIVER=dev) is served by the backend too.
      proxy: {
        '/v1': env.GYM_PLAN_API ?? 'http://localhost:8080',
        '/dev-hub': env.GYM_PLAN_API ?? 'http://localhost:8080',
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: './src/test-setup.js',
      // The editor and admin pages are heavy in jsdom; on a busy machine a
      // test can pass the 5 s default without anything being wrong.
      testTimeout: 20000,
    },
  };
});
