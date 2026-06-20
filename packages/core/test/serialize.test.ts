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

  it('records a location per term with correct line ranges', () => {
    expect(out.locations).toEqual([
      { startLine: 0, endLine: 4, termId: 3 },
      { startLine: 1, endLine: 2, termId: 1 },
      { startLine: 2, endLine: 3, termId: 2 },
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
    // Apply: term: + id:3
    expect(out.hints).toContainEqual({ line: 0, character: 0, text: 'term:', kind: 'term' });
    expect(out.hints).toContainEqual({ line: 0, character: 5, text: ' id:3', kind: 'name' });
    // Builtin: term: + fn: + id:1
    expect(out.hints).toContainEqual({ line: 1, character: 7, text: 'term:', kind: 'term' });
    expect(out.hints).toContainEqual({ line: 1, character: 16, text: 'fn:', kind: 'builtin_function' });
    expect(out.hints).toContainEqual({ line: 1, character: 26, text: ' id:1', kind: 'name' });
    // Constant: term: + type: + id:2
    expect(out.hints).toContainEqual({ line: 2, character: 7, text: 'term:', kind: 'term' });
    expect(out.hints).toContainEqual({ line: 2, character: 13, text: 'type:', kind: 'constant_type' });
    expect(out.hints).toContainEqual({ line: 2, character: 26, text: ' id:2', kind: 'name' });
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

  it('findTermAtLine on the closing brace maps to the most-nested overlapping term', () => {
    // Faithful quirk of the original: endLine is "one past" and inclusive in
    // findTermAtLine, so the closing '}' on line 3 still falls inside the
    // constant's [2,3] range (range 1) which is more nested than Apply's [0,4].
    expect(findTermAtLine(3, locations)?.termId).toBe(2);
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
