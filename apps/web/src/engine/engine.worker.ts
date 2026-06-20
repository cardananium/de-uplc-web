import { expose } from 'comlink';
import { WasmEngineApi } from '@de-uplc/engine-worker';
// Vite emits the wasm as a hashed asset and gives us its served URL. We pass it explicitly to
// init() (inside WasmEngineApi.ensureReady) rather than relying on the wasm-bindgen glue's
// default `new URL('de_uplc_bg.wasm', import.meta.url)` fetch, which is unreliable once the glue
// is bundled into the worker chunk.
import wasmUrl from '@de-uplc/engine-wasm/de_uplc_bg.wasm?url';

expose(new WasmEngineApi(wasmUrl));
