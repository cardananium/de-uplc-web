// The derived view of a profile: report rows joined to the current rendering's lines, plus the
// per-line arrays every editor surface reads in O(1).
//
// It is built in the STORE, not in the editor, for two reasons. The editor may not be mounted (the
// report tab can be the active one), and `setTermView` replaces `termText`, `termLocations` and
// this index in ONE `set()` — so a render can never see a new text with an old index. That is also
// why every per-line array is sized from `termLocations` (`maxStartLine + 1`) and never from
// `model.getLineCount()`: there is no model here.
//
// Metric-dependent (buckets are shares of the ACTIVE metric's total), scope-INdependent (`scope`
// only reorders the report table). So it is rebuilt on `setProfileMetric` and `setTermView`,
// and on nothing else.

import { termIndexFor, type DebuggerTypes, type TermLocation, type TermView } from '@de-uplc/core';
import type { ProfileMetric } from '../platform/settings';
import { bucketOf, HOT_BUCKET, NO_BUCKET, type LaneContext, type LaneStats } from './heat';

/** One profiled node: the engine's row, joined to where this rendering put it. */
export interface ProfileRow extends DebuggerTypes.ProfileTerm {
  /** Self cost in the ACTIVE metric (`selfCpu` or `selfMem`). */
  self: number;
  /** Subtree cost in the active metric (`totalCpu` or `totalMem`). */
  subtree: number;
  /** Part of `self` charged on Return steps, active metric — the `≈` marker's numerator. */
  ret: number;
  /** 0-based start line, or `undefined` when this id has no location in this rendering
   *  (a stale id from a previously parsed program — the id generator never restarts). */
  line?: number;
  kind?: string;
  label?: string;
}

/** Nodes that ran but cannot be pointed at — reported as a line, never silently dropped. */
export interface NoLocationSummary { count: number; self: number }

export class ProfileIndex {
  readonly metric: ProfileMetric;
  readonly view: TermView;
  /** Totals of the active metric: the `% run` denominator, and the bucket scale's total. */
  readonly total: number;
  /** Declared limit of the active metric, or `null` when the session has no redeemer. */
  readonly limit: number | null;
  /** Everything `heat.ts`'s text builders need besides the line itself. */
  readonly context: LaneContext;

  /** Rows in report order. */
  readonly rows: readonly ProfileRow[];
  readonly byTermId: ReadonlyMap<number, ProfileRow>;

  /** Number of nodes in this rendering (`TermIndex.size`) — the denominator for "never evaluated". */
  readonly nodeCount: number;
  /** Located nodes with `hits === 0`. */
  readonly neverEvaluated: number;
  readonly noLocation: NoLocationSummary;

  // Per-line arrays, length `maxStartLine + 1`. Self SUMS over a line's nodes (their self-costs are
  // disjoint — each node is charged to the line it starts on); subtree takes the MAX (nested
  // subtrees would double-count). Same rule the hover card states in words.
  readonly lineSelf: Float64Array;
  readonly lineSubtree: Float64Array;
  readonly lineHits: Float64Array;
  /** Bucket per line, or `NO_BUCKET` (255) where nothing is painted. */
  readonly lineBucket: Uint8Array;

  /** Lines with a bucket, hottest first — the heat layer paints the first N of these. */
  readonly ranked: Int32Array;
  /** Lines with `bucket >= HOT_BUCKET`, ASCENDING — F8/Shift+F8 binary-search this. */
  readonly hotLines: Int32Array;

  /** Nodes starting on a line, hottest first. Only for lines that carry cost. */
  private readonly nodesByLine: Map<number, ProfileRow[]>;

  constructor(
    report: DebuggerTypes.Profile,
    locations: readonly TermLocation[],
    view: TermView,
    metric: ProfileMetric,
  ) {
    const index = termIndexFor(locations, view);
    const cpu = metric === 'cpu';
    this.metric = metric;
    this.view = view;
    this.total = cpu ? report.totals.cpuSpent : report.totals.memSpent;
    this.limit = (cpu ? report.totals.cpuLimit : report.totals.memLimit) ?? null;
    this.context = {
      metric,
      total: this.total,
      limit: this.limit,
      attribution: report.totals.attribution,
    };
    this.nodeCount = index.size;

    let maxLine = -1;
    for (const loc of locations) if (loc.startLine > maxLine) maxLine = loc.startLine;
    const lineCount = maxLine + 1;

    const lineSelf = new Float64Array(lineCount);
    const lineSubtree = new Float64Array(lineCount);
    const lineHits = new Float64Array(lineCount);
    const lineBucket = new Uint8Array(lineCount).fill(NO_BUCKET);
    const nodesByLine = new Map<number, ProfileRow[]>();
    const byTermId = new Map<number, ProfileRow>();
    const rows: ProfileRow[] = [];
    const noLocation: NoLocationSummary = { count: 0, self: 0 };
    let executed = 0;

    for (const t of report.terms) {
      const rank = index.byTermId.get(t.termId);
      const loc = rank === undefined ? undefined : index.locations[rank];
      const row: ProfileRow = {
        ...t,
        self: cpu ? t.selfCpu : t.selfMem,
        subtree: cpu ? t.totalCpu : t.totalMem,
        ret: cpu ? t.returnCpu : t.returnMem,
        line: loc?.startLine,
        kind: loc?.kind,
        label: loc?.label,
      };
      rows.push(row);
      byTermId.set(t.termId, row);
      if (row.line === undefined) {
        // An id outside this rendering: the profile is still truthful, it just cannot be revealed.
        noLocation.count += 1;
        noLocation.self += row.self;
        continue;
      }
      if (t.hits > 0) executed += 1;
      const ln = row.line;
      lineSelf[ln] += row.self;
      if (row.subtree > lineSubtree[ln]) lineSubtree[ln] = row.subtree;
      lineHits[ln] += t.hits;
      const onLine = nodesByLine.get(ln);
      if (onLine) onLine.push(row);
      else nodesByLine.set(ln, [row]);
    }

    // Buckets from the per-LINE aggregate, so what the eye compares is what the tooltip prints.
    const painted: number[] = [];
    const hot: number[] = [];
    for (const ln of nodesByLine.keys()) {
      const b = bucketOf(lineSelf[ln], this.total, lineHits[ln]);
      if (b === NO_BUCKET) continue;
      lineBucket[ln] = b;
      painted.push(ln);
      if (b >= HOT_BUCKET) hot.push(ln);
    }
    painted.sort((a, b) => lineSelf[b] - lineSelf[a] || a - b);
    hot.sort((a, b) => a - b);
    for (const list of nodesByLine.values()) list.sort((a, b) => b.self - a.self || a.termId - b.termId);

    this.rows = rows;
    this.byTermId = byTermId;
    this.noLocation = noLocation;
    this.neverEvaluated = Math.max(0, index.size - executed);
    this.lineSelf = lineSelf;
    this.lineSubtree = lineSubtree;
    this.lineHits = lineHits;
    this.lineBucket = lineBucket;
    this.ranked = Int32Array.from(painted);
    this.hotLines = Int32Array.from(hot);
    this.nodesByLine = nodesByLine;
  }

  /** Number of 0-based lines the per-line arrays cover. */
  get lineCount(): number {
    return this.lineSelf.length;
  }

  /** Bucket painted on a 0-based line, or `NO_BUCKET`. Safe outside the array. */
  bucketAt(line: number): number {
    return line >= 0 && line < this.lineBucket.length ? this.lineBucket[line] : NO_BUCKET;
  }

  /** Everything the lane's tooltip / hover card / inlay hint need for a line, or `undefined` when
   *  the line carries no cost. One O(1) read — no scan can creep into the inlay provider. */
  laneStats(line: number): LaneStats | undefined {
    const nodes = this.nodesByLine.get(line);
    if (!nodes) return undefined;
    return {
      line,
      self: this.lineSelf[line],
      subtree: this.lineSubtree[line],
      hits: this.lineHits[line],
      nodes: nodes.map((n) => ({ termId: n.termId, kind: n.kind, label: n.label, self: n.self, hits: n.hits })),
    };
  }

  /** The row for a term id (the report's selection, the editor's "Show in profile"). */
  rowFor(termId: number): ProfileRow | undefined {
    return this.byTermId.get(termId);
  }
}

/**
 * Build the index for a report against the CURRENT rendering. Metric-dependent, scope-independent
 * — call it from `setProfileMetric` and `setTermView` (both guarded on a non-empty profile), and
 * once when a run's report arrives.
 */
export function buildProfileIndex(
  report: DebuggerTypes.Profile,
  locations: readonly TermLocation[],
  view: TermView,
  metric: ProfileMetric,
): ProfileIndex {
  return new ProfileIndex(report, locations, view, metric);
}
