/**
 * The walkthrough's JavaScript budget (K-04): after `vite build`, what a
 * walkthrough loads before anything is drawn, gzipped as CloudFront sends
 * it, must stay within BUDGET.scriptKB (shared/build3d/budget.js). That is
 * what index.html loads (its scripts, the modules it preloads and its
 * stylesheets), and the walkthrough's own chunks (loaded on demand by the
 * app, but needed before its first frame) with everything they import.
 * Code only other pages load (the editor, the PDF reader, the reviewer's
 * 3D preview) is not counted. The KTX2 transcoder, fetched with the first
 * machine model, has its own allowance (BUDGET.transcoderKB), and must be
 * the one built without eval (web/vendor/basis, N-01): three's own would
 * fail under the app's Content-Security-Policy. Run by `npm run build`, so
 * the deploy pipeline stops on a bundle that has grown too heavy, or on the
 * wrong transcoder.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { BUDGET } from '../../shared/build3d/budget.js';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** The KTX2 transcoder's files (fetched with the first machine model, not imported), and each one's gzipped size. */
export function transcoder(dir = dist) {
  return readdirSync(path.join(dir, 'assets'))
    .filter((f) => /^basis_transcoder-[\w-]+\.(js|wasm)$/.test(f))
    .map((f) => ({ file: `assets/${f}`, gzipped: zlib.gzipSync(readFileSync(path.join(dir, 'assets', f)), { level: 9 }).length }));
}

/** Code built from strings, which the app's policy refuses (no 'unsafe-eval'). */
export const EVAL = /new Function\b|newFunc\(\s*Function\b|(?<![\w$.])eval\(/;

/** Whether the built transcoder's glue builds code from strings (three's does; web/vendor/basis's does not). */
export function transcoderNeedsEval(dir = dist) {
  return transcoder(dir)
    .filter((f) => f.file.endsWith('.js'))
    .some((f) => EVAL.test(readFileSync(path.join(dir, f.file), 'utf8')));
}

/** The walkthrough's own chunks, named after its modules. */
const WALKTHROUGH = /^(Walkthrough|WalkthroughPage)-[\w-]+\.js$/;

/** A chunk's static imports of its siblings (not `import()`, which loads on demand). */
const staticImports = (code) => [...code.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)].map((m) => m[1]);

/** The files a walkthrough loads before its first frame, and each one's gzipped size. */
export function upfront(dir = dist) {
  const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
  const start = [...html.matchAll(/(?:src|href)="\/?((?:[\w-]+\/)*[\w.-]+\.(?:js|css))"/g)].map((m) => m[1]);
  const assets = readdirSync(path.join(dir, 'assets'));
  start.push(...assets.filter((f) => WALKTHROUGH.test(f)).map((f) => `assets/${f}`));
  const seen = new Set();
  const queue = [...start];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    if (file.endsWith('.js')) {
      const folder = path.posix.dirname(file);
      for (const next of staticImports(readFileSync(path.join(dir, file), 'utf8'))) queue.push(path.posix.join(folder, next));
    }
  }
  return [...seen].map((file) => ({ file, gzipped: zlib.gzipSync(readFileSync(path.join(dir, file)), { level: 9 }).length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = upfront();
  const total = files.reduce((sum, f) => sum + f.gzipped, 0);
  for (const f of files) console.log(`  ${f.file}: ${(f.gzipped / 1024).toFixed(0)} KB gzipped`);
  console.log(`Loaded before the first view: ${(total / 1024).toFixed(0)} KB gzipped, of ${BUDGET.scriptKB} KB allowed (K-04).`);
  if (!files.length) {
    console.error('index.html loads no scripts: is this the built app?');
    process.exit(1);
  }
  if (total > BUDGET.scriptKB * 1024) {
    console.error(`Over the walkthrough's budget by ${((total - BUDGET.scriptKB * 1024) / 1024).toFixed(0)} KB: load the extra code on demand, or trim it.`);
    process.exit(1);
  }
  const basis = transcoder();
  const basisTotal = basis.reduce((sum, f) => sum + f.gzipped, 0);
  console.log(`KTX2 transcoder, with the first machine model: ${(basisTotal / 1024).toFixed(0)} KB gzipped, of ${BUDGET.transcoderKB} KB allowed.`);
  if (basis.length !== 2 || basisTotal > BUDGET.transcoderKB * 1024) {
    console.error(basis.length !== 2 ? 'The KTX2 transcoder (basis_transcoder .js and .wasm) is not in the build.' : 'The KTX2 transcoder is over its allowance.');
    process.exit(1);
  }
  if (transcoderNeedsEval()) {
    console.error("The built KTX2 transcoder needs eval, which the app's policy refuses: the build should use web/vendor/basis (vite.config.js, N-01).");
    process.exit(1);
  }
}
