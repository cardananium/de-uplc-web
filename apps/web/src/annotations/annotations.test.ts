import { describe, expect, it } from 'vitest';
import { serializeTerm, serializeTermUplc, type DebuggerTypes } from '@cardananium/de-uplc-core';
import { resolveDebuggerAnnotations, resolvePseudoRange, termIdBase, type Annotation } from './annotations';

type Term = DebuggerTypes.Term;

// [ (lam x (force (delay x))) (con integer 42) ] with ids starting at 100, so the normalised ids
// the producer sends (uniq_id - base) differ from the app's.
const TERM: Term = {
  term_type: 'Apply', id: 100,
  function: {
    term_type: 'Lambda', id: 101, parameterName: 'x',
    body: { term_type: 'Force', id: 102, term: { term_type: 'Delay', id: 103, term: { term_type: 'Var', id: 104, name: 'x' } } },
  },
  argument: { term_type: 'Constant', id: 105, constant: { type: 'Integer', value: '42' } },
};

const ann = (target: Annotation['target']): Annotation => ({ target });

describe('debugger target resolution', () => {
  const tree = serializeTerm(TERM).locations;
  const canon = serializeTermUplc(TERM).locations;

  it('takes the base from the smallest term id of the program', () => {
    expect(termIdBase(tree)).toBe(100);
    expect(termIdBase([])).toBeUndefined();
  });

  it('adds the base to a normalised term id', () => {
    const [a, b] = resolveDebuggerAnnotations([ann({ kind: 'term', term_id: 0 }), ann({ kind: 'term', term_id: 5 })], tree, undefined);
    expect(a.termId).toBe(100);
    expect(b.termId).toBe(105);
  });

  it('marks a term id outside the program as missing', () => {
    const [a] = resolveDebuggerAnnotations([ann({ kind: 'term', term_id: 6 })], tree, undefined);
    expect(a.termId).toBeUndefined();
    expect(a.missing).toMatch(/not in this program/);
  });

  it('resolves a 1-based canonical UPLC line to the term starting there, independent of the active view', () => {
    // Canonical listing: 1 `[`, 2 `(lam x`, 3 `(force`, 4 `(delay`, 5 `x`, …, then the constant.
    const text = serializeTermUplc(TERM).text.split('\n');
    const conLine = text.findIndex((l) => l.includes('(con integer 42)')) + 1;
    const items = [1, 2, 5, conLine].map((line) => ann({ kind: 'uplc_line', line }));
    // Active view = tree: its locations give the base, the canonical ones give the lines.
    expect(resolveDebuggerAnnotations(items, tree, canon).map((r) => r.termId)).toEqual([100, 101, 104, 105]);
  });

  it('marks a canonical line with no term starting on it (a closing bracket, past the end) as missing', () => {
    const lines = serializeTermUplc(TERM).text.split('\n');
    const closer = lines.findIndex((l) => l.trim() === ')') + 1;
    const res = resolveDebuggerAnnotations(
      [ann({ kind: 'uplc_line', line: closer }), ann({ kind: 'uplc_line', line: lines.length + 10 })],
      tree,
      canon,
    );
    expect(res.every((r) => r.termId === undefined && /no term starts/.test(r.missing ?? ''))).toBe(true);
  });

  it('keeps every entry when nothing is loaded, or the target belongs to the decompiler', () => {
    const none = resolveDebuggerAnnotations([ann({ kind: 'term', term_id: 0 })], [], undefined);
    expect(none[0].missing).toMatch(/no program/);
    const dc = resolveDebuggerAnnotations([ann({ kind: 'pseudo_line', line: 1 })], tree, canon);
    expect(dc[0].termId).toBeUndefined();
    expect(dc[0].missing).toMatch(/decompiler/);
  });
});

describe('pseudo_line clamping', () => {
  it('keeps an in-range line or range', () => {
    expect(resolvePseudoRange({ kind: 'pseudo_line', line: 3 }, 10)).toEqual({ start: 3, end: 3 });
    expect(resolvePseudoRange({ kind: 'pseudo_line', line: 3, end_line: 6 }, 10)).toEqual({ start: 3, end: 6 });
  });

  it('cuts a range running past the end at the last line', () => {
    expect(resolvePseudoRange({ kind: 'pseudo_line', line: 8, end_line: 40 }, 10)).toEqual({ start: 8, end: 10 });
    expect(resolvePseudoRange({ kind: 'pseudo_line', line: 10 }, 10)).toEqual({ start: 10, end: 10 });
  });

  it('reports a range starting past the end, or an empty output, as missing', () => {
    expect(resolvePseudoRange({ kind: 'pseudo_line', line: 11 }, 10).missing).toMatch(/past the end/);
    expect(resolvePseudoRange({ kind: 'pseudo_line', line: 1 }, 0).missing).toMatch(/no decompiled output/);
    expect(resolvePseudoRange({ kind: 'term', term_id: 1 }, 10).missing).toMatch(/debugger/);
  });
});
