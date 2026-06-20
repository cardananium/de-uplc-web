import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect, beforeAll } from 'vitest';
import { Registry, INITIAL, type IGrammar, type IRawGrammar } from 'vscode-textmate';
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma';
import uplcGrammar from './grammars/uplc.tmLanguage.json';
import plutusTypesGrammar from './grammars/plutus-types.tmLanguage.json';

// Node-side tokenization snapshot. Proves the Oniguruma WASM + vscode-textmate
// stack tokenizes the serializer's UPLC output (and the plutus-types JSON the
// data viewer renders), and guards the grammars against regressions. Uses the
// same grammar objects the browser bridge feeds Monaco.

const require = createRequire(import.meta.url);

let registry: Registry;

beforeAll(async () => {
  const wasmPath = require.resolve('vscode-oniguruma/release/onig.wasm');
  const wasmBuf = readFileSync(wasmPath);
  const ab = wasmBuf.buffer.slice(wasmBuf.byteOffset, wasmBuf.byteOffset + wasmBuf.byteLength);
  await loadWASM(ab);
  registry = new Registry({
    onigLib: Promise.resolve({ createOnigScanner, createOnigString }),
    loadGrammar: async (scope) => {
      if (scope === 'source.uplc') return uplcGrammar as unknown as IRawGrammar;
      if (scope === 'source.plutus-types-json') return plutusTypesGrammar as unknown as IRawGrammar;
      return null;
    },
  });
});

/** Tokenize multi-line text, threading the rule stack; return [startIndex, mostSpecificScope] per token. */
function tokenize(grammar: IGrammar, text: string): Array<{ line: string; tokens: Array<[number, string]> }> {
  const lines = text.split('\n');
  let stack = INITIAL;
  return lines.map((line) => {
    const r = grammar.tokenizeLine(line, stack);
    stack = r.ruleStack;
    return {
      line,
      tokens: r.tokens.map((t) => [t.startIndex, t.scopes[t.scopes.length - 1]] as [number, string]),
    };
  });
}

describe('UPLC grammar tokenization', () => {
  // A representative slice of serializer output: Apply / λ Lambda / Built-in /
  // Var / Const Integer (numeric capture) / Const String / field labels.
  const source = [
    'Apply {',
    '  fun: λ x {',
    '    body: Built-in addInteger',
    '  },',
    '  arg: Apply {',
    '    fun: Var x,',
    '    arg: Const Integer: "42"',
    '  }',
    '}',
  ].join('\n');

  it('matches the token snapshot', async () => {
    const grammar = await registry.loadGrammar('source.uplc');
    expect(grammar).toBeTruthy();
    expect(tokenize(grammar!, source)).toMatchSnapshot();
  });

  it('colors the keyword, builtin name and constant type on a Const String line', async () => {
    const grammar = await registry.loadGrammar('source.uplc');
    const [row] = tokenize(grammar!, '  arg: Const String: "hello"');
    const scopes = row.tokens.map((t) => t[1]);
    // Const keyword, the String type, and the quoted string must each get a scope.
    expect(scopes.some((s) => s.includes('keyword.control'))).toBe(true);
    expect(scopes.some((s) => s.includes('entity.name.type') || s.includes('storage.type'))).toBe(true);
    expect(scopes.some((s) => s.includes('string.quoted'))).toBe(true);
  });
});

describe('plutus-types JSON grammar tokenization', () => {
  // The uplc-data viewer strips quotes from field names ("tag": -> tag:).
  const source = ['{', '  type: "Constr",', '  tag: 0,', '  fields: []', '}'].join('\n');

  it('matches the token snapshot', async () => {
    const grammar = await registry.loadGrammar('source.plutus-types-json');
    expect(grammar).toBeTruthy();
    expect(tokenize(grammar!, source)).toMatchSnapshot();
  });
});
