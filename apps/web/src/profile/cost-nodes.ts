// `INSIDE THIS NODE` — the selected node's static AST subtree, priced.
//
// It is a `UplcNode` implementation, so the existing `<Tree>` renders it with no new component and
// no new keyboard model: `getChildren()` may return an array synchronously (`uplc-tree/nodes.ts`),
// a UPLC node has at most a handful of children, and the tree is lazy — only what was expanded is
// in the DOM. The "reveal in editor" button comes for free from `node.termId`.
//
// The one thing this file adds on top of the raw AST is CHAIN COLLAPSE. A UPLC term is mostly
// spine: `Force (Apply (Force (Apply …)))`, each level holding essentially all of its parent's
// subtree cost. Rendering that faithfully means four clicks to descend four rows that all say
// 62.40%. So a chain of single children that each hold ≥ 95% of the parent's subtree becomes ONE
// row, `Force→Apply ⋯4`, and its `termId` is the member with the largest SELF — reveal has to land
// on the node that actually costs something, not on the outermost `Force` of the chain.

import type { NodeView, TermIndex, UplcNode } from '@de-uplc/core';
import { fmtInt, fmtLn, fmtPct } from './format';
import { bucketOf, nodeLabel, NO_BUCKET } from './heat';
import type { ProfileIndex, ProfileRow } from './profile-index';

/** A child holding at least this much of its parent's subtree is spine, not structure. */
export const COLLAPSE_SHARE = 0.95;

/** Costs of one AST node, zero-filled for a node that never ran (those are not in `terms[]`). */
export interface NodeCost {
  termId: number;
  self: number;
  subtree: number;
  hits: number;
  line?: number;
  kind?: string;
  label?: string;
}

const ZERO = { self: 0, subtree: 0, hits: 0 };

/**
 * The two indices the cost tree joins, plus the run total the percentages are of. One instance per
 * (profile × rendering); `CostNode`s hold a reference and stay tiny.
 */
export class CostTree {
  constructor(
    readonly term: TermIndex,
    readonly profile: ProfileIndex,
  ) {}

  /** Costs at a pre-order rank. */
  costAt(rank: number): NodeCost {
    const loc = this.term.locations[rank];
    const row: ProfileRow | undefined = this.profile.rowFor(loc.termId);
    const c = row ?? ZERO;
    return {
      termId: loc.termId,
      self: c.self,
      subtree: c.subtree,
      hits: c.hits,
      line: loc.startLine,
      kind: loc.kind,
      label: loc.label,
    };
  }

  /**
   * The collapse chain starting at `rank`: itself, then every single child that holds ≥ 95% of its
   * parent's subtree. A node with two children ends the chain even when one of them dominates —
   * that is a real branch and hiding it would hide where the cost went.
   */
  chainFrom(rank: number): number[] {
    const chain = [rank];
    for (;;) {
      const last = chain[chain.length - 1];
      const first = this.term.firstChild[last];
      if (first < 0 || this.term.nextSibling[first] >= 0) break;
      const parent = this.costAt(last).subtree;
      const child = this.costAt(first).subtree;
      if (!(child >= COLLAPSE_SHARE * parent)) break;
      chain.push(first);
    }
    return chain;
  }
}

/** One row of `INSIDE THIS NODE`: a node, or a collapsed chain of them. */
export class CostNode implements UplcNode {
  /** The member the row identifies: the largest SELF in the chain (ties go to the outermost). */
  readonly termId: number;
  private readonly head: NodeCost;
  private readonly tip: NodeCost;
  private readonly marked: NodeCost;

  constructor(
    private readonly tree: CostTree,
    /** Pre-order ranks, outermost first. Length 1 unless the chain collapsed. */
    readonly chain: number[],
    private readonly startExpanded = false,
  ) {
    this.head = tree.costAt(chain[0]);
    this.tip = tree.costAt(chain[chain.length - 1]);
    let best = this.head;
    for (const rank of chain) {
      const c = tree.costAt(rank);
      if (c.self > best.self) best = c;
    }
    this.marked = best;
    this.termId = best.termId;
  }

  toViewModel(): NodeView {
    const total = this.tree.profile.total;
    // The chain's cost IS the head's: every member holds ≥ 95% of the one above, and `subtree`
    // already includes all of them.
    const bucket = bucketOf(this.marked.self, total, this.marked.hits);
    const collapsed = this.chain.length > 1;
    const label = collapsed
      ? `${this.head.kind ?? 'Term'}→${this.tip.kind ?? 'Term'} ⋯${this.chain.length}`
      : `${nodeLabel(this.head)}  #${this.head.termId}`;
    return {
      label,
      description: `${fmtPct(this.head.subtree, total)} ${fmtInt(this.marked.hits)}×`,
      collapsible: this.tree.term.firstChild[this.chain[this.chain.length - 1]] >= 0,
      expanded: this.startExpanded,
      icon: bucket === NO_BUCKET ? 'circle-small-filled' : 'circle-filled',
      // A `var(--…)` passes straight through `iconColorVar` (Tree.tsx), so the dot carries the same
      // bucket colour as the editor's cost lane without a second palette.
      iconColor: bucket === NO_BUCKET ? undefined : `var(--prof-heat-${bucket})`,
      tooltip: [
        collapsed
          ? `${this.chain.length} nodes collapsed — each holds at least ${Math.round(COLLAPSE_SHARE * 100)}% of the one above it.`
          : nodeLabel(this.head),
        `self ${fmtInt(this.marked.self)} (${fmtPct(this.marked.self, total)}) · subtree ${fmtInt(this.head.subtree)} (${fmtPct(this.head.subtree, total)})`,
        `${fmtInt(this.marked.hits)} hits · ${this.marked.line === undefined ? '—' : fmtLn(this.marked.line)}`,
      ].join('\n'),
      contextValue: 'profileCostNode',
    };
  }

  /** Children of the chain's LAST member, hottest subtree first. */
  getChildren(): UplcNode[] {
    const tip = this.chain[this.chain.length - 1];
    const kids = this.tree.term.children(tip).map((rank) => new CostNode(this.tree, this.tree.chainFrom(rank)));
    kids.sort((a, b) => b.subtreeCost() - a.subtreeCost() || a.chain[0] - b.chain[0]);
    return kids;
  }

  /** The subtree cost this row shows — used to order siblings. */
  subtreeCost(): number {
    return this.head.subtree;
  }
}

/**
 * Roots for the `INSIDE THIS NODE` tree: the selected node itself, expanded, so the panel opens
 * showing where its cost went instead of a single collapsed row.
 *
 * Empty when the id has no location in this rendering — a stale id from a previously parsed program
 * (the engine's id generator never restarts), which the report reports as such and cannot draw.
 */
export function costRoots(tree: CostTree, termId: number | undefined): CostNode[] {
  if (termId === undefined) return [];
  const rank = tree.term.byTermId.get(termId);
  if (rank === undefined) return [];
  return [new CostNode(tree, tree.chainFrom(rank), true)];
}

/** `ENCLOSING NODES (root → here)`: the static AST parents, priced. Not a call stack — UPLC has
 *  none — and the panel says so in words right under the list. */
export function enclosingNodes(tree: CostTree, termId: number | undefined): NodeCost[] {
  if (termId === undefined) return [];
  const rank = tree.term.byTermId.get(termId);
  if (rank === undefined) return [];
  return tree.term.ancestors(rank).map((r) => tree.costAt(r));
}
