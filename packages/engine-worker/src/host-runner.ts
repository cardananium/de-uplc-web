import type {
  IDebuggerEngine,
  IDebuggerEngineRuntime,
  Budget,
  DebuggerContext,
  UtxoReference,
  DebuggerTypes,
} from '@de-uplc/core';
import type { IWasmEngineApi } from './worker-api';

const decoder = new TextDecoder();
/** Decode a transferable ArrayBuffer (JSON bytes) back into an object. */
function decodeJson<T>(buffer: ArrayBuffer): T {
  return JSON.parse(decoder.decode(buffer)) as T;
}

/**
 * Steps run per worker batch. The worker checks breakpoints per step (so hits are exact);
 * the host re-checks stop/pause between batches, so pause latency is ≤ this many steps while
 * the per-step Comlink round-trip is amortised ~512×.
 */
const RUN_BATCH = 512;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Host-side engine. Implements `IDebuggerEngine` + the push events, delegating each call
 * to the worker-side `IWasmEngineApi` over Comlink (or directly, in-process, for tests).
 *  - There is one live session per engine, so no `sessionId` is threaded.
 *  - The run-until-breakpoint loop runs in the WORKER, driven here in batches of `RUN_BATCH`
 *    steps: the worker checks breakpoints per step (exact hits) and the host re-checks its
 *    stop/pause flags between batches. This keeps the pause/breakpoint invariant while
 *    amortising the Comlink round-trip ~RUN_BATCH× (no SharedArrayBuffer needed).
 *  - Large results arrive as transferable ArrayBuffers and are decoded here.
 */
export class WasmEngineHostRunner implements IDebuggerEngineRuntime, IDebuggerEngine {
  private breakpoints: number[] = [];
  private needStop = false;
  private isPaused = false;
  private hasSession = false;
  private runUntilBreakpointPromise: Promise<void> | undefined;
  private isExecuting = false;
  // True while resuming from a pause: the first batch must NOT re-check the breakpoint the
  // machine is currently sitting on (breakpoints pause BEFORE the term runs), or continue
  // would immediately re-trigger and never make progress.
  private resuming = false;
  // ms to pause between steps during a run (0 = full speed). When > 0 the loop steps ONE at a
  // time and fires onStep between, so the UI animates ("playback").
  private stepDelay = 0;

  // Push events (IDebuggerEngineEvents), assigned by DebuggerManager.
  public onBreakpoint: ((termId: number) => void) | undefined;
  public onStep: (() => void | Promise<void>) | undefined;
  public onExecutionComplete:
    | ((result: DebuggerTypes.ExecutionStatus, termId: number, isInfraError: boolean) => void)
    | undefined;

  constructor(private readonly api: IWasmEngineApi) {}

  // --- transaction + session lifecycle ---------------------------------------

  async getRequiredUtxos(script: string): Promise<UtxoReference[]> {
    return decodeJson<UtxoReference[]>(await this.api.getRequiredUtxos(script));
  }

  async openTransaction(context: DebuggerContext): Promise<void> {
    return this.api.openTransaction(context);
  }

  async openProgram(programSrc: string, language: string): Promise<void> {
    await this.api.openProgram(programSrc, language);
    this.hasSession = true; // a bare program yields a ready session directly (no initDebugSession)
  }

  async openProgramParts(configJson: string): Promise<void> {
    await this.api.openProgramParts(configJson);
    this.hasSession = true;
  }

  async getRedeemers(): Promise<string[]> {
    return this.api.getRedeemers();
  }

  async getTransactionId(): Promise<string> {
    return this.api.getTransactionId();
  }

  async initDebugSession(redeemer: string): Promise<void> {
    await this.api.initDebugSession(redeemer);
    this.hasSession = true;
  }

  // --- session reads ---------------------------------------------------------

  async getTxScriptContext(): Promise<DebuggerTypes.ScriptContext> {
    return decodeJson(await this.api.getTxScriptContext());
  }

  async getContextCbor(): Promise<string> {
    return this.api.getContextCbor();
  }

  async getPlutusLanguageVersion(): Promise<string | undefined> {
    return this.api.getPlutusLanguageVersion();
  }

  async getScriptHash(): Promise<string> {
    return this.api.getScriptHash();
  }

  async getLogs(): Promise<string[]> {
    if (this.isExecuting) return [];
    return decodeJson(await this.api.getLogs());
  }

  async getBudget(): Promise<Budget | undefined> {
    if (this.isExecuting) return undefined;
    return decodeJson(await this.api.getBudget());
  }

  async getScript(): Promise<DebuggerTypes.Term | undefined> {
    return decodeJson(await this.api.getScript());
  }

  async getCurrentTermId(): Promise<number | undefined> {
    if (this.isExecuting) return undefined;
    return this.api.getCurrentTermId();
  }

  async getMachineStateLazy(path: string, returnFullObject: boolean): Promise<any> {
    if (this.isExecuting) return undefined;
    return decodeJson(await this.api.getMachineStateLazy(path, returnFullObject));
  }

  async getMachineContextLazy(path: string, returnFullObject: boolean): Promise<any> {
    if (this.isExecuting) return [];
    return decodeJson(await this.api.getMachineContextLazy(path, returnFullObject));
  }

  async getCurrentEnvLazy(path: string, returnFullObject: boolean): Promise<any> {
    if (this.isExecuting) return undefined;
    return decodeJson(await this.api.getCurrentEnvLazy(path, returnFullObject));
  }

  /** Dispatch a path-segments lazy read to the matching per-source method (one JSON.stringify here). */
  getLazy(source: 'machineState' | 'context' | 'env', path: string[] = [], returnFullObject = false): Promise<unknown> {
    const p = JSON.stringify(path);
    switch (source) {
      case 'machineState': return this.getMachineStateLazy(p, returnFullObject);
      case 'context': return this.getMachineContextLazy(p, returnFullObject);
      case 'env': return this.getCurrentEnvLazy(p, returnFullObject);
    }
  }

  // --- execution control -----------------------------------------------------

  async start(): Promise<void> {
    if (this.isExecuting) return;
    this.needStop = false;
    this.isPaused = false;
    this.resuming = false; // fresh run: check the very first term (e.g. a breakpoint on the root)
    this.runUntilBreakpointPromise = this.runUntilBreakpoint();
  }

  async continue(): Promise<void> {
    this.needStop = false;
    if (!this.isPaused) {
      return this.start();
    }
    if (this.isExecuting) return;
    this.isPaused = false;
    this.resuming = true; // step OFF the breakpoint we're paused on before checking again
    this.runUntilBreakpointPromise = this.runUntilBreakpoint();
  }

  async step(): Promise<boolean> {
    const outcome = await this.api.step();
    // A single step can END the program. Fire the same completion path as the run loop so the
    // store transitions to Done/Error (status, runMs, toast) instead of staying stuck on "paused",
    // and tell the caller it terminated so it doesn't re-mark the session paused.
    if (outcome.outcome === 'done' || outcome.outcome === 'error') {
      this.needStop = true;
      this.isPaused = false;
      this.onExecutionComplete?.(outcome.status, outcome.termId, false);
      return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    this.needStop = true;
    this.isPaused = false;
    if (this.runUntilBreakpointPromise) {
      try {
        await this.runUntilBreakpointPromise;
      } catch (error) {
        console.error('[Host] Error waiting for execution to stop:', error);
      }
    }
    await this.api.stop();
  }

  async pause(): Promise<void> {
    if (this.isPaused) return;
    this.isPaused = true;
    this.needStop = true;
    if (this.runUntilBreakpointPromise) {
      try {
        await this.runUntilBreakpointPromise;
      } catch (error) {
        console.error('[Host] Error waiting for execution to pause:', error);
      }
    }
  }

  async setBreakpointsList(breakpoints: number[]): Promise<void> {
    this.breakpoints = [...breakpoints];
  }

  setStepDelay(ms: number): void {
    this.stepDelay = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
  }

  // --- run-until-breakpoint loop (stays on the host) -------------------------

  private async runUntilBreakpoint(): Promise<void> {
    if (!this.hasSession) return;
    this.isExecuting = true;
    let firstBatch = true;
    try {
      while (!this.needStop) {
        // Only the first batch of a resume skips its current term (the breakpoint we're paused
        // on); every other batch — including all of a fresh start — checks its first term.
        const checkFirstTerm = !(firstBatch && this.resuming);
        firstBatch = false;
        // Playback: step one-at-a-time so onStep can animate between; else the fast 512-batch.
        const slow = this.stepDelay > 0;
        this.isExecuting = true; // re-assert each iteration (slow mode clears it between steps)
        let result;
        try {
          // The loop runs in the worker (no per-step round-trip); breakpoints checked per step.
          result = await this.api.stepUntilBreakpointOrLimit(this.breakpoints, slow ? 1 : RUN_BATCH, checkFirstTerm);
        } catch (error) {
          console.error('[Host] Error during execution:', error);
          this.needStop = true;
          this.isPaused = false;
          // Clear run-active BEFORE the callback so the store's pull reads real data
          // synchronously (the mid-run guards return undefined/[] while this is true).
          this.isExecuting = false;
          this.onExecutionComplete?.(
            {
              status_type: 'Error',
              message: error instanceof Error ? error.message : 'Unknown error',
            },
            -1, // sentinel: no current term on the error path
            true, // the transport/engine threw — an infrastructure crash, not a script result
          );
          break;
        }

        if (result.outcome === 'breakpoint') {
          this.isPaused = true;
          this.isExecuting = false;
          this.onBreakpoint?.(result.termId);
          break;
        }
        if (result.outcome === 'done' || result.outcome === 'error') {
          this.needStop = true;
          this.isExecuting = false; // clear before the callback (see above) — finally is the stop/pause backstop
          this.onExecutionComplete?.(result.status, result.termId, false); // a normal Done/CEK-Error result
          break;
        }
        // 'limit' → batch exhausted without a stop reason.
        if (slow) {
          // One step done — make the state readable (mid-run guards off), let the UI pull +
          // render, honour a stop requested during the tick, then throttle before the next step.
          this.isExecuting = false;
          try { await this.onStep?.(); } catch (e) { console.error('[Host] onStep failed:', e); }
          if (this.needStop) break;
          await sleep(this.stepDelay);
        }
        // else: loop re-checks needStop and continues the next 512-batch.
      }
    } finally {
      this.isExecuting = false;
      this.runUntilBreakpointPromise = undefined;
    }
  }

  // --- profiler (typed pass-through; the chunk loop lives in the host store) --

  profileStart(): Promise<void> {
    return this.api.profileStart();
  }

  /** One chunk, at most `maxSteps` steps. The whole-run step cap and the cancel flag belong to the
   *  store: this call knows nothing but its own chunk, and `Running` means "not finished yet". */
  profileRun(maxSteps: number): Promise<DebuggerTypes.ProfileRunResult> {
    return this.api.profileRun(maxSteps);
  }

  /** The full profile, decoded HERE — the store never sees bytes. */
  async profileReport(): Promise<DebuggerTypes.Profile> {
    return decodeJson<DebuggerTypes.Profile>(await this.api.profileReport());
  }

  // --- extras ----------------------------------------------------------------

  /** Reference-script bytes from tx CBOR via the single WASM instance (core's RefScriptResolver). */
  getRefScriptBytes(txHex: string, outputIndex: number): Promise<string> {
    return this.api.getRefScriptBytes(txHex, outputIndex);
  }
}
