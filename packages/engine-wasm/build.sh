#!/bin/bash
# Regenerate packages/engine-wasm/pkg from the Rust crate (rust-src), web target.
# Thin wrapper around rust-src/build-web.sh that writes straight into this package's pkg/.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUST_SRC="$SCRIPT_DIR/../../rust-src"
"$RUST_SRC/build-web.sh" "$SCRIPT_DIR/pkg"
# wasm-pack writes a `.gitignore` of `*` into the out-dir; that would make the very
# first `git add` silently skip all the committed WASM artifacts. Strip it so the
# generated pkg/ stays tracked. (pkg/package.json is kept — the Vite alias resolves
# the pkg DIR through it.)
rm -f "$SCRIPT_DIR/pkg/.gitignore"
echo "✅ engine-wasm/pkg updated"
