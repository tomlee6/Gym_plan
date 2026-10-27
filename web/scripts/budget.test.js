/**
 * The JavaScript budget check (K-04) counts what a walkthrough loads before
 * its first frame, and nothing only other pages load.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { transcoderNeedsEval, upfront } from './budget.mjs';

let dir;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(files) {
  dir = mkdtempSync(path.join(os.tmpdir(), 'budget-'));
  mkdirSync(path.join(dir, 'assets'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

describe('the walkthrough’s JavaScript budget', () => {
  it('counts the page, the walkthrough’s chunks and what they import, not other pages’ code', () => {
    build({
      'index.html': '<script type="module" src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-c3.css">',
      'assets/index-a1.js': 'import{x}from"./runtime-r1.js";const page=()=>import("./EditorPage-e1.js");',
      'assets/runtime-r1.js': 'export const x=1;',
      'assets/index-c3.css': 'body{margin:0}',
      'assets/Walkthrough-w1.js': 'import{T}from"./three-t1.js";import"./side-s1.js";',
      'assets/three-t1.js': 'export const T=2;',
      'assets/side-s1.js': ';',
      'assets/EditorPage-e1.js': 'import{p}from"./pdf-p1.js";',
      'assets/pdf-p1.js': 'export const p=3;',
    });
    const files = upfront(dir).map((f) => f.file).sort();
    expect(files).toEqual([
      'assets/Walkthrough-w1.js',
      'assets/index-a1.js',
      'assets/index-c3.css',
      'assets/runtime-r1.js',
      'assets/side-s1.js',
      'assets/three-t1.js',
    ]);
    expect(upfront(dir).every((f) => f.gzipped > 0)).toBe(true);
  });

  it('tells a transcoder that needs eval from the one built without (N-01)', () => {
    build({
      'assets/basis_transcoder-b1.js': 'var BASIS=(()=>{function newFunc(c,a){};var invoker=newFunc(Function,args)})();',
      'assets/basis_transcoder-b1.wasm': 'wasm',
    });
    expect(transcoderNeedsEval(dir)).toBe(true);
    writeFileSync(path.join(dir, 'assets/basis_transcoder-b1.js'), 'var BASIS=(()=>{var invoker=function(...args){return fn(...args)};craftInvokerFunction(x)})();');
    expect(transcoderNeedsEval(dir)).toBe(false);
  });
});
