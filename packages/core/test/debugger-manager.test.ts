import { describe, it, expect, vi } from 'vitest';
import { DebuggerManager } from '../src/debugger/debugger-manager';
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
}

function setup(opts: FakeOpts) {
  const getRequiredUtxos = vi.fn(async () => opts.required ?? []);
  const engine = { getRequiredUtxos } as unknown as IDebuggerEngineRuntime;

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

  const manager = new DebuggerManager(engine, { providers, networkPrompt });
  return { manager, getRequiredUtxos, offline, online, selectNetwork };
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
