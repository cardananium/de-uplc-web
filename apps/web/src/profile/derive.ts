// Everything the report table and the sidebar's top-5 are: ranking, the running Σ%, the filter
// chips' arithmetic, the tail summary and the row caps.
//
// Pure functions over a built `ProfileIndex` — no React, no store — so the numbers printed in the
// sidebar and the numbers printed in the table cannot drift apart, and so the two rules that are
// easy to get wrong are testable in isolation:
//
//  * ranking is an index-sort (an `Int32Array` of row indices ordered by a `Float64Array` of keys),
//    not `rows.slice().sort()` — at 96k rows the array of objects is the expensive part;
//  * Σ% is a cumulative sum of the SELF share and is therefore meaningful ONLY when the table is
//    sorted by self, descending. Under any other sort the column prints an em dash rather than a
//    monotone-looking number that means nothing.
//
// Nothing here is silent. Every cap and every threshold this module applies comes back out as a
// number the UI is required to print: the auto-raised threshold, the tail count and its cost, and
// the render ceiling.

import type { TermIndex, TermLocation } from '@de-uplc/core';
import type { ProfileMetric, ProfileScope } from '../platform/settings';
import { nodeLabel } from './heat';
import type { ProfileIndex, ProfileRow } from './profile-index';

/** Hard ceiling on rendered rows. Beyond it the UI says `showing 2,000 of N`. */
export const RENDER_CAP = 2000;
/** How much of the tail one `Show 200 more` reveals. */
export const TAIL_PAGE = 200;
/** Above this many rows past the threshold, the threshold is raised LOCALLY (never persisted). */
export const AUTO_RAISE_TARGET = 300;
/** Rows in the sidebar's hottest-nodes list. */
export const TOP_N = 5;

export type SortKey = 'self' | 'subtree' | 'hits' | 'perHit' | 'line';
export type SortDir = 'asc' | 'desc';

export interface ReportQuery {
  /** Which cost the table ranks by. Heat, ruler, F8 and the top-5 ignore this entirely. */
  scope: ProfileScope;
  sortKey: SortKey;
  sortDir: SortDir;
  /** The threshold chip, in PERCENT of the run — the unit `deuplc.profile.minShare` is stored in. */
  minSharePct: number;
  hideNeverExecuted: boolean;
  text: string;
  /** Tail rows revealed so far (`TAIL_PAGE` per click). */
  tailShown: number;
  /** Whether a huge program may raise the threshold locally. The chip that announces the raise
   *  removes like any other, and removing it sets this to `false`. Defaults to on. */
  autoRaise?: boolean;
}

/** A table row: the profile row plus the two things only the ranking knows. */
export interface DerivedRow {
  row: ProfileRow;
  /** 1-based position in the current sort. */
  rank: number;
  /** Cumulative share of the run down to and including this row, or `NaN` when Σ% is meaningless. */
  cum: number;
}

export interface DerivedReport {
  /** What the table renders, in order. */
  rows: DerivedRow[];
  /** Rows matching the text + never-executed filters, both sides of the threshold. */
  matchedCount: number;
  /** Their self cost — the `matched 1,284 nodes · 29.27% of CPU` numerator. */
  matchedSelf: number;
  /** Rows at or above the effective threshold. */
  aboveCount: number;
  /** EXECUTED rows still hidden below the threshold, and their cost — the tail line. */
  tailCount: number;
  tailSelf: number;
  /** True when the render ceiling, not a filter, is what cut the list. */
  capped: boolean;
  /** Rows that matched the filters — the `of N` in `showing 2,000 of N`. */
  totalMatched: number;
  /** The threshold actually applied, in percent. Differs from `minSharePct` only when auto-raised. */
  effectiveMinSharePct: number;
  autoRaised: boolean;
  /** Whether the Σ% column carries a number at all. */
  cumulativeMeaningful: boolean;
}

/** Default sort key for a scope. Self always, unless the table is explicitly showing subtree. */
export function defaultSortKey(scope: ProfileScope): SortKey {
  return scope === 'subtree' ? 'subtree' : 'self';
}

/**
 * The value a row sorts by.
 *
 * A row whose id has no location in this rendering has no line at all, and the acceptance tests puts it
 * at the END of the table whichever way `Ln` is sorted — so it takes whichever infinity that
 * direction sinks. Two of them subtract to `NaN`, which is FALSY, so the `|| a - b` tie-break below
 * still orders them by report order (and the comparator never returns `NaN`).
 */
export function sortValue(row: ProfileRow, key: SortKey, dir: SortDir): number {
  switch (key) {
    case 'self': return row.self;
    case 'subtree': return row.subtree;
    case 'hits': return row.hits;
    case 'perHit': return row.hits > 0 ? row.self / row.hits : 0;
    case 'line': return row.line ?? (dir === 'asc' ? Infinity : -Infinity);
  }
}

/**
 * The index-sort itself: the returned `Int32Array` indexes `values`. Ties break on the original
 * index, which is report order, so the table never reshuffles rows that compare equal (a jitter
 * that reads as a bug when the metric toggles).
 */
function orderOf(values: Float64Array, dir: SortDir): Int32Array {
  const order = new Int32Array(values.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort(dir === 'desc'
    ? (a, b) => values[b] - values[a] || a - b
    : (a, b) => values[a] - values[b] || a - b);
  return order;
}

/** `orderOf` over a row array — the ranking as the sidebar's top-5 and the tests use it. */
export function rankIndices(rows: readonly ProfileRow[], key: SortKey, dir: SortDir): Int32Array {
  const values = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) values[i] = sortValue(rows[i], key, dir);
  return orderOf(values, dir);
}

/** Text filter: the node's label (`Builtin unConstrData`, `Var xs`, bare `Apply`) or its `#id`.
 *  Never the line's TEXT — that differs between the two renderers, so a filter written against one
 *  view would silently match nothing in the other.
 *
 *  Takes the structural minimum rather than a `ProfileRow`, so the never-executed pool can be
 *  filtered straight off its `TermLocation`s — see `neverExecutedRanks`. */
export function matchesText(node: { termId: number; kind?: string; label?: string }, needle: string): boolean {
  if (needle === '') return true;
  if (nodeLabel(node).toLowerCase().includes(needle)) return true;
  return `#${node.termId}`.includes(needle);
}

/** A row's self cost as a share of the run. `0` when the run spent nothing (a profile of an empty
 *  program), so the threshold cannot divide by zero. */
function shareOf(row: ProfileRow, total: number): number {
  return total > 0 ? row.self / total : 0;
}

/** Rows of `pool` at or above a threshold, in percent of the run. */
function countAbove(pool: readonly ProfileRow[], total: number, pct: number): number {
  let n = 0;
  for (const row of pool) if (shareOf(row, total) >= pct / 100) n += 1;
  return n;
}

/** The never-executed pool when there is none — shared, because the chip is on by default. */
const NO_RANKS = new Int32Array(0);

/**
 * The never-executed nodes that match the text filter, as RANKS into `term.locations`.
 *
 * `terms[]` carries only nodes that ran (`profile.rs` filters `hits > 0`), so "never executed"
 * nodes exist in the TERM INDEX and nowhere else. On a 200k-node term, removing
 * the chip pools in ~190k of them — one plain object each is far more work than the ≈15 ms the
 * ranking is budgeted for, and at most `RENDER_CAP` of them can ever reach the DOM. So the pool
 * stays a rank list: costs are all zero by definition, and `neverRow()` builds a row for exactly
 * the ones that are rendered.
 */
function neverExecutedRanks(index: ProfileIndex, term: TermIndex, needle: string): Int32Array {
  const out = new Int32Array(term.size);
  let n = 0;
  for (let i = 0; i < term.size; i++) {
    const loc = term.locations[i];
    if (index.byTermId.has(loc.termId)) continue;
    if (!matchesText(loc, needle)) continue;
    out[n++] = i;
  }
  return out.subarray(0, n);
}

/** A never-executed node as a row. Every cost is zero by definition, so its location is all it
 *  takes — and that is why it can be built this late, per rendered row. */
function neverRow(loc: TermLocation): ProfileRow {
  return {
    termId: loc.termId, hits: 0,
    selfCpu: 0, selfMem: 0, totalCpu: 0, totalMem: 0, returnCpu: 0, returnMem: 0,
    self: 0, subtree: 0, ret: 0,
    line: loc.startLine, kind: loc.kind, label: loc.label,
  };
}

/**
 * The whole table, in one pass over the index.
 *
 * `term` is only needed for the never-executed nodes; pass `undefined` (or leave the chip on) and
 * the pool is the report's own rows.
 *
 * The two pools are kept APART all the way down to the render loop: candidate index `i` is
 * `exec[i]` while `i < exec.length`, and the never-executed node at rank `never[i - exec.length]`
 * otherwise. Only the ranking (a `Float64Array` of keys + an `Int32Array` of indices) spans both.
 */
export function deriveReport(
  index: ProfileIndex,
  term: TermIndex | undefined,
  q: ReportQuery,
): DerivedReport {
  const total = index.total;
  const needle = q.text.trim().toLowerCase();

  const exec: ProfileRow[] = [];
  let matchedSelf = 0;
  for (const row of index.rows) {
    if (!matchesText(row, needle)) continue;
    exec.push(row);
    matchedSelf += row.self; // a never-executed node adds nothing to it, by definition
  }
  const never = q.hideNeverExecuted || !term ? NO_RANKS : neverExecutedRanks(index, term, needle);
  const locations = term?.locations ?? [];
  const n = exec.length + never.length;

  // The threshold is a per-ROW predicate (share of the run), not a position, so raising it can only
  // ever remove rows — which is what makes the auto-raise safe to do locally and reversible. A
  // zero-cost row has share 0, so it passes a zero threshold and nothing else.
  let effective = q.minSharePct;
  let autoRaised = false;
  let above = countAbove(exec, total, effective) + (effective <= 0 ? never.length : 0);
  if (q.autoRaise !== false && above > AUTO_RAISE_TARGET && total > 0) {
    // The share of the AUTO_RAISE_TARGET-th hottest row is the smallest threshold that leaves the
    // list at the target. It is FLOORED to a printable precision, not used raw, so the chip's
    // `≥ 0.42%` is the threshold that was actually applied — and the first precision that removes
    // any row wins, because a 200k-node program's 300th row can sit below 0.01%.
    const selves = new Float64Array(exec.length);
    for (let i = 0; i < exec.length; i++) selves[i] = exec[i].self;
    selves.sort();
    // Zero is the minimum of that array, so the never-executed pool cannot displace the
    // AUTO_RAISE_TARGET-th largest value — unless there are fewer executed rows than that, in which
    // case the value IS zero. Folded in arithmetically rather than by padding the array.
    const cut = ((exec.length >= AUTO_RAISE_TARGET ? selves[exec.length - AUTO_RAISE_TARGET] : 0) / total) * 100;
    let bestRaised = 0;
    let bestKept = above;
    // More decimals ⇒ the floor sits closer to the cut ⇒ fewer rows survive, monotonically. Stop at
    // the first precision that reaches the target; keep the best reduction if none does.
    for (const decimals of [2, 3, 4]) {
      const step = 10 ** decimals;
      const raised = Math.floor(cut * step) / step;
      if (raised <= effective) continue;
      // `raised > effective >= 0`, so no zero-cost row survives it: only `exec` can be kept.
      const kept = countAbove(exec, total, raised);
      if (kept >= bestKept) continue; // a plateau of equal rows: no threshold cuts it, so say nothing
      bestRaised = raised;
      bestKept = kept;
      if (kept <= AUTO_RAISE_TARGET) break;
    }
    if (bestRaised > effective) {
      effective = bestRaised;
      above = bestKept;
      autoRaised = true;
    }
  }

  // One sort over everything that matched; the threshold then splits the sorted list in two, so the
  // tail is revealed in the same order the table is already in.
  const values = new Float64Array(n);
  for (let i = 0; i < exec.length; i++) values[i] = sortValue(exec[i], q.sortKey, q.sortDir);
  // A never-executed node costs zero in every metric, so only `Ln` can tell two of them apart.
  for (let i = 0; i < never.length; i++) {
    values[exec.length + i] = q.sortKey === 'line' ? locations[never[i]].startLine : 0;
  }
  const order = orderOf(values, q.sortDir);

  const min = effective / 100;
  const tailTaken = Math.min(q.tailShown, n - above);
  const wanted = above + tailTaken;
  const shown = Math.min(wanted, RENDER_CAP);
  const headWanted = Math.min(shown, above);
  const tailWanted = shown - headWanted;
  const cumulativeMeaningful = q.sortKey === 'self' && q.sortDir === 'desc';

  // ONE pass over the ranking fills the head, the revealed part of the tail and the tail summary.
  // `head`/`tail` hold candidate INDICES, at most `RENDER_CAP` of them between them.
  const head: number[] = [];
  const tail: number[] = [];
  let seenTail = 0;
  let tailCount = 0;
  let tailSelf = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    if ((i < exec.length ? shareOf(exec[i], total) : 0) >= min) {
      if (head.length < headWanted) head.push(i);
      continue;
    }
    if (seenTail++ < tailTaken) {
      if (tail.length < tailWanted) tail.push(i);
      continue;
    }
    // "executed nodes below X%" is exactly that: never-executed rows are accounted for by their own
    // line, so they may not be counted twice here.
    if (i < exec.length && exec[i].hits > 0) {
      tailCount += 1;
      tailSelf += exec[i].self;
    }
  }

  const rows: DerivedRow[] = [];
  let cum = 0;
  for (let k = 0; k < head.length + tail.length; k++) {
    const i = k < head.length ? head[k] : tail[k - head.length];
    const row = i < exec.length ? exec[i] : neverRow(locations[never[i - exec.length]]);
    cum += shareOf(row, total);
    rows.push({ row, rank: k + 1, cum: cumulativeMeaningful ? cum : NaN });
  }

  return {
    rows,
    matchedCount: n,
    matchedSelf,
    aboveCount: above,
    tailCount,
    tailSelf,
    capped: wanted > RENDER_CAP,
    totalMatched: n,
    effectiveMinSharePct: effective,
    autoRaised,
    cumulativeMeaningful,
  };
}

/** The sidebar's hottest nodes and what they add up to. */
export interface TopNodes {
  rows: ProfileRow[];
  /** Their combined share of the run — the `Top 5 = 34.35% of CPU` number. */
  share: number;
}

/**
 * Top nodes by SELF, always — never by `scope`. Under `subtree` every ancestor of a hot node
 * carries nearly the same number, so the list would degenerate into the AST spine (`Apply 100%`,
 * `Force 99.1%`, …) instead of naming the node to go and fix.
 *
 * Only located rows are listed: every entry offers "reveal in the editor", and the rows that have
 * no location are reported by the report tab's own `⚠ N nodes … have no source location` line.
 */
export function topNodes(index: ProfileIndex, n: number = TOP_N): TopNodes {
  const located = index.rows.filter((r) => r.line !== undefined && r.self > 0);
  const order = rankIndices(located, 'self', 'desc');
  const rows: ProfileRow[] = [];
  let sum = 0;
  for (let i = 0; i < Math.min(n, order.length); i++) {
    const row = located[order[i]];
    rows.push(row);
    sum += row.self;
  }
  return { rows, share: index.total > 0 ? sum / index.total : 0 };
}

/**
 * The `≈` marker: this row's self is dominated by cost charged on Return steps, which v1 attributes
 * to the last node that executed rather than to the apply site it returns into. Under `apply_site`
 * attribution the marker does not exist at all.
 */
export const RETURN_DOMINATED = 0.5;

export function isReturnDominated(row: ProfileRow, attribution: 'last_term' | 'apply_site'): boolean {
  return attribution === 'last_term' && row.self > 0 && row.ret / row.self >= RETURN_DOMINATED;
}

/**
 * A threshold for the chip. Two decimals like every other percentage, but a threshold the auto-raise
 * derived from a 200k-node program can be smaller than that — and a chip reading `≥ 0.00%` next to a
 * table that visibly dropped rows is worse than one extra digit.
 */
export function fmtThreshold(pct: number): string {
  if (!(pct > 0)) return '0%';
  for (const d of [2, 3, 4]) {
    const s = pct.toFixed(d);
    if (Number(s) === pct) return `${s}%`;
  }
  return `${pct.toFixed(4)}%`;
}

/** Unit word for the active metric, as the report's prose spells it (`44.06% of CPU`). */
export function metricWord(metric: ProfileMetric): string {
  return metric === 'cpu' ? 'CPU' : 'Mem';
}

/** Unit suffix for a raw number in the active metric (`51,555,012 cpu`). */
export function metricUnit(metric: ProfileMetric): string {
  return metric === 'cpu' ? 'cpu' : 'mem';
}
