import { Budget, DebuggerContext, UtxoReference } from "../common";
import {
    Term, ScriptContext,
    MachineContextLazy, MachineStateLazy, EnvLazy, ValueLazy,
    Profile, ProfileRunResult
} from "../debugger-types";

/**
 * The engine RPC contract. There is exactly ONE live session per engine — the worker
 * holds the single Rust SessionController — so no `sessionId` is threaded (that was a
 * vestige of the old extension's multi-session-by-id design). The concrete implementation
 * is the engine-worker host-runner.
 */
export interface IDebuggerEngine {
    // Transaction + session lifecycle
    openTransaction(context: DebuggerContext): Promise<void>;
    /** Open a context-free session from a plain UPLC program (text or hex) — no tx/redeemer/context.
     *  Leaves the session immediately ready to run (no initDebugSession step). */
    openProgram(programSrc: string, language: string): Promise<void>;
    /** Open a session from a validator + manually-supplied Data args (a PartsConfig JSON string:
     *  { script, language, context?, redeemer?, datum?, cost_models?, ex_units?, purpose? }) — no transaction. */
    openProgramParts(configJson: string): Promise<void>;
    getRedeemers(): Promise<string[]>;
    getTransactionId(): Promise<string>;
    initDebugSession(redeemer: string): Promise<void>;
    getRequiredUtxos(script: string): Promise<UtxoReference[]>;

    // Session reads
    getTxScriptContext(): Promise<ScriptContext>;
    /** The applied script context as CBOR hex (PlutusData), or "" for a context-free session. */
    getContextCbor(): Promise<string>;
    getPlutusLanguageVersion(): Promise<string | undefined>;
    /** The on-chain script hash, or "" when the session has no canonical script bytes to hash
     *  (a program given as UPLC text). Derived from the script bytes + language alone, so a parts
     *  deep-link reports it without a transaction. */
    getScriptHash(): Promise<string>;
    /** What the script is being run FOR — "Spending", "Minting", … derived from the script context
     *  (typed in tx mode, decoded from the applied Data in parts mode), or the label a parts link
     *  supplied itself. "" when neither source names one. */
    getScriptPurpose(): Promise<string>;
    getLogs(): Promise<string[]>;
    getBudget(): Promise<Budget | undefined>;
    getScript(): Promise<Term | undefined>;
    getCurrentTermId(): Promise<number | undefined>;

    // Lazy tree reads (path + returnFullObject; the UI re-walks the CURRENT state by path).
    // Return type depends on the path:
    // - getMachineStateLazy: MachineStateLazy (""), ValueLazy ("value.*"), EnvLazy ("env.*")
    // - getMachineContextLazy: MachineContextLazy[] (""), MachineContextLazy ("[i]"), ValueLazy/EnvLazy ("[i].field.*")
    // - getCurrentEnvLazy: EnvLazy (""), ValueLazy ("values[i].*")
    getMachineStateLazy(path: string, returnFullObject: boolean): Promise<MachineStateLazy | ValueLazy | EnvLazy>;
    getMachineContextLazy(path: string, returnFullObject: boolean): Promise<MachineContextLazy[] | MachineContextLazy | ValueLazy | EnvLazy>;
    getCurrentEnvLazy(path: string, returnFullObject: boolean): Promise<EnvLazy | ValueLazy>;

    /** Unified lazy read keyed by data source — the entry point the LazyRef tree cursor uses.
     *  Takes the path as segments and dispatches to the per-source method (one stringify at the boundary). */
    getLazy(source: 'machineState' | 'context' | 'env', path?: string[], returnFullObject?: boolean): Promise<unknown>;

    // Execution control
    start(): Promise<void>;
    continue(): Promise<void>;
    /** Advance one CEK step. Resolves `true` if the step COMPLETED the program (Done/Error) — in
     *  that case `onExecutionComplete` has already fired the result, so the caller must NOT re-mark
     *  the session as paused. Resolves `false` while the program is still mid-execution. */
    step(): Promise<boolean>;
    stop(): Promise<void>;
    pause(): Promise<void>;
    setBreakpointsList(breakpoints: number[]): Promise<void>;
    /** Throttle the run loop: ms to pause between CEK steps (0 = full speed). Set before start/continue. */
    setStepDelay(ms: number): void;

    // Profiler. A profile run is a SECOND machine built from the same entry term, so it never
    // touches the debug session's machine, budget, logs or current step. The chunk loop lives in
    // the host store (it owns the cancel flag and the whole-run step cap); the engine only knows
    // about one chunk at a time. `SessionController::reset()` — every Start/Restart/Stop — drops
    // the runner, so `profileRun` after that is invalid without a fresh `profileStart`.
    /** Create (or restart) the profile runner for the current session's entry term. */
    profileStart(): Promise<void>;
    /** Run at most `maxSteps` steps of the profile. `maxSteps` bounds the CHUNK, not the run:
     *  `outcome: 'Running'` means the program has not finished yet. steps/cpu/mem are cumulative
     *  since `profileStart()`. */
    profileRun(maxSteps: number): Promise<ProfileRunResult>;
    /** The full profile of whatever has run so far — valid mid-run and after a script failure. */
    profileReport(): Promise<Profile>;
}
