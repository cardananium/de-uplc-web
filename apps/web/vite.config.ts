import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// @de-uplc/* are resolved by alias (no workspace symlinks; npm can't handle the pnpm
// "workspace:*" deps). engine-wasm aliases to the pkg DIR so both the bare specifier
// (-> de_uplc.js) and the `?url` subpath (-> de_uplc_bg.wasm) resolve.
export default defineConfig({
  // The config lives in apps/web; pin root here so `vite build` (run from the repo
  // root via the workspace script) resolves index.html and outputs to apps/web/dist.
  root: r('.'),
  plugins: [react(), wasm(), topLevelAwait()],
  resolve: {
    alias: {
      '@de-uplc/core': r('../../packages/core/src/index.ts'),
      '@de-uplc/engine-worker': r('../../packages/engine-worker/src/index.ts'),
      '@de-uplc/engine-wasm': r('../../packages/engine-wasm/pkg'),
    },
  },
  worker: {
    format: 'es',
    plugins: () => [wasm(), topLevelAwait()],
  },
  build: {
    target: 'esnext',
    // Monaco's lazy edcore chunk is legitimately large (and lazy-loaded), so the
    // default 500 kB warning is just noise here.
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor';
        },
      },
    },
  },
  server: {
    // Serve from the repo root so root-level node_modules load in dev — notably the
    // @vscode/codicons font referenced by the codicon CSS. Vite's workspace-root auto-detect
    // narrowed to apps/web after pnpm-workspace.yaml was removed, so pin the allow root.
    fs: { allow: [r('../..')] },
  },
});
