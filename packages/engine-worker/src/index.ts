import { wrap, releaseProxy, type Remote, type Endpoint } from 'comlink';
import { WasmEngineHostRunner } from './host-runner';
import type { IWasmEngineApi } from './worker-api';

export { WasmEngineHostRunner } from './host-runner';
export { WasmEngineApi, type IWasmEngineApi, type RunOutcome } from './worker-api';

export interface EngineHandle {
  engine: WasmEngineHostRunner;
  /** Reference-script resolver to inject into core's KoiosClient (single WASM instance). */
  refScriptResolver: (txHex: string, outputIndex: number) => Promise<string>;
  dispose: () => void;
}

/**
 * Wrap an already-created worker (or any Comlink endpoint) with a host-side runner.
 * The caller owns worker creation — in a Vite app that means
 * `new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' })`,
 * where that worker entry can inject the WASM URL via Vite's `?url` import. This keeps
 * @de-uplc/engine-worker free of bundler-specific syntax.
 */
export function connectEngine(endpoint: Worker | Endpoint, onFatal?: (info: string) => void): EngineHandle {
  const api = wrap<IWasmEngineApi>(endpoint as Endpoint) as Remote<IWasmEngineApi>;
  const engine = new WasmEngineHostRunner(api as unknown as IWasmEngineApi);

  // A worker that dies outside a try/catch (OOM, WASM abort, chunk-load failure) leaves every
  // in-flight Comlink promise unsettled and the UI wedged. Surface it once so the host can recover.
  if (onFatal && 'terminate' in endpoint) {
    const w = endpoint as Worker;
    let fired = false;
    const fire = (info: string) => { if (!fired) { fired = true; onFatal(info); } };
    w.addEventListener('error', (e) => fire((e as ErrorEvent).message || 'worker error'));
    w.addEventListener('messageerror', () => fire('worker message deserialization failed'));
  }

  return {
    engine,
    refScriptResolver: (txHex, outputIndex) => engine.getRefScriptBytes(txHex, outputIndex),
    dispose: () => {
      try {
        (api as unknown as { [releaseProxy]?: () => void })[releaseProxy]?.();
      } finally {
        if ('terminate' in endpoint) (endpoint as Worker).terminate();
      }
    },
  };
}
