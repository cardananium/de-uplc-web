/**
 * Platform ports — the interfaces the platform-agnostic core depends on but does
 * NOT implement; the web shell (apps/web) provides the browser implementations.
 * Keeping core behind these ports is what lets it stay free of `vscode`, `fs`,
 * `path`, DOM and worker globals.
 */
import { Network } from './common';
import { ExecutionStatus, Term } from './debugger-types';
import { DataProvider } from './data-providers/data-provider.interface';
import { IDebuggerEngine } from './debugger/debugger-engine.interface';

// ---------------------------------------------------------------------------
// I/O ports
// ---------------------------------------------------------------------------

/** Persistent provider settings (browser: localStorage). */
export interface ProviderSettings {
  apiKey?: string;
  timeout: number;
  retryAttempts: number;
  offlineEnabled: boolean;
  /** Network to assume when a transaction context carries none (browser: NetworkPrompt default). */
  defaultNetwork: Network;
}

/** Offline data bundled/loaded by the user (UTXOs + protocol params). */
export interface OfflineData {
  utxos: import('./common').UtxoOutput[];
  protocolParams: import('./common').ProtocolParameters;
}

export interface SettingsStore {
  getProviderSettings(): ProviderSettings;
  /** Current offline data, if the user loaded any; `undefined` otherwise. */
  getOfflineData(): OfflineData | undefined;
}

/** Network/endpoint selection (browser: modal). */
export interface NetworkChoice {
  network: Network;
  customEndpoint?: string;
}
export interface NetworkPrompt {
  /** Returns the chosen network (+ optional custom Koios URL), or `undefined` if cancelled. */
  selectNetwork(): Promise<NetworkChoice | undefined>;
}

/**
 * Resolves reference-script bytes from a transaction CBOR via the single WASM instance.
 * In the web app this is backed by the engine worker (`get_ref_script_bytes`), so the
 * Koios client never imports the WASM module directly.
 */
export type RefScriptResolver = (txHex: string, outputIndex: number) => Promise<string> | string;

/**
 * Sink for short, human-readable LOAD PHASES ("Fetching 8 UTXOs…"), reported as each step of a
 * load STARTS. A plain callback on purpose: core must stay free of DOM/React, and the only thing a
 * host needs is the latest string (the web store keeps it in `loadingPhase` and renders it beside a
 * spinner; a CLI could print it). Fire-and-forget — the return value is ignored and a sink must
 * never throw, since a load is not allowed to fail because its narration did.
 */
export type LoadProgress = (phase: string) => void;

/** Builds data providers from the current settings. */
export interface ProviderResolver {
  /**
   * Online provider. With an explicit `customEndpoint` it is used as-is; otherwise Koios
   * is called directly at `KOIOS_ENDPOINTS[network]` (the network is resolved per request
   * inside the client, so the `network` arg here is advisory only).
   */
  getOnline(customEndpoint?: string, network?: Network): DataProvider;
  getOffline(): DataProvider;
}

// ---------------------------------------------------------------------------
// Engine event surface
// ---------------------------------------------------------------------------

/**
 * The push-event side of the debugger engine. The RPC surface is `IDebuggerEngine`;
 * the concrete host-runner (engine-worker) also exposes these callbacks. Kept separate
 * so `IDebuggerEngine` stays a pure request/response contract. (onStop/onPause were
 * dropped — the store drives stop/pause synchronously and never consumed those events.)
 */
export interface IDebuggerEngineEvents {
  onBreakpoint?: (termId: number) => void;
  /** Fired after each step of a THROTTLED run (stepDelay > 0) so the UI can animate; awaited
   *  by the run loop so the inspector pull completes before the next step. */
  onStep?: () => void | Promise<void>;
  /** `isInfraError`: true if the engine/transport crashed (vs a genuine CEK script failure, which is a result). */
  onExecutionComplete?: (result: ExecutionStatus, termId: number, isInfraError: boolean) => void;
}

/** The full engine as the host-runner exposes it: RPC contract + push events. */
export type IDebuggerEngineRuntime = IDebuggerEngine & IDebuggerEngineEvents;

/** Sink for high-level debugger events. The app store implements this. */
export interface DebuggerManagerEvents {
  onBreakpoint(termId: number): void;
  /** Fired after each step of a throttled (stepDelay>0) run — the store re-pulls inspectors so
   *  the run animates. Returns the pull promise so the engine can await it before stepping on. */
  onStep?(): void | Promise<void>;
  onFinished(term: Term, termId: number): void;
  /** `isInfraError`: an engine/transport crash (alarm) vs a script that legitimately failed validation (a result). */
  onError(message: string, termId: number, isInfraError: boolean): void;
}
