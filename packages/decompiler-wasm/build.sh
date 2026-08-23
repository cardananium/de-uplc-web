#!/bin/bash
# Build the dehosk decompiler as a browser-loadable WASM module (--target web),
# straight into this package's pkg/.
#
# Uses cargo (host) + wasm-bindgen (CLI) rather than wasm-pack: the wasm-pack
# binary on this machine is x86_64-under-Rosetta and then fails linking host
# build-scripts via xcrun (`need x86_64` vs arm64 CommandLineTools). cargo and
# wasm-bindgen-cli are native arm64.
#
# The crate's .cargo/config.toml sets a 64 MB wasm shadow stack for the
# decompiler's deep recursion. macOS Homebrew LLVM is required for blst's C
# (same reason as engine-wasm: Apple clang has no wasm backend).
#
# Usage: ./build.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$SCRIPT_DIR/crate"
OUT_DIR="$SCRIPT_DIR/pkg"
CRATE_NAME="de_uplc_decompiler_wasm"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "❌ wasm-bindgen not found. Install: cargo install wasm-bindgen-cli" >&2
  exit 1
fi

# macOS: blst's C deps need Homebrew LLVM clang (Apple clang can't emit wasm objects).
if [[ "$(uname)" == "Darwin" ]]; then
  LLVM_BIN="$(brew --prefix llvm 2>/dev/null)/bin"
  if [[ -x "$LLVM_BIN/clang" ]]; then
    export CC_wasm32_unknown_unknown="$LLVM_BIN/clang"
    export AR_wasm32_unknown_unknown="$LLVM_BIN/llvm-ar"
    export RANLIB_wasm32_unknown_unknown="$LLVM_BIN/llvm-ranlib"
    echo "🔧 Using Homebrew LLVM for wasm C deps: $LLVM_BIN/clang"
  else
    echo "⚠️  Homebrew LLVM clang not found. Install with: brew install llvm" >&2
  fi
fi

# Keep the rustc cache inside the crate so a sandboxed/cached CARGO_TARGET_DIR
# cannot send host build-scripts through the wrong arch's linker.
export CARGO_TARGET_DIR="$CRATE_DIR/target"

cd "$CRATE_DIR"
echo "🔨 cargo build --release --target wasm32-unknown-unknown"
cargo build --release --target wasm32-unknown-unknown

mkdir -p "$OUT_DIR"
echo "🔗 wasm-bindgen --target web --out-dir $OUT_DIR"
wasm-bindgen \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/${CRATE_NAME}.wasm" \
  --out-dir "$OUT_DIR" \
  --target web \
  --out-name "$CRATE_NAME"

# Optional size pass (wasm-pack used -Os --enable-bulk-memory).
if command -v wasm-opt >/dev/null 2>&1; then
  echo "📉 wasm-opt -Os"
  wasm-opt -Os --enable-bulk-memory \
    -o "$OUT_DIR/${CRATE_NAME}_bg.wasm" \
    "$OUT_DIR/${CRATE_NAME}_bg.wasm"
fi

# wasm-bindgen does not emit package.json; Vite aliases this directory as
# `@de-uplc/decompiler-wasm` and needs a `main` field.
cat > "$OUT_DIR/package.json" <<'JSON'
{
  "name": "de-uplc-decompiler-wasm",
  "type": "module",
  "version": "0.1.0",
  "license": "Apache-2.0",
  "main": "de_uplc_decompiler_wasm.js",
  "types": "de_uplc_decompiler_wasm.d.ts"
}
JSON

rm -f "$OUT_DIR/.gitignore"
echo "✅ decompiler-wasm/pkg updated"
ls -lh "$OUT_DIR"/*.wasm 2>/dev/null || true
