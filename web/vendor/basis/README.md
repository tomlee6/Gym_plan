# Basis Universal transcoder, without eval (N-01)

Machine models' textures are KTX2 (Basis Universal ETC1S). In the walkthrough and the reviewer's preview, three.js's `KTX2Loader` turns them into whatever compressed format the graphics card takes, in a worker. That worker runs the Basis Universal transcoder: `basis_transcoder.js` (the glue) and `basis_transcoder.wasm`.

**Why this copy.** The copy three.js ships builds functions from strings (Emscripten's embind glue calls `new Function`). The app's Content-Security-Policy (`web/csp.json`) has no `'unsafe-eval'`, and a worker made from a blob inherits the page's policy. So with three's copy, every KTX2 texture fails ("Evaluating a string as JavaScript violates the following Content Security Policy directive"), and the model never loads.

This is the same transcoder, built the same way, with one flag added, `-sDYNAMIC_EXECUTION=0`. Embind then uses ordinary closures instead of building code. The policy keeps `'wasm-unsafe-eval'` (compiling WebAssembly) and nothing more.

**How it gets used.** `basisTranscoder()` in `web/vite.config.js` points `KTX2Loader` at these two files. The build then emits them, hashed like any asset, and never emits three's. If a three.js upgrade moves that reference, the build stops: rebuild these files for the new three.js (below).

## What it is

| | |
|---|---|
| Source | [Basis Universal](https://github.com/BinomialLLC/basis_universal) `v1_50_0` (commit `051ad6d8a64bb95a79e8601c317055fd1782ad3e`), the version three.js 0.186 ships (three.js pull request 29418). `v1_50_0_2` changes nothing in the transcoder. |
| Build | `webgl/transcoder/CMakeLists.txt`'s definitions, options and link flags, plus `-sDYNAMIC_EXECUTION=0` |
| Compiler | Emscripten 3.1.64, Docker image `emscripten/emsdk:3.1.64@sha256:8847dad4171ebc8a53d9ae5cda86a2546ef5b2e68834c14dc1ba2b2962e125cc` |
| `basis_transcoder.js` | 55,970 bytes, SHA-256 `a66035597f7d812abae17e800c6704826045e796a3c5c0b5d72a5cdbe3160e5e` |
| `basis_transcoder.wasm` | 527,326 bytes, SHA-256 `a02d246ed08d1ebac9aedbdb1e9ce9804358c704eaf6dda6a75526c28ac1e81e` |
| Licences | Basis Universal: Apache 2.0 (`LICENSE`). The Zstandard decoder it includes: BSD (`LICENSE.zstd`). |

## How it was checked

- **Same toolchain as three.js.** Built without the flag (`build.sh --as-three`), the glue is the same size as three's (57,529 bytes) and identical but for the order in which four exports are named. The wasm is 7 bytes off.
- **Only the glue changes.** The wasm is byte-identical with and without the flag. The build is reproducible: building again gives the same two checksums.
- **No code from strings.** The glue holds no `new Function`, `newFunc(Function` or `eval(`. `transcoder.test.js` keeps it that way, and `npm run build` refuses a transcoder that has them.
- **In a browser, under the production policy** (sent as a header), headless Chrome loaded a machine model made with `MODEL_TEXTURES=ktx2`, through the walkthrough's own loader (`loadModelFile`):
  - **three's copy:** the policy violation above, and the model never loads.
  - **This copy:** it loads, with its texture compressed on the GPU (BC7 there, 512 × 512, 10 mipmap levels), and no violation.

## Rebuilding

Needs git and Docker. From the repository root:

```sh
sh web/vendor/basis/build.sh               # writes basis_transcoder.js and .wasm here
sh web/vendor/basis/build.sh --as-three    # three.js's own build, into .work/as-three/, to compare
```

When three.js moves to a newer transcoder, update these in `build.sh`, rebuild, and compare `--as-three` with the new three.js's `examples/jsm/libs/basis/` before trusting the build:
- `BASIS_TAG` and `BASIS_COMMIT` (the version is in three.js's commit for it);
- `EMSDK`, if three's glue shows a different Emscripten.

Then update the table above (the test checks the checksums).
