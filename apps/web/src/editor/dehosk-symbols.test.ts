import { describe, expect, it } from 'vitest';
import { scanSymbols, type Definition } from './dehosk-symbols';

const DECOMPILED = `// Note: church-bool polarity detected as InverseCip — a HEURISTIC.
const k = [0]  // church-cons
const d_result = d(1)
const d_result_result = d_result(2)
const t = Constr<0>(Constr<1>, [1])
const u = Constr<0>(Constr<1>, k)

validator decompiled {
  propose(script_context: ScriptContext) {
    let governance_action = when script_context.script_info is {
      Proposing(_index, proposal_procedure) -> proposal_procedure
      _ -> fail
    }.governance_action
    let match_subject_0 =
      when governance_action is {
        ProtocolParameters(_ancestor, new_parameters, _guardrails) ->
          Some(i(builtin.un_map_data(new_parameters)))
        _ -> fail
      }
  }
}
`;

function flatten(defs: Definition[]): string[] {
  return defs.flatMap((d) => [`${d.name}:${d.kind}`, ...flatten(d.children)]);
}

describe('scanSymbols on real decompiled output', () => {
  const index = scanSymbols(DECOMPILED);

  it('finds the top-level consts in declaration order', () => {
    const consts = index.definitions.filter((d) => d.kind === 'const').map((d) => d.name);
    expect(consts).toEqual(['k', 'd_result', 'd_result_result', 't', 'u']);
  });

  it('nests the purpose handler under the validator, and its params under it', () => {
    const validator = index.definitions.find((d) => d.kind === 'validator');
    expect(validator?.name).toBe('decompiled');
    expect(flatten(validator ? [validator] : [])).toEqual([
      'decompiled:validator',
      'propose:purpose',
      'script_context:param',
      'governance_action:let',
      'match_subject_0:let',
    ]);
  });

  it('points a definition at its own name token, not at the whole line', () => {
    const def = index.defByName.get('d_result');
    expect(def?.nameRange).toEqual({ startLine: 3, startCol: 7, endLine: 3, endCol: 15 });
  });

  it('resolves later uses of a const back to it', () => {
    const refs = index.refsByName.get('d_result') ?? [];
    expect(refs.map((r) => r.range.startLine)).toEqual([3, 4]);
  });

  it('resolves a param where it is used in the body', () => {
    const lines = (index.refsByName.get('script_context') ?? []).map((r) => r.range.startLine);
    expect(lines).toContain(10);
  });

  it('takes the head of a qualified name and not its tail', () => {
    expect(index.refsByName.has('script_info')).toBe(false);
  });

  it('ignores keywords, constructors and types', () => {
    for (const name of ['when', 'is', 'let', 'const', 'fail', 'Proposing', 'ScriptContext', 'Some']) {
      expect(index.defByName.has(name), name).toBe(false);
      expect(index.refsByName.has(name), name).toBe(false);
    }
  });

  it('ignores identifiers that only appear inside comments', () => {
    expect(index.refsByName.has('church')).toBe(false);
    expect(index.refsByName.has('HEURISTIC')).toBe(false);
  });

  it('returns nothing rather than throwing on input with no definitions', () => {
    const empty = scanSymbols('// nothing here\n');
    expect(empty.definitions).toEqual([]);
    expect(empty.references).toEqual([]);
  });
});
