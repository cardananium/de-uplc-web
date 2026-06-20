// Browser TextMate stack: vscode-oniguruma (regex engine, WASM) + vscode-textmate
// (grammar tokenizer). Loads the Oniguruma WASM lazily and exposes cached
// `IGrammar`s by scope name. The Monaco token-provider bridge lives in `monaco.ts`.

import { Registry, INITIAL, type IGrammar, type IRawGrammar, type StateStack } from 'vscode-textmate';
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma';
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';
import { GRAMMARS } from './grammars';

let wasmPromise: Promise<void> | undefined;
function ensureOniguruma(): Promise<void> {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const buf = await (await fetch(onigWasmUrl)).arrayBuffer();
      await loadWASM(buf);
    })();
  }
  return wasmPromise;
}

let registry: Registry | undefined;
function getRegistry(): Registry {
  if (!registry) {
    registry = new Registry({
      onigLib: ensureOniguruma().then(() => ({ createOnigScanner, createOnigString })),
      loadGrammar: async (scopeName) => (GRAMMARS[scopeName] as IRawGrammar | undefined) ?? null,
    });
  }
  return registry;
}

const grammarCache = new Map<string, Promise<IGrammar | null>>();

/** Load (and cache) the grammar for a TextMate root scope. */
export function getGrammar(scopeName: string): Promise<IGrammar | null> {
  let p = grammarCache.get(scopeName);
  if (!p) {
    p = getRegistry().loadGrammar(scopeName);
    grammarCache.set(scopeName, p);
  }
  return p;
}

export { INITIAL };
export type { StateStack };
