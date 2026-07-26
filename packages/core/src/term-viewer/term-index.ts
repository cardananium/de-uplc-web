// Structural index over one rendering's `TermLocation[]` — and the ONLY place that interprets a
// location's line range.
//
// Two reasons it exists. (1) The serializers disagree about `endLine`: the tree renderer stores it
// EXCLUSIVE (`serialize.ts` assigns the line counter AFTER the closing brace was counted) while the
// canonical one stores it INCLUSIVE (`uplc-pretty.ts`: `lines.length - 1`). Comparing both with
// `<=`, as `findTermAtLine` used to, made every tree-view range overlap one line down — so the same
// node had a different ancestor chain in the two views, and a closing brace resolved to the child
// that ended above it. The index normalises to INCLUSIVE once, at build time, and nothing else
// reads `TermLocation.endLine` again. (2) Every question the profiler and the editor ask (parent
// chain, children, the nodes on a line, the line of a term id) was a linear scan over the array;
// at 200k nodes that is per-keystroke work in the inlay provider and on every gutter click.
//
// Built in ONE pre-order pass: both serializers push a node's location before recursing into its
// children, so the array IS document order, `startLine` is non-decreasing, ranges are properly
// nested and siblings never share a line — a stack of still-open ancestors is all the structure
// needed. Lines stay 0-based, exactly as in `TermLocation`; the `+1` belongs to the editor
// (`new monaco.Range(ln + 1, …)`) and to the report's `Ln` column, nowhere else.

import type { TermLocation } from './serialize';

/** Which renderer produced the locations: `serialize.ts` (debug tree) or `uplc-pretty.ts`. */
export type TermView = 'tree' | 'uplc';

export class TermIndex {
  /** Locations in document (pre-order) order, exactly as the serializer emitted them. */
  readonly locations: readonly TermLocation[];
  /** The renderer they came from — it decides the `endLine` normalisation. */
  readonly view: TermView;
  /** Number of indexed nodes; the denominator the report counts "never evaluated" against. */
  readonly size: number;

  /**
   * Term id → pre-order rank. The rank indexes `locations` and every array below, so this is the
   * one id lookup in the model. One rank per id: `term-index.test.ts` pins
   * `new Set(locations.map((l) => l.termId)).size === locations.length` for both renderers on the
   * e2e fixture. Should that ever break, the FIRST (outermost) occurrence wins here and the
   * several-locations-per-node fallback applies.
   */
  readonly byTermId: ReadonlyMap<number, number>;
  /**
   * 0-based line → ranks of the terms STARTING there, in document order. Starting, not spanning:
   * that is the unit the breakpoint gutter offers and the unit the profiler's per-line aggregate
   * sums over (self-costs of nodes on one line are disjoint exactly because each node is charged
   * to the line it starts on).
   */
  readonly byLine: ReadonlyMap<number, readonly number[]>;

  /** 0-based first line of each node (mirrors `TermLocation.startLine`). */
  readonly startLine: Int32Array;
  /** 0-based LAST line of each node — inclusive in both views, see the header. */
  readonly endLine: Int32Array;
  /** Rank of the enclosing node, `-1` at the root. */
  readonly parent: Int32Array;
  /** Rank of the first child, `-1` for a leaf. */
  readonly firstChild: Int32Array;
  /** Rank of the next sibling, `-1` at the last child. */
  readonly nextSibling: Int32Array;
  /** Distance from the root, `0` at the root. */
  readonly depth: Int32Array;

  constructor(locations: readonly TermLocation[], view: TermView) {
    const n = locations.length;
    this.locations = locations;
    this.view = view;
    this.size = n;

    const startLine = new Int32Array(n);
    const endLine = new Int32Array(n);
    const parent = new Int32Array(n).fill(-1);
    const firstChild = new Int32Array(n).fill(-1);
    const nextSibling = new Int32Array(n).fill(-1);
    const depth = new Int32Array(n);
    // Scratch: where to hang the next child of an open node. Dropped when the pass ends —
    // `firstChild` + `nextSibling` carry the same information without a second array to keep.
    const lastChild = new Int32Array(n).fill(-1);
    const byTermId = new Map<number, number>();
    const byLine = new Map<number, number[]>();
    const open: number[] = []; // ranks of the ancestors still spanning the current line

    for (let i = 0; i < n; i++) {
      const loc = locations[i];
      const start = loc.startLine;
      // THE normalisation. Tree: `endLine` is one past the node's last line. Canonical: it already
      // is the last line. The clamp only stops a degenerate empty range from inverting.
      const end = view === 'tree' ? loc.endLine - 1 : loc.endLine;
      startLine[i] = start;
      endLine[i] = end < start ? start : end;

      // Ranges nest and siblings never share a line, so "still spanning our first line" is exactly
      // "is one of our ancestors".
      while (open.length > 0 && endLine[open[open.length - 1]] < start) open.pop();
      const p = open.length > 0 ? open[open.length - 1] : -1;
      parent[i] = p;
      depth[i] = p < 0 ? 0 : depth[p] + 1;
      if (p >= 0) {
        if (lastChild[p] < 0) firstChild[p] = i;
        else nextSibling[lastChild[p]] = i;
        lastChild[p] = i;
      }
      open.push(i);

      if (!byTermId.has(loc.termId)) byTermId.set(loc.termId, i);
      const onLine = byLine.get(start);
      if (onLine) onLine.push(i);
      else byLine.set(start, [i]);
    }

    this.startLine = startLine;
    this.endLine = endLine;
    this.parent = parent;
    this.firstChild = firstChild;
    this.nextSibling = nextSibling;
    this.depth = depth;
    this.byTermId = byTermId;
    this.byLine = byLine;
  }

  /** The location this rendering emitted for `termId`. */
  locationOf(termId: number): TermLocation | undefined {
    const i = this.byTermId.get(termId);
    return i === undefined ? undefined : this.locations[i];
  }

  /** 0-based line `termId` starts on — what reveal, the heat lane and the `Ln` column need. */
  lineOfTerm(termId: number): number | undefined {
    const i = this.byTermId.get(termId);
    return i === undefined ? undefined : this.startLine[i];
  }

  /** Ranks of `i`'s children, in document order. */
  children(i: number): number[] {
    const out: number[] = [];
    for (let c = this.firstChild[i]; c >= 0; c = this.nextSibling[c]) out.push(c);
    return out;
  }

  /** Ranks of the nodes enclosing `i`, ROOT FIRST — the report's `ENCLOSING NODES` order. */
  ancestors(i: number): number[] {
    const out: number[] = [];
    for (let p = this.parent[i]; p >= 0; p = this.parent[p]) out.push(p);
    return out.reverse();
  }

  /**
   * The most specific term owning a 0-based editor line: a term starting exactly there wins
   * (most nested first), otherwise the most nested term spanning it. Same contract as the linear
   * scan it replaces, minus the off-by-one — see the header.
   */
  findTermAtLine(line: number): TermLocation | undefined {
    const starting = this.byLine.get(line);
    if (starting && starting.length > 0) return this.locations[this.mostNested(starting)];
    // Every node spanning `line` starts at or before it, and nodes that do form a nested chain, so
    // the deepest node starting at or before `line` has all of them among its ancestors.
    for (let i = this.lastStartingAtOrBefore(line); i >= 0; i = this.parent[i]) {
      if (this.endLine[i] >= line) return this.locations[i];
    }
    return undefined;
  }

  /** The term whose start line is closest to `line`; ties go to the outer (earlier) one. */
  findNearestTerm(line: number): TermLocation | undefined {
    if (this.size === 0) return undefined;
    const before = this.lastStartingAtOrBefore(line);
    // `before + 1` is the first term starting strictly after `line` — and, since it is a lower
    // bound, already the earliest of any that share that start line.
    const after = before + 1 < this.size ? before + 1 : -1;
    const below = before >= 0 ? this.firstWithSameStart(before) : -1;
    if (below < 0) return this.locations[after];
    if (after < 0) return this.locations[below];
    return this.locations[line - this.startLine[below] <= this.startLine[after] - line ? below : after];
  }

  /**
   * Resolve a line to a term id the way the gutter does: the term at the line if any, otherwise
   * the nearest one. Returns the breakpoint line (the term's start) and its id.
   */
  termAtLineForBreakpoint(line: number): { line: number; termId: number } | undefined {
    const loc = this.findTermAtLine(line) ?? this.findNearestTerm(line);
    return loc && { line: loc.startLine, termId: loc.termId };
  }

  /** Smallest line span among `ranks`; the first wins a tie (as the old `reduce` did). */
  private mostNested(ranks: readonly number[]): number {
    let best = ranks[0];
    for (const r of ranks) {
      if (this.endLine[r] - this.startLine[r] < this.endLine[best] - this.startLine[best]) best = r;
    }
    return best;
  }

  /** Last rank with `startLine <= line`, or `-1`. Binary search: pre-order ⇒ start lines ascend. */
  private lastStartingAtOrBefore(line: number): number {
    let lo = 0;
    let hi = this.size - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.startLine[mid] <= line) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /** First rank sharing `i`'s start line — the one a distance tie must resolve to. */
  private firstWithSameStart(i: number): number {
    let j = i;
    while (j > 0 && this.startLine[j - 1] === this.startLine[j]) j--;
    return j;
  }
}

// One index per locations array: the array identity changes exactly when the term is re-rendered
// (`loadTermForSession` / `setTermView` both `set()` a fresh one), so callers that only hold
// `termLocations` — the gutter, the right-click menu — get the O(log n) lookups without threading
// an index through the store and without rebuilding it per click.
const INDEX_CACHE = new WeakMap<readonly TermLocation[], TermIndex>();

/** The index for `locations`, built once and memoised on the array's identity. */
export function termIndexFor(locations: readonly TermLocation[], view: TermView): TermIndex {
  const cached = INDEX_CACHE.get(locations);
  if (cached && cached.view === view) return cached;
  const index = new TermIndex(locations, view);
  INDEX_CACHE.set(locations, index);
  return index;
}
