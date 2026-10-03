import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeTerm, termIndexFor, type DebuggerTypes } from '@cardananium/de-uplc-core';
import { resolveDebuggerAnnotations, resolvePseudoRange, type DeUplcTarget } from './annotations';
import { dimmedSpans } from './spotlight';

const lit = (line: number, endLine = line) => ({ line, endLine });

describe('spotlight: the dimmed spans around the lit lines', () => {
  it('dims both sides of a single target', () => {
    expect(dimmedSpans([lit(5)], 10)).toEqual([{ start: 1, end: 4 }, { start: 6, end: 10 }]);
  });

  it('dims the gaps between several targets, in line order whatever the input order', () => {
    expect(dimmedSpans([lit(8), lit(2), lit(5)], 10)).toEqual([
      { start: 1, end: 1 }, { start: 3, end: 4 }, { start: 6, end: 7 }, { start: 9, end: 10 },
    ]);
  });

  it('merges adjacent, overlapping and repeated targets: nothing between or inside them dims', () => {
    expect(dimmedSpans([lit(3, 4), lit(5, 6)], 10)).toEqual([{ start: 1, end: 2 }, { start: 7, end: 10 }]);
    expect(dimmedSpans([lit(3, 7), lit(5, 6), lit(6, 8)], 10)).toEqual([{ start: 1, end: 2 }, { start: 9, end: 10 }]);
    expect(dimmedSpans([lit(4), lit(4)], 10)).toEqual([{ start: 1, end: 3 }, { start: 5, end: 10 }]);
  });

  it('dims nothing before a target on the first line or after one on the last', () => {
    expect(dimmedSpans([lit(1)], 10)).toEqual([{ start: 2, end: 10 }]);
    expect(dimmedSpans([lit(10)], 10)).toEqual([{ start: 1, end: 9 }]);
    expect(dimmedSpans([lit(1), lit(10)], 10)).toEqual([{ start: 2, end: 9 }]);
  });

  it('cuts a multi-line range at the last line, and dims nothing when the lit lines cover the text', () => {
    expect(dimmedSpans([lit(5, 40)], 10)).toEqual([{ start: 1, end: 4 }]);
    expect(dimmedSpans([lit(1, 10)], 10)).toEqual([]);
    expect(dimmedSpans([lit(1, 99)], 10)).toEqual([]);
    expect(dimmedSpans([lit(1, 4), lit(5, 12)], 10)).toEqual([]);
  });

  it('lights the first line alone when a range ends before it starts', () => {
    expect(dimmedSpans([lit(5, 2)], 10)).toEqual([{ start: 1, end: 4 }, { start: 6, end: 10 }]);
  });
});

describe("spotlight: the debugger's current line stays bright", () => {
  it('next to the targets, merging with a target it touches or sits on', () => {
    expect(dimmedSpans([lit(5)], 10, [lit(8)])).toEqual([{ start: 1, end: 4 }, { start: 6, end: 7 }, { start: 9, end: 10 }]);
    expect(dimmedSpans([lit(5)], 10, [lit(6)])).toEqual([{ start: 1, end: 4 }, { start: 7, end: 10 }]);
    expect(dimmedSpans([lit(5)], 10, [lit(5)])).toEqual(dimmedSpans([lit(5)], 10));
  });

  it('following each step: only the spans around the old and the new line change', () => {
    expect([2, 3, 9].map((ln) => dimmedSpans([lit(5)], 10, [lit(ln)]))).toEqual([
      [{ start: 1, end: 1 }, { start: 3, end: 4 }, { start: 6, end: 10 }],
      [{ start: 1, end: 2 }, { start: 4, end: 4 }, { start: 6, end: 10 }],
      [{ start: 1, end: 4 }, { start: 6, end: 8 }, { start: 10, end: 10 }],
    ]);
  });

  it('but never turns the spotlight on by itself, and is ignored outside the text', () => {
    expect(dimmedSpans([], 10, [lit(3)])).toEqual([]);
    expect(dimmedSpans([lit(11)], 10, [lit(3)])).toEqual([]);
    expect(dimmedSpans([lit(5)], 10, [lit(0), lit(11)])).toEqual([{ start: 1, end: 4 }, { start: 6, end: 10 }]);
  });
});

describe('spotlight scope: only a target drawn in the editor turns it on', () => {
  it('dims nothing without a lit line', () => {
    expect(dimmedSpans([], 10)).toEqual([]);
    expect(dimmedSpans([lit(11), lit(0)], 10)).toEqual([]);
    expect(dimmedSpans([lit(1)], 0)).toEqual([]);
  });

  it('ignores the targets outside the text next to one inside it', () => {
    expect(dimmedSpans([lit(11), lit(3), lit(0)], 5)).toEqual([{ start: 1, end: 2 }, { start: 4, end: 5 }]);
  });

  it('decompiler: a pseudo_line past the end of the output lights nothing', () => {
    const lineCount = 10;
    const marks = (targets: DeUplcTarget[]) => targets.flatMap((t) => {
      const r = resolvePseudoRange(t, lineCount);
      return r.start === undefined || r.end === undefined ? [] : [lit(r.start, r.end)];
    });
    expect(dimmedSpans(marks([{ kind: 'pseudo_line', line: 40 }]), lineCount)).toEqual([]);
    expect(dimmedSpans(marks([{ kind: 'pseudo_line', line: 40 }, { kind: 'pseudo_line', line: 5, end_line: 8 }]), lineCount))
      .toEqual([{ start: 1, end: 4 }, { start: 9, end: 10 }]);
  });

  it('debugger: a term that is not in the program lights nothing', () => {
    // [ (lam x x) (con integer 42) ], one term per line in the tree view.
    const term: DebuggerTypes.Term = {
      term_type: 'Apply', id: 7,
      function: { term_type: 'Lambda', id: 8, parameterName: 'x', body: { term_type: 'Var', id: 9, name: 'x' } },
      argument: { term_type: 'Constant', id: 10, constant: { type: 'Integer', value: '42' } },
    };
    const { text, locations } = serializeTerm(term);
    const index = termIndexFor(locations, 'tree');
    const lineCount = text.split('\n').length;
    const marks = (termIds: number[]) => resolveDebuggerAnnotations(
      termIds.map((term_id) => ({ target: { kind: 'term', term_id } })), locations, undefined,
    ).flatMap((a) => {
      const ln = a.termId === undefined ? undefined : index.lineOfTerm(a.termId);
      return ln === undefined ? [] : [lit(ln + 1)];
    });
    expect(dimmedSpans(marks([99]), lineCount)).toEqual([]);
    const spans = dimmedSpans(marks([99, 3]), lineCount);
    const constLine = index.lineOfTerm(10)! + 1;
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.start <= constLine && constLine <= s.end)).toBe(false);
    expect(spans.reduce((n, s) => n + s.end - s.start + 1, 0)).toBe(lineCount - 1);
  });
});

describe('"dim the rest" setting', () => {
  const KEY = 'deuplc.annotations.spotlight';
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => { stored.set(k, String(v)); },
      removeItem: (k: string) => { stored.delete(k); },
    });
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // The settings store reads localStorage once, when its module loads: a fresh import is a fresh visit.
  const visit = async () => {
    vi.resetModules();
    return (await import('../platform/settings')).useSettings;
  };

  it('is on by default', async () => {
    expect((await visit()).getState().annSpotlight).toBe(true);
  });

  it('is remembered across visits, off and back on', async () => {
    (await visit()).getState().set('annSpotlight', false);
    expect(stored.get(KEY)).toBe('false');
    const second = await visit();
    expect(second.getState().annSpotlight).toBe(false);
    second.getState().set('annSpotlight', true);
    expect((await visit()).getState().annSpotlight).toBe(true);
  });

  it('returns to on with a settings reset', async () => {
    stored.set(KEY, 'false');
    const settings = await visit();
    expect(settings.getState().annSpotlight).toBe(false);
    settings.getState().reset();
    expect(settings.getState().annSpotlight).toBe(true);
    expect(stored.get(KEY)).toBe('true');
  });
});
