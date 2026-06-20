#!/bin/bash
# Build the de-uplc engine as a browser-loadable WASM module (wasm-pack --target web).
#
# Why this script exists (M0 spike, 2026-06-02):
#   blst (BLS12-381) ships C/asm that cc-rs compiles to wasm32. Apple's system
#   clang has NO WebAssembly backend ("No available targets ... wasm32-unknown-unknown"),
#   so on macOS we must point cc-rs at Homebrew LLVM's clang, which does.
#   On Linux, distro clang already includes the wasm backend, so no override is needed.
#
# Verified: builds on STABLE Rust (no nightly / build-std). Optimized output ~1.66 MB
# raw / ~0.39 MB brotli; runs in Node and Chrome.
#
# Usage:  ./build-web.sh [out-dir]      (default out-dir: pkg)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUT_DIR="${1:-pkg}"

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "❌ wasm-pack not found. Install: cargo install wasm-pack" >&2
  exit 1
fi

# macOS: use Homebrew LLVM clang (has the WebAssembly backend) for blst's C code.
if [[ "$(uname)" == "Darwin" ]]; then
  LLVM_BIN="$(brew --prefix llvm 2>/dev/null)/bin"
  if [[ -x "$LLVM_BIN/clang" ]]; then
    export CC_wasm32_unknown_unknown="$LLVM_BIN/clang"
    export AR_wasm32_unknown_unknown="$LLVM_BIN/llvm-ar"
    export RANLIB_wasm32_unknown_unknown="$LLVM_BIN/llvm-ranlib"
    echo "🔧 Using Homebrew LLVM for wasm C deps: $LLVM_BIN/clang"
  else
    echo "⚠️  Homebrew LLVM clang not found. Install with: brew install llvm" >&2
    echo "    (Apple's system clang cannot emit wasm objects; blst will fail to build.)" >&2
  fi
fi

echo "🔨 wasm-pack build --release --target web --out-dir $OUT_DIR"
wasm-pack build --release --target web --out-dir "$OUT_DIR"

echo "✅ Done. Output in: $OUT_DIR/"
ls -lh "$OUT_DIR"/*.wasm 2>/dev/null || true
