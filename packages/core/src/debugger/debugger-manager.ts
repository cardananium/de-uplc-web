import { parseTransactionContext } from './parse-transaction-context';
import {
  DebuggerContext,
  Network,
  UtxoOutput,
  UtxoReference,
  ProtocolParameters,
} from '../common';
import {
  DebuggerManagerEvents,
  IDebuggerEngineRuntime,
  NetworkPrompt,
  ProviderResolver,
} from '../ports';

/** Why filling a transaction's missing context (UTXOs / params / network) failed. */
export type ContextFillReason =
  | 'network-cancelled'   // the user declined the network prompt (not really an error)
  | 'utxos-unfetchable'   // no provider could return the required UTXOs
  | 'params-unfetchable'; // no provider could return protocol parameters

/** Typed failure from `fillContextData`, so the UI can react to the reason (native `Error.cause`). */
export class ContextFillError extends Error {
  constructor(readonly reason: ContextFillReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContextFillError';
  }
}

export interface DebuggerManagerDeps {
  /** Builds online/offline data providers from current settings. */
  providers: ProviderResolver;
  /** Asks the user to choose a network / custom endpoint when the context lacks one. */
  networkPrompt: NetworkPrompt;
  /** Optional sink for breakpoint/finished/error events (the app store implements it). */
  events?: DebuggerManagerEvents;
}

/**
 * Platform-agnostic orchestration of a debugging session. Ported from the VS Code
 * `DebuggerManager`, with all `vscode`/`fs` removed:
 *  - the engine is injected (`IDebuggerEngineRuntime`) instead of `new WasmEngineHostRunner()`
 *  - `openTransaction(content)` takes file *content* (parsed via `parseTransactionContext`)
 *  - network selection goes through the `NetworkPrompt` port (was `window.showQuickPick`)
 *  - data providers come from the injected `ProviderResolver` (was vscode config singletons)
 *  - engine events are forwarded to the injected `DebuggerManagerEvents` (was the vscode EventEmitter)
 */
export class DebuggerManager {
  private currentSession: IDebuggerEngineRuntime | undefined;
  /** The fully-resolved context of the last opened tx (utxos + protocol params filled in, e.g. via
   *  Koios). Retained so callers can export a self-contained, network-free copy. */
  private lastResolvedContext: DebuggerContext | undefined;

  constructor(
    private readonly engine: IDebuggerEngineRuntime,
    private readonly deps: DebuggerManagerDeps,
  ) {
    this.attachEngineSubscriptions();
  }

  public async openTransaction(content: string): Promise<void> {
    const context = parseTransactionContext(content);
    const filledContext = await this.fillContextData(context);
    this.lastResolvedContext = filledContext;
    await this.engine.openTransaction(filledContext);
  }

  /**
   * The last opened tx as a self-contained `DebuggerContext` JSON — transaction + the UTXOs and
   * protocol params that were resolved at load time (including anything fetched from Koios). Re-loads
   * with NO network, since `fillContextData` skips fetching when those are already present. The
   * `customEndpoint` is dropped (it's irrelevant once the context is filled, and may be private).
   */
  public getResolvedContextJson(): string | undefined {
    if (!this.lastResolvedContext) return undefined;
    const { customEndpoint: _drop, ...selfContained } = this.lastResolvedContext;
    return JSON.stringify(selfContained);
  }

  private attachEngineSubscriptions() {
    this.engine.onBreakpoint = (termId: number) => {
      this.deps.events?.onBreakpoint(termId);
    };

    // Throttled-run tick — return the pull promise so the engine awaits it before the next step.
    this.engine.onStep = () => this.deps.events?.onStep?.();

    this.engine.onExecutionComplete = (result, termId: number, isInfraError: boolean) => {
      if (result.status_type === 'Done') {
        this.deps.events?.onFinished(result.result, termId);
      } else if (result.status_type === 'Error') {
        this.deps.events?.onError(result.message, termId, isInfraError);
      } else {
        this.deps.events?.onError(`Unexpected execution status: ${JSON.stringify(result)}`, termId, true);
      }
    };
  }

  public async getRedeemers(): Promise<string[]> {
    return this.engine.getRedeemers();
  }

  public async getTransactionId(): Promise<string> {
    return this.engine.getTransactionId();
  }

  public async initDebugSession(redeemer: string): Promise<IDebuggerEngineRuntime> {
    await this.engine.initDebugSession(redeemer);
    this.currentSession = this.engine;
    return this.engine;
  }

  /**
   * Open a context-free debug session straight from a plain UPLC program (text or hex) — no
   * transaction, redeemer, datum or script context. Returns the live session, like initDebugSession.
   */
  public async openProgram(programSrc: string, language: string): Promise<IDebuggerEngineRuntime> {
    await this.engine.openProgram(programSrc, language);
    this.currentSession = this.engine;
    return this.engine;
  }

  /** Open a session from a validator + manually-supplied Data args (PartsConfig JSON) — no tx. */
  public async openProgramParts(configJson: string): Promise<IDebuggerEngineRuntime> {
    await this.engine.openProgramParts(configJson);
    this.currentSession = this.engine;
    return this.engine;
  }

  public getCurrentSession(): IDebuggerEngineRuntime | undefined {
    return this.currentSession;
  }

  public async terminateDebugging(): Promise<void> {
    if (this.currentSession) {
      await this.currentSession.stop();
      this.currentSession = undefined;
    }
  }

  public async setBreakpoints(breakpoints: number[]): Promise<void> {
    if (this.currentSession) {
      await this.currentSession.setBreakpointsList(breakpoints);
    }
  }

  /**
   * Fills missing data in DebuggerContext:
   * 1. If the context already has the data, don't fetch it.
   * 2. Otherwise try the offline provider first, then Koios.
   */
  public async fillContextData(context: DebuggerContext): Promise<DebuggerContext> {
    const filledContext = { ...context };

    // Ensure a network is selected before fetching any network-dependent data.
    if (!filledContext.network) {
      const choice = await this.deps.networkPrompt.selectNetwork();
      if (!choice) {
        throw new ContextFillError('network-cancelled', 'Network selection is required to proceed.');
      }
      filledContext.network = choice.network;
      if (choice.customEndpoint) {
        filledContext.customEndpoint = choice.customEndpoint;
      }
    }

    const network: Network = filledContext.network as Network;

    // Fill UTXOs if missing
    if (!filledContext.utxos) {
      try {
        const requiredUtxos = await this.engine.getRequiredUtxos(context.transaction);
        if (requiredUtxos.length > 0) {
          filledContext.utxos = await this.fetchUtxos(requiredUtxos, network, filledContext.customEndpoint);

          const fetchedUtxos = filledContext.utxos;
          const missingUtxos = requiredUtxos.filter(utxo =>
            !fetchedUtxos.find(u => u.txHash === utxo.txHash && u.outputIndex === utxo.outputIndex)
          );

          if (missingUtxos.length > 0) {
            throw new Error(`Failed to fetch ${missingUtxos.length} required UTXOs: ${missingUtxos.map(u => `${u.txHash}:${u.outputIndex}`).join(', ')}`);
          }
        }
      } catch (error) {
        if (error instanceof ContextFillError) throw error;
        throw new ContextFillError('utxos-unfetchable', `Unable to fetch required UTXOs: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    // Fill protocol parameters if missing
    if (!filledContext.protocolParams) {
      try {
        filledContext.protocolParams = await this.fetchProtocolParameters(network, filledContext.customEndpoint);
        if (!filledContext.protocolParams) {
          throw new Error('Protocol parameters are required but could not be fetched from any provider');
        }
      } catch (error) {
        if (error instanceof ContextFillError) throw error;
        throw new ContextFillError('params-unfetchable', `Unable to fetch protocol parameters: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }

    return filledContext;
  }

  /** Fetches UTXOs with fallback: offline provider first, then Koios. */
  private async fetchUtxos(requiredUtxos: UtxoReference[], network: Network, customEndpoint?: string): Promise<UtxoOutput[]> {
    const offlineDataProvider = this.deps.providers.getOffline();
    const dataProvider = this.deps.providers.getOnline(customEndpoint, network);
    let utxos: UtxoOutput[] = [];
    let missingUtxos = [...requiredUtxos];

    // Try offline provider first
    try {
      utxos = await offlineDataProvider.getUtxoInfo(requiredUtxos, network);
      missingUtxos = requiredUtxos.filter(utxo =>
        !utxos.find(u => u.txHash === utxo.txHash && u.outputIndex === utxo.outputIndex)
      );
    } catch (error) {
      console.warn('Offline provider failed to fetch UTXOs:', error);
    }

    // If there are still missing UTXOs, try Koios
    if (missingUtxos.length > 0) {
      try {
        const additionalUtxos = await dataProvider.getUtxoInfo(missingUtxos, network);
        utxos = [...utxos, ...additionalUtxos];
      } catch (error) {
        console.warn('Koios provider failed to fetch UTXOs:', error);
      }
    }

    return utxos;
  }

  /** Fetches protocol parameters with fallback: offline provider first, then Koios. */
  private async fetchProtocolParameters(network: Network, customEndpoint?: string): Promise<ProtocolParameters | undefined> {
    const offlineDataProvider = this.deps.providers.getOffline();

    // Try offline provider first
    try {
      return await offlineDataProvider.getProtocolParameters(network);
    } catch (error) {
      console.warn('Offline provider failed to fetch protocol parameters:', error);
    }

    // If offline provider failed, try Koios
    try {
      const dataProvider = this.deps.providers.getOnline(customEndpoint, network);
      return await dataProvider.getProtocolParameters(network);
    } catch (error) {
      console.warn('Koios provider failed to fetch protocol parameters:', error);
      return undefined;
    }
  }
}
