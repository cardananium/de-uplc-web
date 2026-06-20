/**
 * @de-uplc/core — platform-agnostic core for the de-uplc debugger.
 *
 * Contains NO `vscode`, `fs`, `path`, `react`, DOM or worker globals (enforced via eslint
 * `no-restricted-imports`). The platform supplies behaviour through the ports in `./ports`.
 */

// Domain types
export * from './common';
export * as DebuggerTypes from './debugger-types';

// Ports (platform-implemented interfaces)
export type {
  SettingsStore,
  ProviderSettings,
  OfflineData,
  NetworkPrompt,
  NetworkChoice,
  RefScriptResolver,
  ProviderResolver,
  IDebuggerEngineEvents,
  IDebuggerEngineRuntime,
  DebuggerManagerEvents,
} from './ports';

// Engine contract (the host-runner implements it; there is one live session per engine)
export type { IDebuggerEngine } from './debugger/debugger-engine.interface';

// Orchestration
export { DebuggerManager, ContextFillError, type DebuggerManagerDeps, type ContextFillReason } from './debugger/debugger-manager';
export { parseTransactionContext } from './debugger/parse-transaction-context';

// Data providers
export {
  type DataProvider,
  type DataProviderConfig,
  KoiosClient,
  KOIOS_ENDPOINTS,
  type KoiosClientConfig,
  FileProvider,
  type FileProviderConfig,
  type DataFile,
  createProviderResolver,
} from './data-providers';

// UPLC inspector trees (lazy-loading node model)
export type { NodeView, UplcNode } from './uplc-tree/nodes';
export { buildMachineStateRoots, buildContextRoots, buildEnvRoots } from './uplc-tree/roots';
// Lazy node-explorer: re-root a lazy tree at an arbitrary node + navigate on demand.
export { buildNodeChildren } from './uplc-tree/lazy-ref';
export type { LazyKind, DataSource } from './uplc-tree/lazy-ref';

// Term serializer (text + line↔termId locations + inlay hints; powers the Monaco term editor)
export {
  serializeTerm,
  findTermAtLine,
  findNearestTerm,
  termAtLineForBreakpoint,
} from './term-viewer/serialize';
export type {
  SerializedTerm,
  TermLocation,
  TermHintInfo,
  HintKind,
} from './term-viewer/serialize';
// Canonical UPLC pretty-printer (the alternate `uplc`-crate-style editor rendering).
export { serializeTermUplc } from './term-viewer/uplc-pretty';
