import { describe, it, expect } from 'vitest';
import { serializeTerm, findTermAtLine, findNearestTerm, termAtLineForBreakpoint } from '../src/term-viewer/serialize';
import type { Term } from '../src/debugger-types';

// Apply { fun: Built-in addInteger, arg: Const Integer: "42" }
const sample: Term = {
  term_type: 'Apply',
  id: 3,
  function: { term_type: 'Builtin', id: 1, fun: 'addInteger' },
  argument: { term_type: 'Constant', id: 2, constant: { type: 'Integer', value: '42' } },
};

describe('serializeTerm', () => {
  const out = serializeTerm(sample);

  it('produces the exact text', () => {
    expect(out.text).toBe(['Apply {', '  fun: Built-in addInteger,', '  arg: Const Integer: "42"', '}'].join('\n'));
  });

  it('records a location per term with correct line ranges, kind and label', () => {
    // endLine is EXCLUSIVE here (`TermIndex` normalises it); `kind`/`label` are the profiler's
    // `Node` column, filled at the push site because the rendered line cannot supply them.
    expect(out.locations).toEqual([
      { startLine: 0, endLine: 4, termId: 3, kind: 'Apply' },
      { startLine: 1, endLine: 2, termId: 1, kind: 'Builtin', label: 'addInteger' },
      { startLine: 2, endLine: 3, termId: 2, kind: 'Constant' },
    ]);
  });

  it('every location start/end stays within the produced text', () => {
    const lineCount = out.text.split('\n').length;
    for (const loc of out.locations) {
      expect(loc.startLine).toBeGreaterThanOrEqual(0);
      expect(loc.startLine).toBeLessThan(lineCount);
      expect(loc.endLine).toBeGreaterThanOrEqual(loc.startLine);
      expect(loc.endLine).toBeLessThanOrEqual(lineCount);
    }
  });

  it('emits term/name hints for the Apply and builtin/constant hints', () => {
    // The id: hint always sits right AFTER the term-type token (not at end of line,
    // where a long value would push it off-screen).
    // Apply: term: + id:3 → `term: Apply id:3 {`
    expect(out.hints).toContainEqual({ line: 0, character: 0, text: 'term:', kind: 'term' });
    expect(out.hints).toContainEqual({ line: 0, character: 5, text: ' id:3', kind: 'name' });
    // Builtin: term: + id:1 + fn: → `term: Built-in id:1 fn: addInteger`
    expect(out.hints).toContainEqual({ line: 1, character: 7, text: 'term:', kind: 'term' });
    expect(out.hints).toContainEqual({ line: 1, character: 15, text: ' id:1', kind: 'name' });
    expect(out.hints).toContainEqual({ line: 1, character: 16, text: 'fn:', kind: 'builtin_function' });
    // Constant: term: + id:2 + type: → `term: Const id:2 type: Integer: "42"`
    expect(out.hints).toContainEqual({ line: 2, character: 7, text: 'term:', kind: 'term' });
    expect(out.hints).toContainEqual({ line: 2, character: 12, text: ' id:2', kind: 'name' });
    expect(out.hints).toContainEqual({ line: 2, character: 13, text: 'type:', kind: 'constant_type' });
  });
});

describe('line↔termId mapping', () => {
  const { locations } = serializeTerm(sample);

  it('findTermAtLine prefers the term starting exactly on the line (most nested)', () => {
    // line 0 starts the Apply (only term starting there)
    expect(findTermAtLine(0, locations)?.termId).toBe(3);
    // line 1 starts the builtin
    expect(findTermAtLine(1, locations)?.termId).toBe(1);
    // line 2 starts the constant
    expect(findTermAtLine(2, locations)?.termId).toBe(2);
  });

  it('findTermAtLine maps a closing brace to the term it closes', () => {
    // The tree serializer's endLine is EXCLUSIVE, so comparing it with `<=` used to stretch every
    // range one line down and the closing '}' on line 3 answered `Constant` — the node that ended
    // on line 2. `TermIndex` normalises the range to [0,3] / [2,2] and the brace is Apply's.
    expect(findTermAtLine(3, locations)?.termId).toBe(3);
  });

  it('findNearestTerm snaps an out-of-range line to the closest term', () => {
    expect(findNearestTerm(99, locations)?.termId).toBe(2);
    expect(findNearestTerm(-5, locations)?.termId).toBe(3);
  });

  it('termAtLineForBreakpoint returns the term start line + id', () => {
    expect(termAtLineForBreakpoint(1, locations)).toEqual({ line: 1, termId: 1 });
    expect(termAtLineForBreakpoint(99, locations)).toEqual({ line: 2, termId: 2 });
    expect(termAtLineForBreakpoint(0, [])).toBeUndefined();
  });
});
