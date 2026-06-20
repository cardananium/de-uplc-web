import { expose } from 'comlink';
import { WasmEngineApi } from './worker-api';

// Browser module Web Worker entry. Comlink's `expose` defaults its endpoint to `globalThis`,
// which in a dedicated worker is the worker scope (has postMessage/addEventListener).
// The WASM is fetched + instantiated lazily on the first API call (WasmEngineApi.ensureReady →
// init()), so spawning the worker itself is cheap.
expose(new WasmEngineApi());
