#!/bin/sh
# Builds the Basis Universal transcoder that the walkthrough and the review
# preview use to read KTX2 textures (N-01), without eval: three.js ships one
# whose embind glue builds functions from strings (new Function), which the
# app's Content-Security-Policy refuses (no 'unsafe-eval'). This is the same
# source and the same build three.js uses, with one flag added:
# -sDYNAMIC_EXECUTION=0. See README.md.
#
#   sh web/vendor/basis/build.sh            (needs git and Docker)
#   sh web/vendor/basis/build.sh --as-three (three.js's own build, to compare)
#
# Writes basis_transcoder.js and basis_transcoder.wasm next to this script
# (with --as-three, into .work/as-three/ instead).
set -eu

BASIS_TAG=v1_50_0 # what three.js 0.186 ships (three.js pull request 29418)
BASIS_COMMIT=051ad6d8a64bb95a79e8601c317055fd1782ad3e
# The Emscripten three.js built it with (same runtime; checked with --as-three), pinned by digest.
EMSDK=3.1.64@sha256:8847dad4171ebc8a53d9ae5cda86a2546ef5b2e68834c14dc1ba2b2962e125cc

# Git Bash on Windows: Docker wants C:/... paths, and none of its arguments rewritten.
export MSYS_NO_PATHCONV=1
here=$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))
work="$here/.work"
out="$here"
extra="-sDYNAMIC_EXECUTION=0"
if [ "${1:-}" = "--as-three" ]; then
  out="$work/as-three"
  extra=""
fi
mkdir -p "$work" "$out"

if [ ! -d "$work/basis_universal" ]; then
  git clone --quiet --depth 1 --branch "$BASIS_TAG" https://github.com/BinomialLLC/basis_universal.git "$work/basis_universal"
fi
test "$(git -C "$work/basis_universal" rev-parse HEAD)" = "$BASIS_COMMIT" || {
  echo "basis_universal is not at $BASIS_COMMIT" >&2
  exit 1
}

# webgl/transcoder/CMakeLists.txt, as commands: its definitions, options and link flags.
docker run --rm -v "$work/basis_universal:/src:ro" -v "$out:/out" -w /src "emscripten/emsdk:$EMSDK" sh -ec "
  DEFS='-DNDEBUG -DBASISD_SUPPORT_UASTC_HDR=1 -DBASISD_SUPPORT_UASTC=1 -DBASISD_SUPPORT_BC7=1 -DBASISD_SUPPORT_ATC=0
        -DBASISD_SUPPORT_ASTC_HIGHER_OPAQUE_QUALITY=0 -DBASISD_SUPPORT_PVRTC2=0 -DBASISD_SUPPORT_FXT1=0
        -DBASISD_SUPPORT_ETC2_EAC_RG11=0 -DBASISU_SUPPORT_ENCODING=0 -DBASISD_ENABLE_DEBUG_FLAGS=1
        -DBASISD_SUPPORT_KTX2=1 -DBASISD_SUPPORT_KTX2_ZSTD=1'
  OPTS='-O3 -fno-strict-aliasing -Itranscoder'
  mkdir -p /tmp/o
  em++ \$DEFS \$OPTS -std=gnu++11 -c transcoder/basisu_transcoder.cpp -o /tmp/o/basisu_transcoder.o
  em++ \$DEFS \$OPTS -std=gnu++11 -c webgl/transcoder/basis_wrappers.cpp -o /tmp/o/basis_wrappers.o
  emcc \$DEFS \$OPTS -c zstd/zstddeclib.c -o /tmp/o/zstddeclib.o
  em++ -O3 /tmp/o/basisu_transcoder.o /tmp/o/basis_wrappers.o /tmp/o/zstddeclib.o \
    --bind -sALLOW_MEMORY_GROWTH=1 -sASSERTIONS=0 -sMALLOC=emmalloc -sMODULARIZE=1 -sEXPORT_NAME=BASIS $extra \
    -o /out/basis_transcoder.js
"
echo "Built $out/basis_transcoder.js and .wasm (Basis Universal $BASIS_TAG, Emscripten $EMSDK${extra:+, $extra})."
