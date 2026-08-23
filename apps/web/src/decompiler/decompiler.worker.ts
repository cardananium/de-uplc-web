// Dedicated decompiler worker: instantiates the dehosk WASM (with its 64 MB shadow stack) once and
// exposes `decompile` over Comlink. Kept off the main thread so deep/slow decompiles never block UI.
import * as Comlink from 'comlink';
import init, { decompile_uplc, options_catalogue } from '@de-uplc/decompiler-wasm';
import wasmUrl from '@de-uplc/decompiler-wasm/de_uplc_decompiler_wasm_bg.wasm?url';

let ready: Promise<void> | undefined;
const ensureReady = (): Promise<void> => (ready ??= init({ module_or_path: wasmUrl }).then(() => undefined));

const api = {
  /** Decompile compiled UPLC bytecode (hex) → Aiken-like pseudocode. `optionsJson` = catalogue defaults bag. */
  async decompile(hexCode: string, optionsJson: string): Promise<string> {
    await ensureReady();
    return decompile_uplc(hexCode, optionsJson);
  },
  /** Option catalogue JSON (`version`, `groups`, `defaults`) — same wire as dehosk-web GET /api/options. */
  async catalogue(): Promise<string> {
    await ensureReady();
    return options_catalogue();
  },
};

export type DecompilerApi = typeof api;
Comlink.expose(api);
