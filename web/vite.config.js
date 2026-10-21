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

/**
 * Machine models' KTX2 textures (N-01) are read by three's KTX2Loader with
 * the Basis Universal transcoder, in a worker that inherits this page's
 * policy. three.js ships one whose glue builds functions from strings, which
 * the policy refuses (no 'unsafe-eval'); vendor/basis holds the same
 * transcoder built without that. This points KTX2Loader at it, so the build
 * emits it (hashed, like any asset) and never three's. If a three.js upgrade
 * moves the reference, the build stops: rebuild vendor/basis to match.
 */
export const TRANSCODER_FILES = ['basis_transcoder.js', 'basis_transcoder.wasm'];

export function basisTranscoder(vendored = path.resolve(here, 'vendor', 'basis')) {
  return {
    name: 'gymplan-basis-transcoder',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].replace(/\\/g, '/').endsWith('/three/examples/jsm/loaders/KTX2Loader.js')) return null;
      let out = code;
      for (const file of TRANSCODER_FILES) {
        const original = `'../libs/basis/${file}'`;
        if (!out.includes(original)) {
          throw new Error(`KTX2Loader no longer loads ${original}; check web/vendor/basis against this three.js (N-01).`);
        }
        const relative = path.relative(path.dirname(id.split('?')[0]), path.join(vendored, file)).split(path.sep).join('/');
        out = out.replace(original, JSON.stringify(relative));
      }
      return { code: out, map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), contentSecurityPolicy(env), basisTranscoder()],
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
