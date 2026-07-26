import { describe, it, expect } from 'vitest';
import { serializeTermUplc } from '../src/term-viewer/uplc-pretty';
import type { Constant, Term } from '../src/debugger-types';

describe('serializeTermUplc — canonical UPLC rendering', () => {
  it('renders apply / builtin (camelCase) / constant with one term per line', () => {
    const term: Term = {
      term_type: 'Apply', id: 1,
      function: { term_type: 'Builtin', id: 2, fun: 'VerifyEd25519Signature' }, // override → verifySignature
      argument: { term_type: 'Constant', id: 3, constant: { type: 'Integer', value: '42' } },
    };
    const { text, locations, hints } = serializeTermUplc(term);
    expect(text).toBe(['[', '  (builtin verifySignature)', '  (con integer 42)', ']'].join('\n'));
    expect(hints).toEqual([]);
    // Apply spans the whole thing (endLine INCLUSIVE here, unlike the tree serializer); children
    // sit on their own lines. `label` is the canonical builtin name in BOTH renderings.
    expect(locations).toEqual([
      { startLine: 0, endLine: 3, termId: 1, kind: 'Apply' },
      { startLine: 1, endLine: 1, termId: 2, kind: 'Builtin', label: 'verifySignature' },
      { startLine: 2, endLine: 2, termId: 3, kind: 'Constant' },
    ]);
  });

  it('renders lambda, delay, force, error and bare vars', () => {
    const term: Term = {
      term_type: 'Lambda', id: 1, parameterName: 'x',
      body: {
        term_type: 'Force', id: 2,
        term: { term_type: 'Delay', id: 3, term: { term_type: 'Var', id: 4, name: 'x' } },
      },
    };
    expect(serializeTermUplc(term).text).toBe(
      ['(lam x', '  (force', '    (delay', '      x', '    )', '  )', ')'].join('\n'),
    );
    expect(serializeTermUplc({ term_type: 'Error', id: 9 }).text).toBe('(error)');
  });

  it('renders constants: bytestring, bool, unit, list and data', () => {
    const con = (c: Constant): string =>
      serializeTermUplc({ term_type: 'Constant', id: 1, constant: c }).text;
    expect(con({ type: 'ByteString', value: 'deadbeef' })).toBe('(con bytestring #deadbeef)');
    expect(con({ type: 'Bool', value: false })).toBe('(con bool False)');
    expect(con({ type: 'Unit' })).toBe('(con unit ())');
    expect(con({ type: 'ProtoList', elementType: { type: 'Integer' }, values: [
      { type: 'Integer', value: '1' }, { type: 'Integer', value: '2' },
    ] })).toBe('(con (list integer) [1, 2])');
    // Data: Constr tag 121 → constructor index 0; with a B field.
    expect(con({ type: 'Data', data: {
      type: 'Constr', tag: 121, fields: [{ type: 'BoundedBytes', value: 'ab' }],
    } })).toBe('(con data (Constr 0 [B #ab]))');
  });
});
