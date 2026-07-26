import { describe, expect, it } from 'vitest';
import { TermIndex, type DebuggerTypes, type TermLocation } from '@de-uplc/core';
import {
  AUTO_RAISE_TARGET, RENDER_CAP, defaultSortKey, deriveReport, fmtThreshold, isReturnDominated,
  matchesText, rankIndices, topNodes,
} from './derive';
import { buildProfileIndex } from './profile-index';

// A fixture builder rather than a fixture file: every case here is about ONE relationship
// (threshold ↔ tail, sort ↔ Σ%, filter ↔ matched share), and the numbers have to be readable in
// the assertion, not looked up.

type TermSpec = { id: number; self: number; subtree?: number; hits?: number; ret?: number; kind?: string; label?: string };

function term(t: TermSpec): DebuggerTypes.ProfileTerm {
  return {
    termId: t.id,
    hits: t.hits ?? 1,
    selfCpu: t.self,
    selfMem: t.self,
    totalCpu: t.subtree ?? t.self,
    totalMem: t.subtree ?? t.self,
    returnCpu: t.ret ?? 0,
    returnMem: t.ret ?? 0,
  };
}

/** One location per term, one line each, in id order — the report only needs `startLine`/`kind`. */
function locations(specs: TermSpec[]): TermLocation[] {
  return specs.map((s, i) => ({
    startLine: i,
    endLine: i,
    termId: s.id,
    kind: (s.kind ?? 'Apply') as TermLocation['kind'],
    label: s.label,
  }));
}

function report(specs: TermSpec[], cpuSpent: number, extra: Partial<DebuggerTypes.ProfileTotals> = {}): DebuggerTypes.Profile {
  return {
    terms: specs.map(term),
    builtins: [],
    tracesDropped: 0,
    steps: [],
    timeline: [],
    traces: [],
    totals: {
      attribution: 'last_term',
      cpuSpent,
      memSpent: cpuSpent,
      cpuLimit: null,
      memLimit: null,
      startupCpu: 0,
      startupMem: 0,
      steps: 0,
      outcome: { outcome_type: 'Done' },
      ...extra,
    },
  };
}

function indexOf(specs: TermSpec[], cpuSpent: number, locs = locations(specs)) {
  return buildProfileIndex(report(specs, cpuSpent), locs, 'uplc', 'cpu');
}

const QUERY = {
  scope: 'self' as const,
  sortKey: 'self' as const,
  sortDir: 'desc' as const,
  minSharePct: 0.1,
  hideNeverExecuted: true,
  text: '',
  tailShown: 0,
};

describe('sorting', () => {
  it('index-sorts descending with a stable tie-break on report order', () => {
    const specs = [{ id: 1, self: 5 }, { id: 2, self: 9 }, { id: 3, self: 5 }, { id: 4, self: 1 }];
    const rows = indexOf(specs, 20).rows;
    expect([...rankIndices(rows, 'self', 'desc')]).toEqual([1, 0, 2, 3]);
    expect([...rankIndices(rows, 'self', 'asc')]).toEqual([3, 0, 2, 1]);
  });

  it('ranks by cost per hit, which is not the ranking by cost', () => {
    const specs = [{ id: 1, self: 900, hits: 900 }, { id: 2, self: 100, hits: 1 }];
    const rows = indexOf(specs, 1000).rows;
    expect([...rankIndices(rows, 'self', 'desc')]).toEqual([0, 1]);
    expect([...rankIndices(rows, 'perHit', 'desc')]).toEqual([1, 0]);
  });

  it('opens on self, and on subtree only when the table is showing subtree', () => {
    expect(defaultSortKey('self')).toBe('self');
    expect(defaultSortKey('subtree')).toBe('subtree');
  });
});

describe('Σ% (cumulative)', () => {
  it('accumulates the self share top-down when sorted by self descending', () => {
    const index = indexOf([{ id: 1, self: 50 }, { id: 2, self: 30 }, { id: 3, self: 20 }], 100);
    const d = deriveReport(index, undefined, { ...QUERY });
    expect(d.cumulativeMeaningful).toBe(true);
    expect(d.rows.map((r) => r.cum)).toEqual([0.5, 0.8, 1]);
    expect(d.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('is NaN — the column prints an em dash — under any other sort', () => {
    const index = indexOf([{ id: 1, self: 50 }, { id: 2, self: 30 }], 100);
    for (const q of [{ sortKey: 'hits' as const }, { sortDir: 'asc' as const }, { sortKey: 'subtree' as const }]) {
      const d = deriveReport(index, undefined, { ...QUERY, ...q });
      expect(d.cumulativeMeaningful).toBe(false);
      expect(d.rows.every((r) => Number.isNaN(r.cum))).toBe(true);
    }
  });
});

describe('threshold, tail and caps', () => {
  const specs = [{ id: 1, self: 500 }, { id: 2, self: 300 }, { id: 3, self: 1, hits: 2 }, { id: 4, self: 1, hits: 3 }];

  it('splits at the threshold and reports the hidden tail with its cost', () => {
    const d = deriveReport(indexOf(specs, 1000), undefined, { ...QUERY, minSharePct: 1 });
    expect(d.rows.map((r) => r.row.termId)).toEqual([1, 2]);
    expect(d.aboveCount).toBe(2);
    expect(d.tailCount).toBe(2);
    expect(d.tailSelf).toBe(2);
  });

  it('reveals the tail in the same order the table is sorted in', () => {
    const d = deriveReport(indexOf(specs, 1000), undefined, { ...QUERY, minSharePct: 1, tailShown: 1 });
    expect(d.rows.map((r) => r.row.termId)).toEqual([1, 2, 3]);
    expect(d.tailCount).toBe(1);
    expect(d.tailSelf).toBe(1);
  });

  it('counts only EXECUTED nodes in the tail line, whatever else is in the pool', () => {
    // Two located nodes never ran, so they are not in `terms[]` at all; removing the chip pools
    // them in, but the tail sentence says "executed nodes" and must not count them.
    const locs = [...locations(specs), ...locations([{ id: 90, self: 0 }, { id: 91, self: 0 }])]
      .map((l, i) => ({ ...l, startLine: i }));
    const index = buildProfileIndex(report(specs, 1000), locs, 'uplc', 'cpu');
    const termIndex = new TermIndex(locs, 'uplc');
    const d = deriveReport(index, termIndex, { ...QUERY, minSharePct: 1, hideNeverExecuted: false });
    expect(d.matchedCount).toBe(6);
    expect(d.tailCount).toBe(2);
  });

  it('auto-raises the threshold until the list fits, and says by how much', () => {
    // 900 rows, each hotter than the last: at the 0.10% setting they all pass, so the threshold has
    // to move — locally, and reported through `autoRaised` / `effectiveMinSharePct`.
    const many = Array.from({ length: 900 }, (_, i) => ({ id: i + 1, self: i + 1 }));
    const d = deriveReport(indexOf(many, 405_450), undefined, { ...QUERY });
    expect(d.autoRaised).toBe(true);
    expect(d.effectiveMinSharePct).toBeGreaterThan(0.1);
    expect(d.aboveCount).toBeLessThanOrEqual(AUTO_RAISE_TARGET);
    // The chip prints exactly the threshold that was applied — never a rounded-up one, which would
    // claim to hide rows the table is still showing.
    expect(Number(fmtThreshold(d.effectiveMinSharePct).replace('%', ''))).toBe(d.effectiveMinSharePct);
  });

  it('claims no raise it cannot deliver (a plateau of equal rows)', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, self: 25 }));
    const d = deriveReport(indexOf(many, 10_000), undefined, { ...QUERY });
    expect(d.autoRaised).toBe(false);
    expect(d.effectiveMinSharePct).toBe(0.1);
    expect(d.aboveCount).toBe(400);
  });

  it('leaves the threshold alone when the list already fits', () => {
    const d = deriveReport(indexOf(specs, 1000), undefined, { ...QUERY });
    expect(d.autoRaised).toBe(false);
    expect(d.effectiveMinSharePct).toBe(0.1);
  });

  it('never renders past the ceiling, and flags that it cut', () => {
    const many = Array.from({ length: RENDER_CAP + 500 }, (_, i) => ({ id: i + 1, self: 1 }));
    const d = deriveReport(indexOf(many, RENDER_CAP + 500), undefined, { ...QUERY, minSharePct: 0, tailShown: 0 });
    expect(d.rows.length).toBe(RENDER_CAP);
    expect(d.capped).toBe(true);
    expect(d.totalMatched).toBe(RENDER_CAP + 500);
  });
});

describe('rows with no source location', () => {
  // id 7 ran, but its location belongs to a program parsed earlier in this worker's life — the id
  // generator is global and never restarts, so a live `terms[]` can carry ids this rendering has
  // never heard of. The row is still true; it just cannot be pointed at (the acceptance tests).
  const specs = [{ id: 1, self: 300 }, { id: 2, self: 200 }, { id: 7, self: 500 }];
  const index = buildProfileIndex(report(specs, 1000), locations([specs[0], specs[1]]), 'uplc', 'cpu');

  it('sorts to the END of Ln in BOTH directions, never to the front', () => {
    const asc = deriveReport(index, undefined, { ...QUERY, sortKey: 'line', sortDir: 'asc' });
    const desc = deriveReport(index, undefined, { ...QUERY, sortKey: 'line', sortDir: 'desc' });
    expect(asc.rows.map((r) => r.row.termId)).toEqual([1, 2, 7]);
    expect(desc.rows.map((r) => r.row.termId)).toEqual([2, 1, 7]);
  });

  it('still ranks by cost like any other row', () => {
    const d = deriveReport(index, undefined, { ...QUERY });
    expect(d.rows.map((r) => r.row.termId)).toEqual([7, 1, 2]);
    expect(d.rows[0].row.line).toBeUndefined();
    expect(index.noLocation).toEqual({ count: 1, self: 500 });
  });
});

describe('the never-executed pool', () => {
  const specs = [{ id: 1, self: 600 }, { id: 2, self: 400 }];
  // Two more nodes exist in this RENDERING and never ran, so they are in the term index and nowhere
  // in `terms[]` — the report is the only place they can come from.
  const locs = [
    ...locations(specs),
    ...locations([{ id: 8, self: 0, kind: 'Var', label: 'unused' }, { id: 9, self: 0 }]),
  ].map((l, i) => ({ ...l, startLine: i }));
  const index = buildProfileIndex(report(specs, 1000), locs, 'uplc', 'cpu');
  const termIndex = new TermIndex(locs, 'uplc');
  const POOLED = { ...QUERY, hideNeverExecuted: false, minSharePct: 0 };

  it('appears only when the chip is removed, with zero of every cost and its own line', () => {
    expect(deriveReport(index, termIndex, { ...QUERY }).matchedCount).toBe(2);
    const d = deriveReport(index, termIndex, POOLED);
    expect(d.matchedCount).toBe(4);
    expect(d.rows.map((r) => r.row.termId)).toEqual([1, 2, 8, 9]);
    expect(d.rows[2].row).toMatchObject({ termId: 8, hits: 0, self: 0, subtree: 0, ret: 0, line: 2, kind: 'Var', label: 'unused' });
  });

  it('sits below the threshold, and the tail line does not count it as an executed node', () => {
    const d = deriveReport(index, termIndex, { ...QUERY, hideNeverExecuted: false });
    expect(d.matchedCount).toBe(4);
    expect(d.rows.map((r) => r.row.termId)).toEqual([1, 2]);
    expect(d.tailCount).toBe(0);
    expect(d.tailSelf).toBe(0);
    const more = deriveReport(index, termIndex, { ...QUERY, hideNeverExecuted: false, tailShown: 1 });
    expect(more.rows.map((r) => r.row.termId)).toEqual([1, 2, 8]);
  });

  it('is filtered by the same text rule as a reported row, and adds nothing to the matched share', () => {
    const d = deriveReport(index, termIndex, { ...POOLED, text: 'unused' });
    expect(d.rows.map((r) => r.row.termId)).toEqual([8]);
    expect(d.matchedCount).toBe(1);
    expect(d.matchedSelf).toBe(0);
  });

  it('sorts by Ln like any other row (every cost of it is zero, so only Ln orders it)', () => {
    const asc = deriveReport(index, termIndex, { ...POOLED, sortKey: 'line', sortDir: 'asc' });
    const desc = deriveReport(index, termIndex, { ...POOLED, sortKey: 'line', sortDir: 'desc' });
    expect(asc.rows.map((r) => r.row.termId)).toEqual([1, 2, 8, 9]);
    expect(desc.rows.map((r) => r.row.termId)).toEqual([9, 8, 2, 1]);
  });

  it('is COUNTED whole but MATERIALISED only up to the render ceiling', () => {
    // The pool is held as ranks into the term index; a `ProfileRow` exists for a rendered row and
    // for nothing else. 20 000 nodes here, 200k on the largest term the UI is built for.
    const many = Array.from({ length: 20_000 }, (_, i) => ({ id: 1000 + i, self: 0 }));
    const big = [...locations(specs), ...locations(many)].map((l, i) => ({ ...l, startLine: i }));
    const d = deriveReport(
      buildProfileIndex(report(specs, 1000), big, 'uplc', 'cpu'),
      new TermIndex(big, 'uplc'),
      POOLED,
    );
    expect(d.matchedCount).toBe(20_002);
    expect(d.rows.length).toBe(RENDER_CAP);
    expect(d.capped).toBe(true);
    expect(d.autoRaised).toBe(false); // a threshold cannot cut a plateau of zeros
  });
});

describe('text filter', () => {
  const specs = [
    { id: 1, self: 500, kind: 'Builtin', label: 'unConstrData' },
    { id: 2, self: 300, kind: 'Var', label: 'xs' },
    { id: 3, self: 200, kind: 'Apply' },
  ];

  it('matches the node label and the #id, never the rendered line', () => {
    const rows = indexOf(specs, 1000).rows;
    expect(matchesText(rows[0], 'unconstr')).toBe(true);
    expect(matchesText(rows[1], 'var xs')).toBe(true);
    expect(matchesText(rows[2], '#3')).toBe(true);
    expect(matchesText(rows[2], 'unconstr')).toBe(false);
    expect(matchesText(rows[2], '')).toBe(true);
  });

  it('reports the matched share of the run', () => {
    const d = deriveReport(indexOf(specs, 1000), undefined, { ...QUERY, text: 'Builtin' });
    expect(d.matchedCount).toBe(1);
    expect(d.matchedSelf).toBe(500);
  });
});

describe('top nodes', () => {
  it('ranks by self and totals their share', () => {
    const specs = [
      { id: 1, self: 100, subtree: 900 },
      { id: 2, self: 300, subtree: 400 },
      { id: 3, self: 200, subtree: 200 },
    ];
    const top = topNodes(indexOf(specs, 1000), 2);
    expect(top.rows.map((r) => r.termId)).toEqual([2, 3]);
    expect(top.share).toBeCloseTo(0.5);
  });

  it('skips rows that cannot be revealed (no location in this rendering)', () => {
    const specs = [{ id: 1, self: 900 }, { id: 7, self: 100 }];
    // Only id 1 is in the rendering; id 7 is a stale id from a previously parsed program.
    const index = buildProfileIndex(report(specs, 1000), locations([specs[0]]), 'uplc', 'cpu');
    expect(topNodes(index).rows.map((r) => r.termId)).toEqual([1]);
    expect(index.noLocation).toEqual({ count: 1, self: 100 });
  });
});

describe('the ≈ marker', () => {
  it('marks a row whose self is mostly Return-step cost, under v1 attribution only', () => {
    const rows = indexOf([{ id: 1, self: 100, ret: 60 }, { id: 2, self: 100, ret: 10 }], 200).rows;
    expect(isReturnDominated(rows[0], 'last_term')).toBe(true);
    expect(isReturnDominated(rows[1], 'last_term')).toBe(false);
    expect(isReturnDominated(rows[0], 'apply_site')).toBe(false);
  });
});
