// Flat ESLint config for @de-uplc/core. The core MUST stay platform-agnostic:
// forbid imports of vscode, Node built-ins, React, and worker/wasm packages.
// (tsc with lib=["ES2022","WebWorker"] and types:[] already blocks most of these;
//  this gives a clearer error and also bans bare `react`/`@de-uplc/engine-*`.)
export default [
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'vscode', message: 'core is platform-agnostic — use a port instead.' },
            { name: 'fs', message: 'no filesystem in core — use a FileSource/SettingsStore port.' },
            { name: 'node:fs', message: 'no filesystem in core.' },
            { name: 'path', message: 'no node:path in core.' },
            { name: 'node:path', message: 'no node:path in core.' },
            { name: 'worker_threads', message: 'no node worker_threads in core (engine-worker owns the worker).' },
            { name: 'react', message: 'core must not depend on React.' },
            { name: 'de-uplc', message: 'do not import the WASM directly — inject a RefScriptResolver / use the engine worker.' },
            { name: '@de-uplc/engine-wasm', message: 'core must not import the WASM package.' },
            { name: '@de-uplc/engine-worker', message: 'core must not import the worker package.' },
          ],
          patterns: ['node:*'],
        },
      ],
    },
  },
];
