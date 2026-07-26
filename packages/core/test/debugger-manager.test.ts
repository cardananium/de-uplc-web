import { describe, it, expect, vi } from 'vitest';
import { DebuggerManager, LOAD_PHASE } from '../src/debugger/debugger-manager';
import type { DebuggerContext, ProtocolParameters, UtxoOutput, UtxoReference } from '../src/common';
import type { IDebuggerEngineRuntime, NetworkChoice, NetworkPrompt, ProviderResolver } from '../src/ports';
import type { DataProvider } from '../src/data-providers/data-provider.interface';

// Tests for DebuggerManager.fillContextData — the riskiest non-trivial core logic
// (provider fallback offline→Koios, missing-UTXO detection + message, network prompt,
// params fallback). Every dependency is an interface, so plain inline fakes suffice.

const PARAMS = {} as ProtocolParameters; // manager only checks truthiness / passes it through
const utxo = (txHash: string, outputIndex: number): UtxoOutput =>
  ({ txHash, outputIndex, address: 'addr_test', value: { lovelace: '0' } });
const ref = (txHash: string, outputIndex: number): UtxoReference => ({ txHash, outputIndex });

interface FakeOpts {
  required?: UtxoReference[];
  offlineUtxos?: UtxoOutput[];
  onlineUtxos?: UtxoOutput[];
  offlineParams?: ProtocolParameters | 'throw';
  onlineParams?: ProtocolParameters | 'throw';
  selectNetwork?: () => Promise<NetworkChoice | undefined>;
  /** Collects the phases reported through the progress sink (see the progress describe below). */
  progress?: (phase: string) => void;
}

function setup(opts: FakeOpts) {
  const getRequiredUtxos = vi.fn(async () => opts.required ?? []);
  const engine = {
    getRequiredUtxos,
    openTransaction: vi.fn(async () => {}),
    initDebugSession: vi.fn(async () => {}),
    openProgram: vi.fn(async () => {}),
    openProgramParts: vi.fn(async () => {}),
  } as unknown as IDebuggerEngineRuntime;

  const mkProvider = (utxos: UtxoOutput[] | undefined, params: ProtocolParameters | 'throw' | undefined, name: string): DataProvider => ({
    getUtxoInfo: vi.fn(async () => utxos ?? []),
    getProtocolParameters: vi.fn(async () => {
      if (params === 'throw' || params === undefined) throw new Error(`${name}: no params`);
      return params;
    }),
    getProviderName: () => name,
  });
  const offline = mkProvider(opts.offlineUtxos, opts.offlineParams, 'offline');
  const online = mkProvider(opts.onlineUtxos, opts.onlineParams, 'koios');
  const providers: ProviderResolver = { getOnline: () => online, getOffline: () => offline };

  const selectNetwork = vi.fn(opts.selectNetwork ?? (async () => ({ network: 'mainnet' as const })));
  const networkPrompt: NetworkPrompt = { selectNetwork };

  const manager = new DebuggerManager(engine, { providers, networkPrompt, progress: opts.progress });
  return { manager, engine, getRequiredUtxos, offline, online, selectNetwork };
}

const ctx = (over: Partial<DebuggerContext> = {}): DebuggerContext =>
  ({ transaction: '84a0', utxos: undefined, protocolParams: undefined, network: undefined, ...over });

describe('DebuggerManager.fillContextData', () => {
  it('skips all fetching when utxos + params + network are already present', async () => {
    const { manager, getRequiredUtxos } = setup({});
    const input = ctx({ utxos: [utxo('aa', 0)], protocolParams: PARAMS, network: 'mainnet' });
    const out = await manager.fillContextData(input);
    expect(out.utxos).toEqual([utxo('aa', 0)]);
    expect(out.protocolParams).toBe(PARAMS);
    expect(getRequiredUtxos).not.toHaveBeenCalled();
  });

  it('falls through from offline (miss) to online for missing utxos', async () => {
    const { manager, offline, online } = setup({
      required: [ref('aa', 0)], offlineUtxos: [], onlineUtxos: [utxo('aa', 0)],
      offlineParams: PARAMS,
    });
    const out = await manager.fillContextData(ctx({ network: 'mainnet', protocolParams: PARAMS }));
    expect(out.utxos).toEqual([utxo('aa', 0)]);
    expect(offline.getUtxoInfo).toHaveBeenCalled();
    expect(online.getUtxoInfo).toHaveBeenCalled();
  });

  it('throws (with the unresolved ref) when a required utxo is fetchable from neither provider', async () => {
    const { manager } = setup({
      required: [ref('aa', 0), ref('bb', 1)], offlineUtxos: [utxo('aa', 0)], onlineUtxos: [],
      offlineParams: PARAMS,
    });
    await expect(manager.fillContextData(ctx({ network: 'mainnet', protocolParams: PARAMS })))
      .rejects.toThrow(/Unable to fetch required UTXOs[\s\S]*bb:1/);
  });

  it('prompts for a network when none is given, then proceeds', async () => {
    const { manager, selectNetwork } = setup({
      required: [], onlineParams: PARAMS, offlineParams: 'throw',
    });
    const out = await manager.fillContextData(ctx({ protocolParams: PARAMS, utxos: [] }));
    expect(selectNetwork).toHaveBeenCalledOnce();
    expect(out.network).toBe('mainnet');
  });

  it('throws when the network prompt is declined', async () => {
    const { manager } = setup({ selectNetwork: async () => undefined });
    await expect(manager.fillContextData(ctx())).rejects.toThrow(/Network selection is required/);
  });

  it('throws a wrapped error when protocol params are fetchable from neither provider', async () => {
    const { manager } = setup({
      offlineParams: 'throw', onlineParams: 'throw',
    });
    await expect(manager.fillContextData(ctx({ network: 'mainnet', utxos: [] })))
      .rejects.toThrow(/Unable to fetch protocol parameters/);
  });
});

// The progress sink is the only thing that can say WHICH step of a load is slow — and the steps
// with the interesting durations (a Koios round-trip for the UTXOs, then one for the parameters)
// are inside this class, so the UI cannot honestly guess them from outside. What is asserted here
// is the SEQUENCE: a phase reported out of order, or after the step it announces, is a UI that
// lies about what it is waiting on.
describe('DebuggerManager — load progress', () => {
  /** Run `fn` against a manager wired to a phase recorder, and return the phases in order. */
  async function phasesOf(opts: FakeOpts, fn: (m: DebuggerManager) => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const { manager } = setup({ ...opts, progress: (p) => seen.push(p) });
    await fn(manager).catch(() => { /* failing loads narrate too — that is the point */ });
    return seen;
  }

  it('narrates a full transaction load that has to fetch both UTXOs and parameters', async () => {
    const phases = await phasesOf(
      {
        required: [ref('aa', 0), ref('bb', 1)],
        offlineUtxos: [], onlineUtxos: [utxo('aa', 0), utxo('bb', 1)],
        offlineParams: 'throw', onlineParams: PARAMS,
      },
      // Plain CBOR hex: no network in the content, so the prompt step runs too.
      (m) => m.openTransaction('84a0'),
    );
    expect(phases).toEqual([
      LOAD_PHASE.parseTransaction,
      LOAD_PHASE.selectNetwork,
      LOAD_PHASE.requiredUtxos,
      'Fetching 2 UTXOs…',
      LOAD_PHASE.fetchParams,
      LOAD_PHASE.openTransaction,
    ]);
  });

  it('counts the UTXOs it is about to fetch, singular included', async () => {
    const one = await phasesOf(
      { required: [ref('aa', 0)], onlineUtxos: [utxo('aa', 0)], offlineParams: PARAMS },
      (m) => m.openTransaction('84a0'),
    );
    expect(one).toContain('Fetching 1 UTXO…');
    const many = await phasesOf(
      { required: [ref('aa', 0), ref('bb', 1), ref('cc', 2)], onlineUtxos: [utxo('aa', 0), utxo('bb', 1), utxo('cc', 2)], offlineParams: PARAMS },
      (m) => m.openTransaction('84a0'),
    );
    expect(many).toContain('Fetching 3 UTXOs…');
  });

  it('skips the phases whose work a self-contained context makes unnecessary', async () => {
    // A share link carries utxos + params + network, so the only honest narration is parse + open.
    const content = JSON.stringify({ transaction: '84a0', network: 'mainnet', utxos: [utxo('aa', 0)], protocolParams: PARAMS });
    const phases = await phasesOf({}, (m) => m.openTransaction(content));
    expect(phases).toEqual([LOAD_PHASE.parseTransaction, LOAD_PHASE.openTransaction]);
  });

  it('reports no fetch phase when the transaction requires no UTXOs at all', async () => {
    const phases = await phasesOf(
      { required: [], offlineParams: PARAMS },
      (m) => m.openTransaction('84a0'),
    );
    expect(phases).toEqual([
      LOAD_PHASE.parseTransaction, LOAD_PHASE.selectNetwork, LOAD_PHASE.requiredUtxos,
      LOAD_PHASE.fetchParams, LOAD_PHASE.openTransaction,
    ]);
  });

  it('stops narrating where a failed load stops — a declined network prompt reports nothing after it', async () => {
    const phases = await phasesOf(
      { selectNetwork: async () => undefined },
      (m) => m.openTransaction('84a0'),
    );
    expect(phases).toEqual([LOAD_PHASE.parseTransaction, LOAD_PHASE.selectNetwork]);
  });

  it('narrates the session-opening entry points too (they are loads with no transaction)', async () => {
    expect(await phasesOf({}, (m) => m.initDebugSession('Spending #0'))).toEqual([LOAD_PHASE.debugSession]);
    expect(await phasesOf({}, (m) => m.openProgram('(program 1.1.0 (con integer 42))', 'V3'))).toEqual([LOAD_PHASE.openProgram]);
    expect(await phasesOf({}, (m) => m.openProgramParts('{"script":"aa"}'))).toEqual([LOAD_PHASE.openParts]);
  });

  it('is optional, and a throwing sink never takes the load down with it', async () => {
    const { manager } = setup({ required: [], offlineParams: PARAMS });     // no progress at all
    await expect(manager.openTransaction('84a0')).resolves.toBeUndefined();
    const { manager: loud } = setup({
      required: [], offlineParams: PARAMS,
      progress: () => { throw new Error('sink exploded'); },
    });
    await expect(loud.openTransaction('84a0')).resolves.toBeUndefined();
  });
});
