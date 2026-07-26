import { describe, expect, it } from 'vitest';
import type { DebuggerTypes, TermLocation } from '@de-uplc/core';
import { fmtPct } from './format';
import { buildProfileIndex } from './profile-index';

// The per-line aggregate is the one rule that is easy to get backwards — self SUMS, subtree
// takes the MAX — so the fixture puts two NESTED nodes on one line, where the two rules give
// different answers and a Σ over subtrees double-counts the inner node.
//
// One line-per-node layout, written out rather than generated: every number in the assertions below
// has to be readable here.
//
//   line 0  Apply    #1   self 100  subtree 675   (the root — spans the whole program)
//   line 1    Apply  #2   self 200  subtree 500   ┐ both on line 1, nested: 500 already contains 300
//   line 1      Bltn #3   self 300  subtree 300   ┘
//   line 2    Var    #4   never evaluated — a location with no row
//   line 3    Const  #5   self  50  subtree  50
//           (#9)          self  25  — a row with no location in this rendering

const LOCATIONS: TermLocation[] = [
  { startLine: 0, endLine: 3, termId: 1, kind: 'Apply' },
  { startLine: 1, endLine: 1, termId: 2, kind: 'Apply' },
  { startLine: 1, endLine: 1, termId: 3, kind: 'Builtin', label: 'unConstrData' },
  { startLine: 2, endLine: 2, termId: 4, kind: 'Var', label: 'xs' },
  { startLine: 3, endLine: 3, termId: 5, kind: 'Constant' },
];

type Row = { id: number; self: number; subtree?: number; hits?: number; mem?: number };

function term(r: Row): DebuggerTypes.ProfileTerm {
  return {
    termId: r.id,
    hits: r.hits ?? 1,
    selfCpu: r.self,
    // Memory deliberately differs from cpu: the per-line arrays must follow the ACTIVE metric, and
    // identical numbers would hide a build that always reads `selfCpu`.
    selfMem: r.mem ?? r.self * 2,
    totalCpu: r.subtree ?? r.self,
    totalMem: (r.subtree ?? r.self) * 2,
    returnCpu: 0,
    returnMem: 0,
  };
}

const ROWS: Row[] = [
  { id: 1, self: 100, subtree: 675, hits: 1 },
  { id: 2, self: 200, subtree: 500, hits: 4 },
  { id: 3, self: 300, subtree: 300, hits: 7 },
  { id: 5, self: 50, hits: 2 },
  { id: 9, self: 25, hits: 1 },
];

function report(totals: Partial<DebuggerTypes.ProfileTotals> = {}): DebuggerTypes.Profile {
  return {
    terms: ROWS.map(term),
    builtins: [],
    tracesDropped: 0,
    steps: [],
    timeline: [],
    traces: [],
    totals: {
      attribution: 'apply_site',
      cpuSpent: 675,
      memSpent: 1350,
      cpuLimit: null,
      memLimit: null,
      startupCpu: 0,
      startupMem: 0,
      steps: 15,
      outcome: { outcome_type: 'Done' },
      ...totals,
    },
  };
}

const index = buildProfileIndex(report(), LOCATIONS, 'uplc', 'cpu');

describe('per-line aggregation', () => {
  it('sums self over the nodes on a line', () => {
    // Self-costs are disjoint — each node is charged to the line it STARTS on — so they add.
    expect(index.lineSelf[1]).toBe(500);
    expect(index.lineSelf[0]).toBe(100);
    expect(index.lineSelf[3]).toBe(50);
    // A line whose only node never ran carries nothing at all.
    expect(index.lineSelf[2]).toBe(0);
  });

  it('takes the MAX of subtree over the nodes on a line, never the sum', () => {
    // #3 is inside #2, so 500 already contains 300; summing would report 800 for a line whose real
    // subtree cost is 500 — the inversion this rule exists to prevent.
    expect(index.lineSubtree[1]).toBe(500);
    expect(index.lineSubtree[1]).not.toBe(800);
    expect(index.lineSubtree[0]).toBe(675);
  });

  it('sums hits the way it sums self', () => {
    expect(index.lineHits[1]).toBe(11);
    expect(index.lineHits[3]).toBe(2);
  });

  it('lists every node of a line in the hover payload, hottest first', () => {
    const stats = index.laneStats(1);
    expect(stats?.nodes.map((n) => n.termId)).toEqual([3, 2]);
    expect(stats?.self).toBe(500);
    expect(stats?.subtree).toBe(500);
    expect(stats?.hits).toBe(11);
    // Lines with no cost have no stats at all — that is what keeps the inlay provider O(1).
    expect(index.laneStats(2)).toBeUndefined();
  });

  it('follows the active metric, not just cpu', () => {
    const mem = buildProfileIndex(report(), LOCATIONS, 'uplc', 'mem');
    expect(mem.lineSelf[1]).toBe(1000);
    expect(mem.lineSubtree[1]).toBe(1000);
    expect(mem.total).toBe(1350);
  });

  it('sizes the per-line arrays from the locations, not from an editor model', () => {
    // `maxStartLine + 1` — the index is built in the store, where there is no model to ask.
    expect(index.lineCount).toBe(4);
    expect(index.bucketAt(-1)).toBe(255);
    expect(index.bucketAt(99)).toBe(255);
  });
});

describe('nodes the report cannot point at', () => {
  it('counts rows with no location in this rendering, with their cost', () => {
    // The id generator is global and never restarts, so a report can name a node this rendering has
    // never heard of. It stays in `rows` — the percentages have to add up — but it has no line.
    expect(index.noLocation).toEqual({ count: 1, self: 25 });
    expect(index.rowFor(9)?.line).toBeUndefined();
    expect(index.rows).toHaveLength(5);
  });

  it('counts located nodes that never executed', () => {
    // Locations minus the located rows that ran: #4 has a location and no row.
    expect(index.nodeCount).toBe(5);
    expect(index.neverEvaluated).toBe(1);
    expect(index.rowFor(4)).toBeUndefined();
  });
});

describe('% of the declared limit', () => {
  it('is an em dash, not a percentage of some default budget, when there is no redeemer', () => {
    // scriptOnly / parts sessions declare no ExUnits: `cpu_limit === null` all the way through.
    expect(index.limit).toBeNull();
    expect(fmtPct(index.total, index.limit)).toBe('—');
    expect(fmtPct(index.total, buildProfileIndex(report(), LOCATIONS, 'uplc', 'mem').limit)).toBe('—');
  });

  it('is a real percentage when the session has one', () => {
    const declared = buildProfileIndex(report({ cpuLimit: 1000, memLimit: 2000 }), LOCATIONS, 'uplc', 'cpu');
    expect(declared.limit).toBe(1000);
    expect(fmtPct(declared.total, declared.limit)).toBe('67.50%');
    // Over the limit is a number, not a cap: the profile run has no budget of its own.
    expect(fmtPct(2000, 1000)).toBe('200.00%');
  });
});
