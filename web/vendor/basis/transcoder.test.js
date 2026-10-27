/**
 * The Basis Universal transcoder KTX2 textures go through (N-01): the one
 * built here without eval, which the app's Content-Security-Policy lets run,
 * and the one the build uses in place of three's. See README.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { EVAL } from '../../scripts/budget.mjs';
import { basisTranscoder, TRANSCODER_FILES } from '../../vite.config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.resolve(here, '..', '..');
const ktx2Loader = path.join(web, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'KTX2Loader.js');

describe('the KTX2 transcoder (N-01)', () => {
  it('builds no code from strings, so the policy lets it run', () => {
    const glue = readFileSync(path.join(here, 'basis_transcoder.js'), 'utf8');
    expect(glue).not.toMatch(EVAL);
    // three's own copy does, which is why this one exists.
    expect(readFileSync(path.join(web, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis', 'basis_transcoder.js'), 'utf8')).toMatch(EVAL);
    // Still the module three's worker starts: BASIS({ wasmBinary, onRuntimeInitialized }).
    expect(glue).toMatch(/^\s*var BASIS = \(\(\) => \{/);
    expect(glue).toContain('var Module=moduleArg;');
  });

  it('is the build the README describes', () => {
    const readme = readFileSync(path.join(here, 'README.md'), 'utf8');
    for (const file of TRANSCODER_FILES) {
      const sha = createHash('sha256').update(readFileSync(path.join(here, file))).digest('hex');
      expect(readme).toContain(`\`${file}\` | ${readFileSync(path.join(here, file)).length.toLocaleString('en')} bytes, SHA-256 \`${sha}\``);
    }
    expect(existsSync(path.join(here, 'LICENSE'))).toBe(true);
    expect(existsSync(path.join(here, 'LICENSE.zstd'))).toBe(true);
  });

  it('the policy allows WebAssembly and workers from blobs, and still no eval', () => {
    const { directives } = JSON.parse(readFileSync(path.join(web, 'csp.json'), 'utf8'));
    expect(directives['script-src']).toContain("'wasm-unsafe-eval'");
    expect(directives['script-src']).not.toContain("'unsafe-eval'");
    expect(directives['worker-src']).toContain('blob:');
  });

  it('the build points three’s KTX2Loader at it', () => {
    const plugin = basisTranscoder();
    const { code } = plugin.transform(readFileSync(ktx2Loader, 'utf8'), ktx2Loader);
    expect(code).not.toContain("'../libs/basis/");
    for (const file of TRANSCODER_FILES) {
      const [, relative] = code.match(new RegExp(`new URL\\( "([^"]+${file.replace('.', '\\.')})", import\\.meta\\.url \\)`));
      expect(path.resolve(path.dirname(ktx2Loader), relative)).toBe(path.join(here, file));
    }
    // Nothing else is touched.
    expect(plugin.transform('const x = 1;', path.join(web, 'src', 'main.jsx'))).toBeNull();
  });

  it('stops the build if a three.js upgrade moves the reference', () => {
    expect(() => basisTranscoder().transform('// a KTX2Loader that loads its transcoder elsewhere', ktx2Loader)).toThrow(/check web\/vendor\/basis/);
  });
});
