import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serializeTerm } from '../src/term-viewer/serialize';
import { serializeTermUplc } from '../src/term-viewer/uplc-pretty';
import { TermIndex, termIndexFor } from '../src/term-viewer/term-index';
import type { TermLocation } from '../src/term-viewer/serialize';
import type { Term } from '../src/debugger-types';

// `TermIndex` is the model the profiler is defined on, so what is pinned here
// is the contract, not the implementation: an inclusive `endLine` in BOTH renderings, one ancestor
// chain per node whichever renderer produced the text, and one location per term id — the last one
// GATES the profiler's data model: if it ever fails, `byTermId` has to hold a list.

// The real program from `apps/web/e2e/fixtures/gov_script.hex`, decoded once into the `Term` the
// engine hands the serializers (`new_session_from_program(hex, 'V3').get_script()`) and committed
// as JSON so this suite needs no WASM build. Regenerate the same way when the fixture changes.
// 1744 nodes, all ten term kinds, PascalCase builtin names.
const govScript = JSON.parse(
  readFileSync(fileURLToPath(new URL('./gov-script-term.json', import.meta.url)), 'utf8'),
) as Term;

// λ x { Apply { fun: Force { Var y }, arg: Builtin UnConstrData } } — small enough to write the
// rendered lines out by hand, deep enough to have a 4-node ancestor chain and two siblings.
const nested: Term = {
  term_type: 'Lambda', id: 1, parameterName: 'x',
  body: {
    term_type: 'Apply', id: 2,
    function: { term_type: 'Force', id: 3, term: { term_type: 'Var', id: 4, name: 'y' } },
    argument: { term_type: 'Builtin', id: 5, fun: 'UnConstrData' },
  },
};

const treeIndex = (term: Term) => new TermIndex(serializeTerm(term).locations, 'tree');
const uplcIndex = (term: Term) => new TermIndex(serializeTermUplc(term).locations, 'uplc');
const ids = (idx: TermIndex, ranks: number[]) => ranks.map((r) => idx.locations[r].termId);
const rankOf = (idx: TermIndex, termId: number) => idx.byTermId.get(termId) as number;
const ancestorIds = (idx: TermIndex, termId: number) => ids(idx, idx.ancestors(rankOf(idx, termId)));

describe('TermIndex — structure from one pre-order pass', () => {
  const idx = treeIndex(nested);

  it('indexes every location, in document order', () => {
    expect(idx.size).toBe(5);
    expect(idx.locations.map((l) => l.termId)).toEqual([1, 2, 3, 4, 5]);
    expect([...idx.startLine]).toEqual([0, 1, 2, 3, 5]);
  });

  it('reconstructs parents, children and depth', () => {
    //  0 λ x {            1 Lambda
    //  1   body: Apply {  2 Apply
    //  2     fun: Force { 3 Force
    //  3       term: Var y  4 Var
    //  4     },
    //  5     arg: Built-in UnConstrData  5 Builtin
    //  6   }
    //  7 }
    expect([...idx.parent]).toEqual([-1, 0, 1, 2, 1]);
    expect([...idx.depth]).toEqual([0, 1, 2, 3, 2]);
    expect(ids(idx, idx.children(rankOf(idx, 2)))).toEqual([3, 5]); // fun, then arg
    expect(idx.children(rankOf(idx, 4))).toEqual([]); // Var is a leaf
    expect(ancestorIds(idx, 4)).toEqual([1, 2, 3]); // root first
    expect(ancestorIds(idx, 1)).toEqual([]);
  });

  it('normalises endLine to inclusive in both views', () => {
    const tree = serializeTerm(nested);
    const uplc = serializeTermUplc(nested);
    // The tree serializer stores endLine EXCLUSIVE, the canonical one INCLUSIVE.
    expect(tree.locations.map((l) => l.endLine)).toEqual([8, 7, 5, 4, 6]);
    expect(uplc.locations.map((l) => l.endLine)).toEqual([7, 6, 4, 3, 5]);
    // After normalisation both say the same thing, and the root ends on the document's last line.
    expect([...new TermIndex(tree.locations, 'tree').endLine]).toEqual([7, 6, 4, 3, 5]);
    expect([...new TermIndex(uplc.locations, 'uplc').endLine]).toEqual([7, 6, 4, 3, 5]);
    expect(new TermIndex(tree.locations, 'tree').endLine[0]).toBe(tree.text.split('\n').length - 1);
    expect(new TermIndex(uplc.locations, 'uplc').endLine[0]).toBe(uplc.text.split('\n').length - 1);
  });

  it('handles several terms starting on the same line', () => {
    // Neither renderer currently puts two nodes on one line (asserted below), but the profiler's
    // per-line aggregation is defined over `byLine`, so the contract is pinned rather than assumed:
    // the line lists every node that starts there, and the most nested one owns the line.
    const locs: TermLocation[] = [
      { startLine: 0, endLine: 4, termId: 10, kind: 'Apply' },
      { startLine: 1, endLine: 3, termId: 11, kind: 'Force' },   // parent and child share line 1
      { startLine: 1, endLine: 2, termId: 12, kind: 'Delay' },
      { startLine: 2, endLine: 2, termId: 13, kind: 'Var', label: 'y' },
      { startLine: 4, endLine: 4, termId: 14, kind: 'Error' },
    ];
    const i2 = new TermIndex(locs, 'uplc');
    expect(i2.byLine.get(1)).toEqual([1, 2]);
    expect(i2.byLine.get(0)).toEqual([0]);
    expect(i2.byLine.get(3)).toBeUndefined();
    expect([...i2.parent]).toEqual([-1, 0, 1, 2, 0]);
    expect(i2.findTermAtLine(1)?.termId).toBe(12); // smallest span among the two on the line
    // and every real rendering gives each node a line of its own:
    for (const term of [nested, govScript]) {
      for (const idx2 of [treeIndex(term), uplcIndex(term)]) {
        expect(idx2.byLine.size).toBe(idx2.size);
      }
    }
  });

  it('memoises per locations array, and rebuilds when the view changes', () => {
    const { locations } = serializeTerm(nested);
    expect(termIndexFor(locations, 'tree')).toBe(termIndexFor(locations, 'tree'));
    const asUplc = termIndexFor(locations, 'uplc');
    expect(asUplc).not.toBe(termIndexFor(locations, 'tree'));
    expect(asUplc.endLine[0]).toBe(8); // read as inclusive → one line too far, as asked
  });
});

describe('TermIndex — line lookups', () => {
  const idx = treeIndex(nested);

  it('a term starting on the line wins', () => {
    expect(idx.findTermAtLine(0)?.termId).toBe(1);
    expect(idx.findTermAtLine(3)?.termId).toBe(4);
    expect(idx.findTermAtLine(5)?.termId).toBe(5);
  });

  it('a closing line resolves to the node it closes, not to the one above it', () => {
    // The whole point of the inclusive normalisation: line 4 is Force's `},` and line 7 is the
    // lambda's `}`. Compared with the raw exclusive endLine they used to land on Var / Builtin.
    expect(idx.findTermAtLine(4)?.termId).toBe(3);
    expect(idx.findTermAtLine(6)?.termId).toBe(2);
    expect(idx.findTermAtLine(7)?.termId).toBe(1);
  });

  it('the canonical view answers the same way about its own closing parens', () => {
    const u = uplcIndex(nested);
    expect(u.findTermAtLine(4)?.termId).toBe(3); // `)` closing (force
    expect(u.findTermAtLine(6)?.termId).toBe(2); // `]` closing the application
    expect(u.findTermAtLine(7)?.termId).toBe(1); // `)` closing (lam
  });

  it('findNearestTerm snaps out-of-range lines to the closest term start', () => {
    expect(idx.findNearestTerm(99)?.termId).toBe(5);
    expect(idx.findNearestTerm(-5)?.termId).toBe(1);
    expect(new TermIndex([], 'tree').findNearestTerm(0)).toBeUndefined();
  });

  it('termAtLineForBreakpoint returns the term start line + id', () => {
    expect(idx.termAtLineForBreakpoint(3)).toEqual({ line: 3, termId: 4 });
    expect(idx.termAtLineForBreakpoint(99)).toEqual({ line: 5, termId: 5 });
    expect(new TermIndex([], 'tree').termAtLineForBreakpoint(0)).toBeUndefined();
  });

  it('lineOfTerm / locationOf read a term id back', () => {
    expect(idx.lineOfTerm(5)).toBe(5);
    expect(idx.locationOf(5)?.label).toBe('unConstrData');
    expect(idx.lineOfTerm(999)).toBeUndefined();
    expect(idx.locationOf(999)).toBeUndefined();
  });
});

describe('both renderings of the e2e fixture', () => {
  const tree = serializeTerm(govScript);
  const uplc = serializeTermUplc(govScript);

  // GATE for the profiler's data model. If this fails, do NOT
  // "fix" the serializers: `TermIndex.byTermId` has to become a list of locations per id, the heat
  // lane has to paint every occurrence and the report has to say a node appears N times.
  it.each([['tree', tree.locations], ['uplc', uplc.locations]] as const)(
    'one term id → one location (%s)',
    (_view, locations) => {
      expect(new Set(locations.map((l) => l.termId)).size).toBe(locations.length);
    },
  );

  it('emits locations in document order (the binary search depends on it)', () => {
    for (const locations of [tree.locations, uplc.locations]) {
      for (let i = 1; i < locations.length; i++) {
        expect(locations[i].startLine).toBeGreaterThanOrEqual(locations[i - 1].startLine);
      }
    }
  });

  it('gives every node the same ancestor chain in both views', () => {
    const t = new TermIndex(tree.locations, 'tree');
    const u = new TermIndex(uplc.locations, 'uplc');
    expect(t.size).toBe(u.size);
    // The deepest node first, then every node — the chains must agree node for node.
    let deepest = 0;
    for (let i = 1; i < t.size; i++) if (t.depth[i] > t.depth[deepest]) deepest = i;
    const deepestId = t.locations[deepest].termId;
    expect(t.depth[deepest]).toBeGreaterThan(10);
    expect(ancestorIds(t, deepestId)).toEqual(ancestorIds(u, deepestId));
    for (const loc of tree.locations) {
      expect(ancestorIds(t, loc.termId)).toEqual(ancestorIds(u, loc.termId));
    }
    expect([...t.depth]).toEqual([...u.depth]);
  });

  it('gives every node the same kind and label in both views', () => {
    // The `Node` column of the report reads these, so they may not follow the rendering: the tree
    // view prints `Built-in UnConstrData` and the canonical one `(builtin unConstrData)`, but both
    // locations say `unConstrData`.
    const label = (locations: readonly TermLocation[]) =>
      new Map(locations.map((l) => [l.termId, `${l.kind}:${l.label ?? ''}`]));
    expect(label(tree.locations)).toEqual(label(uplc.locations));
    const builtin = tree.locations.find((l) => l.kind === 'Builtin' && l.label === 'unConstrData');
    expect(builtin).toBeDefined();
    expect(tree.text.split('\n')[builtin!.startLine]).toContain('Built-in UnConstrData');
    expect(uplc.text.split('\n')[uplcIndex(govScript).lineOfTerm(builtin!.termId) as number])
      .toContain('(builtin unConstrData)');
    // Every kind carries a label exactly when its shape has a name.
    for (const l of tree.locations) {
      expect(l.label === undefined).toBe(!['Var', 'Lambda', 'Builtin'].includes(l.kind));
    }
  });

  it('agrees with the term tree it was built from (children count, root)', () => {
    const t = new TermIndex(tree.locations, 'tree');
    const childCount = (term: Term): number => {
      switch (term.term_type) {
        case 'Apply': return 2;
        case 'Delay': case 'Force': case 'Lambda': return 1;
        case 'Constr': return term.fields.length;
        case 'Case': return term.branches.length + 1;
        default: return 0;
      }
    };
    const walk = (term: Term): void => {
      expect(t.children(rankOf(t, term.id)).length).toBe(childCount(term));
      switch (term.term_type) {
        case 'Apply': walk(term.function); walk(term.argument); break;
        case 'Delay': case 'Force': walk(term.term); break;
        case 'Lambda': walk(term.body); break;
        case 'Constr': term.fields.forEach(walk); break;
        case 'Case': walk(term.constr); term.branches.forEach(walk); break;
      }
    };
    expect(t.parent[0]).toBe(-1);
    expect(t.locations[0].termId).toBe(govScript.id);
    walk(govScript);
  });
});
