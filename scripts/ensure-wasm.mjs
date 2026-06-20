#!/usr/bin/env node
// Guard run before `dev` / `build:web` (npm `pre*` hooks). The Rust→WASM engine
// (packages/engine-wasm/pkg) is NO LONGER committed — it is built in CI before the
// web build, and on demand here for local dev. If the artifact is already present
// (committed-less clone after a first build, or CI restored it), this is a no-op.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasm = resolve(root, 'packages/engine-wasm/pkg/de_uplc_bg.wasm');

if (existsSync(wasm)) process.exit(0);

console.log('[ensure-wasm] engine WASM not found — building it (needs Rust + wasm-pack)…');
try {
  execSync('npm run build:wasm', { cwd: root, stdio: 'inherit' });
} catch {
  console.error(
    '\n[ensure-wasm] Failed to build the engine WASM.\n' +
      'Install the Rust toolchain + wasm-pack, then retry (or run `npm run build:wasm`):\n' +
      '  rustup target add wasm32-unknown-unknown && cargo install wasm-pack',
  );
  process.exit(1);
}
