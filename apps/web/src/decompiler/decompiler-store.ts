import { create } from 'zustand';
import * as Comlink from 'comlink';
import type { DecompilerApi } from './decompiler.worker';
import { assertCatalogue, setAtPath, type OptionCatalogue, type OptionsObject } from './catalogue';
import { mergeLaunchOptions } from './launch-options';

export interface DecompileLaunchHints {
  version?: string;
  purpose?: string;
}

function applyHints(opts: OptionsObject, hints: DecompileLaunchHints): OptionsObject {
  let next = opts;
  if (hints.version) next = setAtPath(next, ['script_version'], hints.version);
  if (hints.purpose) next = setAtPath(next, ['validator_shape', 'purpose'], hints.purpose);
  return next;
}

let launchHints: DecompileLaunchHints = {};

export interface DecompileRun {
  input: string;
  optionsJson: string;
}

interface DecompilerState {
  input: string;
  fileName?: string;
  catalogue: OptionCatalogue | null;
  catalogueError?: string;
  options: OptionsObject | null;
  output: string;
  error?: string;
  loading: boolean;
  elapsedMs?: number;
  /** Bytecode + options JSON of the last finished decompile — what `output` was produced from. */
  lastRun?: DecompileRun;
  setInput: (input: string, fileName?: string) => void;
  setOptions: (options: OptionsObject) => void;
  resetOptions: () => void;
  loadCatalogue: () => Promise<void>;
  applyLaunchHints: (hints: DecompileLaunchHints) => void;
  /**
   * Lay a launch link's options object over the current options (catalogue defaults + hints).
   * Resolves to the dotted paths that were left out (unknown to this build or mistyped).
   */
  applyLaunchOptions: (options: Record<string, unknown>) => Promise<string[]>;
  decompile: () => Promise<void>;
}

let worker: Worker | undefined;
let api: Comlink.Remote<DecompilerApi> | undefined;
const ensureWorker = (): Comlink.Remote<DecompilerApi> => {
  if (!api) {
    worker = new Worker(new URL('./decompiler.worker.ts', import.meta.url), { type: 'module' });
    api = Comlink.wrap<DecompilerApi>(worker);
  }
  return api;
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => { try { worker?.terminate(); } catch { /* ignore */ } worker = undefined; api = undefined; });
}

let catalogueInflight: Promise<void> | undefined;

export const useDecompiler = create<DecompilerState>((set, get) => ({
  input: '',
  catalogue: null,
  options: null,
  output: '',
  loading: false,

  setInput: (input, fileName) => set({ input, fileName }),
  setOptions: (options) => set({ options }),
  resetOptions: () => {
    const defaults = get().catalogue?.defaults;
    if (defaults) set({ options: structuredClone(defaults) });
  },

  async loadCatalogue() {
    if (get().catalogue) return;
    if (catalogueInflight) return catalogueInflight;
    catalogueInflight = (async () => {
      try {
        const raw = await ensureWorker().catalogue();
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          throw new Error('Malformed options catalogue: response is not JSON');
        }
        assertCatalogue(json);
        set({
          catalogue: json,
          options: applyHints(structuredClone(json.defaults), launchHints),
          catalogueError: undefined,
        });
      } catch (e) {
        set({ catalogueError: e instanceof Error ? e.message : String(e) });
      } finally {
        catalogueInflight = undefined;
      }
    })();
    return catalogueInflight;
  },

  applyLaunchHints(hints) {
    launchHints = hints;
    const opts = get().options;
    if (opts) set({ options: applyHints(opts, hints) });
  },

  async applyLaunchOptions(linkOptions) {
    await get().loadCatalogue();
    const { catalogue, options } = get();
    if (!catalogue) {
      // No catalogue to check the keys against: hand the object to the decompiler as is.
      set({ options: { ...applyHints({}, launchHints), ...linkOptions } });
      return [];
    }
    const { options: merged, ignored } = mergeLaunchOptions(
      catalogue,
      options ?? applyHints(structuredClone(catalogue.defaults), launchHints),
      linkOptions,
    );
    set({ options: merged });
    return ignored;
  },

  async decompile() {
    const input = get().input.replace(/\s+/g, '');
    if (!input) { set({ error: 'Paste compiled UPLC bytecode (hex) first.', output: '' }); return; }
    set({ loading: true, error: undefined });
    const t0 = performance.now();
    try {
      // Empty JSON → wasm web defaults. Pending link hints still ride along so a
      // `#decompile=…&v=v2` open does not wait on the catalogue.
      const opts = get().options ?? applyHints({}, launchHints);
      const optionsJson = JSON.stringify(opts);
      try {
        const code = await ensureWorker().decompile(input, optionsJson);
        set({ output: code, error: undefined, elapsedMs: Math.round(performance.now() - t0) });
      } finally {
        set({ lastRun: { input, optionsJson } });
      }
    } catch (e) {
      set({ output: '', error: e instanceof Error ? e.message : String(e), elapsedMs: undefined });
    } finally {
      set({ loading: false });
    }
  },
}));
