import { describe, it, expect } from 'vitest';
import { serializeTerm } from '../src/term-viewer/serialize';
import { serializeTermUplc } from '../src/term-viewer/uplc-pretty';
import { MAX_INDENT } from '../src/term-viewer/indent';
import { compactJson, jsonLines, prettyJson } from '../src/term-viewer/json-text';
import { TermIndex } from '../src/term-viewer/term-index';
import type { Constant, PlutusData, Term, Type } from '../src/debugger-types';

// Past the 34 816 levels a 17 KB script nests at 4 bits a level: every walk here would run out of
// call stack long before, were it recursive.
const DEPTH = 60_000;

/** `(lam i (lam i … (con unit ())))`, `depth` lambdas deep; ids post-order from 0. */
function lambdas(depth: number): Term {
  let term: Term = { term_type: 'Constant', id: 0, constant: { type: 'Unit' } };
  for (let i = 1; i <= depth; i++) term = { term_type: 'Lambda', id: i, parameterName: 'i', body: term };
  return term;
}

function widestIndent(text: string): number {
  let widest = 0;
  for (const line of text.split('\n')) widest = Math.max(widest, line.length - line.trimStart().length);
  return widest;
}

describe('a deep term', () => {
  const term = lambdas(DEPTH);

  it('renders as canonical UPLC, a term per line, indented as far as MAX_INDENT', () => {
    const { text, locations } = serializeTermUplc(term);
    const lines = text.split('\n');
    // One opening line per lambda, the constant, one closing line per lambda.
    expect(lines.length).toBe(2 * DEPTH + 1);
    expect(locations.length).toBe(DEPTH + 1);
    expect(widestIndent(text)).toBe(MAX_INDENT);
    // Every term still starts its own line: the line↔term mapping holds at any depth.
    const index = new TermIndex(locations, 'uplc');
    expect(index.lineOfTerm(0)).toBe(DEPTH);
    expect(lines[DEPTH].trim()).toBe('(con unit ())');
    expect(index.findTermAtLine(DEPTH - 1)?.termId).toBe(1);
    expect(index.findTermAtLine(DEPTH + 1)?.termId).toBe(1);
    expect(index.depth[index.byTermId.get(0)!]).toBe(DEPTH);
    // The text grows with the depth, not with its square.
    expect(text.length).toBeLessThan(lines.length * (MAX_INDENT + 16));
  });

  it('renders as the debug tree likewise', () => {
    const { text, locations, hints } = serializeTerm(term);
    const lines = text.split('\n');
    expect(lines.length).toBe(2 * DEPTH + 1);
    expect(locations.length).toBe(DEPTH + 1);
    expect(widestIndent(text)).toBe(MAX_INDENT);
    const index = new TermIndex(locations, 'tree');
    expect(index.lineOfTerm(0)).toBe(DEPTH);
    expect(lines[DEPTH].trimStart()).toBe('body: Const Unit: undefined');
    // A hint sits where the term's text starts, also past the indentation cap.
    expect(hints).toContainEqual({ line: DEPTH, character: MAX_INDENT + 'body: '.length, text: 'term:', kind: 'term' });
    expect(text.length).toBeLessThan(lines.length * (MAX_INDENT + 24));
  });

  it('holds its deep constants on one line in canonical UPLC, and lays them out in the debug tree', () => {
    let data: PlutusData = { Int: '0' } as PlutusData;
    for (let i = 0; i < DEPTH; i++) data = { type: 'Constr', tag: 121, fields: [data] } as PlutusData;
    // A list of lists of …: each level's element type is the type of the level inside it.
    let list: Constant = { type: 'Integer', value: '1' };
    let elementType: Type = { type: 'Integer' };
    for (let i = 0; i < DEPTH; i++) {
      list = { type: 'ProtoList', elementType, values: [list] };
      elementType = { type: 'List', elementType };
    }
    const withData: Term = { term_type: 'Constant', id: 1, constant: { type: 'Data', data } };
    const uplc = serializeTermUplc(withData).text;
    expect(uplc.startsWith('(con data (Constr 0 [Constr 0 [')).toBe(true);
    expect(uplc.endsWith('I 0' + ']'.repeat(DEPTH) + '))')).toBe(true);

    const tree = serializeTerm(withData);
    expect(tree.text.split('\n')[0]).toBe('Const Data {');
    expect(widestIndent(tree.text)).toBe(MAX_INDENT);
    expect(tree.locations).toEqual([{ startLine: 0, endLine: tree.text.split('\n').length, termId: 1, kind: 'Constant' }]);

    const withList: Term = { term_type: 'Constant', id: 2, constant: list };
    expect(serializeTermUplc(withList).text.endsWith('[1' + ']'.repeat(DEPTH) + ')')).toBe(true);
    const listTree = serializeTerm(withList).text.split('\n');
    expect(listTree[0]).toBe('Const ProtoList {');
    // Per level: the header, `elementType: List,`, `values: [`, `]` and `}`; the innermost item.
    expect(listTree.length).toBe(5 * DEPTH + 1);
  });
});

describe('JSON text without recursion', () => {
  const values: unknown[] = [
    null, 42, -0.5, 'q"uote\n', true, [], {}, [1, [2, [3]], { a: [] }],
    { type: 'Constr', tag: 121, fields: [{ Int: '5' }, { type: 'BoundedBytes', value: 'ab' }], skipped: undefined },
    [undefined, { x: undefined, y: 1 }],
  ];

  it('is what JSON.stringify writes', () => {
    for (const value of values) {
      const lines = jsonLines(value).map((l) => ' '.repeat(l.indent) + l.text).join('\n');
      expect(lines).toBe(JSON.stringify(value, null, 2));
      expect(compactJson(value)).toBe(JSON.stringify(value));
    }
  });

  it('writes values nested far deeper than JSON.stringify can', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < DEPTH; i++) deep = { values: [deep] };
    expect(() => JSON.stringify(deep)).toThrow(RangeError);
    const compact = compactJson(deep);
    expect(compact.length).toBe(JSON.stringify('leaf').length + DEPTH * '{"values":[]}'.length);
    expect(JSON.parse(compact)).toBeTruthy();
    const pretty = prettyJson(deep);
    expect(widestIndent(pretty)).toBe(MAX_INDENT);
    expect(pretty.split('\n').length).toBe(4 * DEPTH + 1);
  });
});
