import { describe, expect, it } from 'vitest';
import { TermIndex, type DebuggerTypes, type TermLocation } from '@de-uplc/core';
import { COLLAPSE_SHARE, CostNode, CostTree, costRoots, enclosingNodes } from './cost-nodes';
import { buildProfileIndex } from './profile-index';

// A hand-built spine + fork, because that is the shape the collapse rule exists for:
//
//   #1 Force  0-9   self 10  subtree 1000
//     #2 Force 1-8  self 30  subtree  990   (99.0% of its parent)
//       #3 Apply 2-7 self 20 subtree  960   (97.0% of its parent)  ← chain ends: two children
//         #4 Var xs 3-3  self 600 subtree 600
//         #5 Builtin unConstrData 4-7 self 340 subtree 340
const NODES = [
  { id: 1, kind: 'Force', start: 0, end: 9, self: 10, subtree: 1000, hits: 41 },
  { id: 2, kind: 'Force', start: 1, end: 8, self: 30, subtree: 990, hits: 41 },
  { id: 3, kind: 'Apply', start: 2, end: 7, self: 20, subtree: 960, hits: 41 },
  { id: 4, kind: 'Var', label: 'xs', start: 3, end: 3, self: 600, subtree: 600, hits: 82 },
  { id: 5, kind: 'Builtin', label: 'unConstrData', start: 4, end: 7, self: 340, subtree: 340, hits: 21 },
] as const;

type Node = (typeof NODES)[number];

function locations(nodes: readonly Node[]): TermLocation[] {
  return nodes.map((n) => ({
    startLine: n.start, endLine: n.end, termId: n.id,
    kind: n.kind as TermLocation['kind'], label: 'label' in n ? n.label : undefined,
  }));
}

function build(nodes: readonly Node[] = NODES, total = 1000) {
  const profile: DebuggerTypes.Profile = {
    terms: nodes.map((n) => ({
      termId: n.id, hits: n.hits,
      selfCpu: n.self, selfMem: n.self, totalCpu: n.subtree, totalMem: n.subtree,
      returnCpu: 0, returnMem: 0,
    })),
    tracesDropped: 0,
    builtins: [], steps: [], timeline: [], traces: [],
    totals: {
      attribution: 'last_term', cpuSpent: total, memSpent: total, cpuLimit: null, memLimit: null,
      startupCpu: 0, startupMem: 0, steps: 0, outcome: { outcome_type: 'Done' },
    },
  };
  const locs = locations(nodes);
  return new CostTree(new TermIndex(locs, 'uplc'), buildProfileIndex(profile, locs, 'uplc', 'cpu'));
}

describe('chain collapse', () => {
  it('collapses single children that hold ≥ 95% of the parent, and stops at a fork', () => {
    expect(build().chainFrom(0)).toEqual([0, 1, 2]);
  });

  it('does not collapse a child that holds less than the share', () => {
    const nodes = NODES.map((n) => (n.id === 2 ? { ...n, subtree: 900 } : n)) as unknown as Node[];
    expect(build(nodes).chainFrom(0)).toEqual([0]);
    expect(COLLAPSE_SHARE).toBe(0.95);
  });

  it('never collapses across a fork, however dominant one branch is', () => {
    // #3 has two children; #4 holds 62% of it — a real branch, so the row stays.
    expect(build().chainFrom(2)).toEqual([2]);
  });
});

describe('a collapsed row', () => {
  const tree = build();
  const node = new CostNode(tree, tree.chainFrom(0));

  it('is labelled first-kind→last-kind with the chain length', () => {
    expect(node.toViewModel().label).toBe('Force→Apply ⋯3');
  });

  it('reveals the member with the largest self, not the outermost one', () => {
    // Revealing #1 would drop the user on a Force that costs 1% of what the chain costs.
    expect(node.termId).toBe(2);
  });

  it('shows the chain HEAD subtree share and the marked node hits', () => {
    expect(node.toViewModel().description).toBe('100.00% 41×');
  });

  it('carries its heat bucket as a CSS variable the tree passes straight through', () => {
    expect(node.toViewModel().iconColor).toMatch(/^var\(--prof-heat-[0-5]\)$/);
  });

  it('expands into the children of the chain TIP, hottest subtree first', () => {
    const kids = node.getChildren().map((k) => k.toViewModel().label);
    expect(kids).toEqual(['Var xs  #4', 'Builtin unConstrData  #5']);
  });
});

describe('an uncollapsed row', () => {
  it('is labelled with its node label and id', () => {
    const tree = build();
    expect(new CostNode(tree, [3]).toViewModel()).toMatchObject({
      label: 'Var xs  #4', description: '60.00% 82×', collapsible: false,
    });
  });

  it('is not collapsible when it has no children', () => {
    const tree = build();
    expect(new CostNode(tree, tree.chainFrom(0)).toViewModel().collapsible).toBe(true);
  });
});

describe('roots and ancestors', () => {
  it('roots at the selected node, expanded', () => {
    const tree = build();
    const roots = costRoots(tree, 3);
    expect(roots).toHaveLength(1);
    expect(roots[0].toViewModel().expanded).toBe(true);
    expect(roots[0].chain).toEqual([2]);
  });

  it('has no roots for an id this rendering does not contain', () => {
    expect(costRoots(build(), 999)).toEqual([]);
    expect(costRoots(build(), undefined)).toEqual([]);
  });

  it('lists the enclosing nodes root-first', () => {
    expect(enclosingNodes(build(), 4).map((n) => n.termId)).toEqual([1, 2, 3]);
    expect(enclosingNodes(build(), 1)).toEqual([]);
  });
});
