/// <reference types="vite/client" />

// Monaco's "editor core + all editor contributions" entry (find, folding, inlay
// hints, injected text, …) WITHOUT the basic-languages / json·ts·css·html language
// services. We dynamic-import this so the heavy editor chunk only loads when the
// term editor mounts. It re-exports the full `monaco-editor` namespace.
declare module 'monaco-editor/esm/vs/editor/edcore.main' {
  export * from 'monaco-editor';
}
