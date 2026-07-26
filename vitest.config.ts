import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Root vitest config. `npm test` previously ran with NO config at all, which worked only
// because every test happened to import by relative path. `apps/web/src/profile/*` tests
// import `@de-uplc/core` (TermIndex), so the same aliases the web app uses
// (apps/web/vite.config.ts) have to exist for the test runner too — the packages are wired
// by alias, not by workspace symlinks (see the comment in the root package.json).
export default defineConfig({
  resolve: {
    alias: {
      '@de-uplc/core': r('packages/core/src/index.ts'),
      '@de-uplc/engine-worker': r('packages/engine-worker/src/index.ts'),
      '@de-uplc/engine-wasm': r('packages/engine-wasm/pkg'),
    },
  },
});
