// The profiler's heat scale: how a share of the run becomes a bucket, what each bucket looks
// like, and the two text surfaces the lane decoration carries (native tooltip + hover card).
//
// This module is the SOURCE of the twelve heat hexes. `scripts/gen-heat-tokens.mjs` prints the
// `--prof-heat-*` block into `theme/tokens.css` and the six `deuplc.profHeat0..5` entries into
// BOTH theme maps in `editor/monaco.ts`; `heat.test.ts` re-reads those files as text and fails on
// any divergence. Never hand-edit a hex in either destination.

import type { ProfileMetric } from '../platform/settings';
import { fmtInt, fmtLn, fmtPct } from './format';

/** Six buckets, 0 = coldest. `NO_BUCKET` means "not painted at all" (see `bucketOf`). */
export type HeatBucket = 0 | 1 | 2 | 3 | 4 | 5;
export const NO_BUCKET = 255;
export const BUCKET_COUNT = 6;

/**
 * Lower bound of each bucket as a FRACTION of the active metric's total, `self` always.
 * Indexed by bucket. Half-decade steps (×√10 ≈ 3.16) on a LOG scale with FIXED cut-points:
 *  - not linear, because the distribution has a long tail and 95% of lines would land in bucket 0;
 *  - not quantile, because quantiles normalise inside one profile — a cheap program would look as
 *    hot as one that blows its budget, and two profiles would stop being comparable.
 * A fixed scale means the same colour means the same share in every profile, forever.
 */
export const HEAT_THRESHOLDS: readonly number[] = [
  0.00032, // 0.032%
  0.001,   // 0.1%
  0.0032,  // 0.32%
  0.01,    // 1%
  0.032,   // 3.2%
  0.10,    // 10%
];

/** Bucket ≥ this is "hot": what F8/Shift+F8 step through and what earns an inlay hint. */
export const HOT_BUCKET = 3;

/**
 * Bucket for a self-cost, or `NO_BUCKET`. Zero-suppression is part of the scale, not a caller's
 * option: a node that never executed (`hits === 0`) and a share below the bottom threshold paint
 * NOTHING. Unmarked lines are the background that makes marked ones visible.
 */
export function bucketOf(self: number, total: number, hits: number): HeatBucket | typeof NO_BUCKET {
  if (hits <= 0 || !(total > 0) || !(self > 0)) return NO_BUCKET;
  const share = self / total;
  for (let b = BUCKET_COUNT - 1; b >= 0; b--) {
    if (share >= HEAT_THRESHOLDS[b]) return b as HeatBucket;
  }
  return NO_BUCKET;
}

/**
 * Lane classes: the shared one plus the bucket's, which carries colour AND width (4 → 14px), plus
 * — when the line's cost is dominated by Return-step attribution — the `≈` marker's lane form
 *: the bar is dimmed to 0.6, the way the report table marks the row `≈`. v1 regularly
 * charges a builtin's cost to its argument, and a "hot" `Var` with no caveat costs trust in the
 * whole report — so the caveat is on the number the eye actually reads, not only in the table.
 * The dimming is never the ONLY carrier: `laneTooltip` and `laneHoverMarkdown` say it in words.
 */
export function laneClass(bucket: HeatBucket, approx = false): string {
  return `prof-lane prof-heat-${bucket}${approx ? ' prof-lane-approx' : ''}`;
}

/** Monaco theme-colour id for a bucket's overview-ruler mark. Resolved by Monaco from the editor
 *  theme, so the ruler re-colours itself on a theme change with no React render at all. */
export function rulerColorId(bucket: HeatBucket): string {
  return `deuplc.profHeat${bucket}`;
}

/**
 * The ramp. One monotonic-in-lightness gradient that avoids the red/green axis and the semantic
 * blue: light = hotter is darker, dark = hotter is lighter. Hue arc amber → rose → magenta →
 * purple → indigo (a reversed magma), which runs along the blue↔yellow axis dichromats retain.
 *
 * Ratios in the comments are WCAG 2.x against the REAL editor backgrounds (monaco.ts
 * THEME_COLORS / THEME_COLORS_DARK) and against the caret-line composite — `renderLineHighlight:
 * 'gutter'` paints the highlight ACROSS the margin, so on the caret's line the lane sits on
 * #f6f6f6 / #151921, not on the editor background. `heat.test.ts` recomputes both.
 *
 * Colour ORDERS the buckets under any vision model; lane WIDTH identifies them. A ΔE00 ≥ 12 floor
 * between neighbours is unreachable for any ordered ramp under protanopia, so the two channels
 * split the job rather than pretending one does it.
 */
export const HEAT_LIGHT: readonly string[] = [
  '#968800', //  3.61:1 / 3.34:1
  '#c14573', //  4.81:1 / 4.45:1   step +33%
  '#913f76', //  6.61:1 / 6.12:1   step +37%
  '#6f2b89', //  8.81:1 / 8.16:1   step +33%
  '#231f96', // 12.30:1 / 11.38:1  step +40%
  '#0f1d42', // 16.47:1 / 15.24:1  step +34%
];

export const HEAT_DARK: readonly string[] = [
  '#806a1b', //  3.60:1 / 3.35:1
  '#c85d84', //  4.82:1 / 4.49:1   step +34%
  '#f665a6', //  6.61:1 / 6.15:1   step +37%
  '#e29eca', //  8.99:1 / 8.36:1   step +36%
  '#d7c5ff', // 12.00:1 / 11.17:1  step +34%
  '#efe4fe', // 15.50:1 / 14.42:1  step +29%
];

/** The profiler's accent (button, pill, badge), mirrored here so the ramp and the accent are
 *  checked against each other in one place. Deliberately NOT an alias of an existing token:
 *  `--node-runtime` sits ΔE00 ≈ 3 from `--prof-heat-2` — one JND — so the accent would have been
 *  indistinguishable from the scale's own second bucket.
 *  These two are written BY HAND in `tokens.css` (next to the other `--dbg-*` accents), not by the
 *  generator: it prints the six-value ramp only. */
export const PROFILE_ACCENT = { light: '#8b2f88', dark: '#e79ad0' } as const;
/** Badge foreground on the 16% `tone-profile` tint (light needs its own darker value for AA). */
export const PROFILE_BADGE_FG = { light: '#7a2977', dark: PROFILE_ACCENT.dark } as const;

/**
 * `prefers-contrast: more` collapses COLOUR to three levels on purpose. The dynamic range is
 * capped by the background (21.0:1 on #ffffff, 18.9:1 on #0c1119), so a six-step ladder with the
 * floor raised to 4.5:1 separates WORSE under CVD than the base ramp. Width stays six-stepped and
 * carries the bucket by itself. Pairs are (0,1) (2,3) (4,5).
 */
export const HEAT_LIGHT_CONTRAST: readonly string[] = ['#756a00', '#756a00', '#791b73', '#791b73', '#040947', '#040947'];
export const HEAT_DARK_CONTRAST: readonly string[] = ['#a3881d', '#a3881d', '#f59ec2', '#f59ec2', '#fae0ff', '#fae0ff'];

// ── Ruler marks ────────────────────────────────────────────────────────────────────────────────

/** One overview-ruler mark: the hottest line of a pixel slot, plus the slot's line span. */
export interface RulerSlot { bucket: HeatBucket; firstLine: number; lastLine: number; line: number }

/**
 * Merge per-line marks into pixel slots — Monaco does NOT merge ruler decorations, it re-renders
 * every group of the document on each frame, so 41k marks would be 41k rendered rects. Same
 * algorithm the find widget uses on its own marks: `slot = floor(line * rulerPx / lineCount / 3)`,
 * one decoration per slot (the hottest line in it), `zIndex = bucket` so hot groups draw last.
 *
 * `lines` must be ascending; `bucketAt` returns the line's bucket (`NO_BUCKET` = not painted).
 * A 3-device-px slot caps the result at ~rulerPx/3 marks — ~270 on an 800px ruler — regardless of
 * document size; the 400 ceiling the plan asserts is unreachable by construction.
 */
export function mergeRulerSlots(
  lines: ArrayLike<number>,
  bucketAt: (line: number) => number,
  lineCount: number,
  rulerPx: number,
): RulerSlot[] {
  const out: RulerSlot[] = [];
  if (lineCount <= 0 || rulerPx <= 0) return out;
  const slots = Math.max(1, Math.floor(rulerPx / 3));
  const linesPerSlot = lineCount / slots;
  let cur: RulerSlot | undefined;
  let curSlot = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const bucket = bucketAt(line);
    if (bucket === NO_BUCKET) continue;
    const slot = Math.min(slots - 1, Math.floor(line / linesPerSlot));
    if (slot !== curSlot) {
      cur = {
        bucket: bucket as HeatBucket,
        firstLine: Math.floor(slot * linesPerSlot),
        lastLine: Math.min(lineCount - 1, Math.ceil((slot + 1) * linesPerSlot) - 1),
        line,
      };
      curSlot = slot;
      out.push(cur);
    } else if (cur && bucket > cur.bucket) {
      cur.bucket = bucket as HeatBucket;
      cur.line = line;
    }
  }
  return out;
}

// ── Text on the lane decoration ────────────────────────────────────────────────────────────────

/** Per-line numbers both lane texts read. Self sums over the line's nodes, subtree takes the max
 *  (nested subtrees would double-count) — the same rule the hover card states in words. */
export interface LaneStats {
  line: number;
  self: number;
  subtree: number;
  hits: number;
  /** Nodes STARTING on this line, hottest first — the hover card lists up to eight. */
  nodes: { termId: number; kind?: string; label?: string; self: number; hits: number }[];
}

/** Denominators + labels the card needs beyond the line itself. */
export interface LaneContext {
  metric: ProfileMetric;
  /** `totals.cpuSpent` / `memSpent` for the active metric — the `% run` denominator. */
  total: number;
  /** `totals.cpuLimit` / `memLimit`; `null` when the session declared no limit → `% limit` is `—`. */
  limit?: number | null;
  /** `'last_term'` adds the v1-attribution sentence; `'apply_site'` replaces it. */
  attribution: 'last_term' | 'apply_site';
}

/** The lane's NATIVE tooltip (`linesDecorationsTooltip`): plain text, one line — content hover
 *  does not fire over the margin, so without this the bar itself would be mute. `approx` prefixes
 *  the `≈` the dimmed bar stands for: transparency is a visual channel, and no information in this
 *  UI is carried by a visual channel alone. */
export function laneTooltip(s: LaneStats, ctx: LaneContext, approx = false): string {
  const stats = `${fmtPct(s.self, ctx.total)} self · ${fmtPct(s.subtree, ctx.total)} tree · ${fmtInt(s.hits)}×`;
  return approx ? `≈ ${stats}` : stats;
}

const MAX_HOVER_NODES = 8;

/**
 * The hover card's markdown. Fixed order self-then-subtree regardless of `profileScope`: both
 * rows live on the lane decoration, which is not rebuilt when the scope toggles, so a
 * scope-dependent order would silently go stale.
 *
 * `approx` is the `≈` marker (the dimmed bar): what the transparency means, in words.
 */
export function laneHoverMarkdown(s: LaneStats, ctx: LaneContext, approx = false): string {
  const unit = ctx.metric === 'cpu' ? 'CPU' : 'MEM';
  const head = s.nodes[0];
  const title = s.nodes.length === 1 && head
    ? `**Term node ${head.termId}** · ${nodeLabel(head)} · ${fmtLn(s.line)}`
    : `**${fmtLn(s.line)}** — ${s.nodes.length} term nodes · line self = sum`;

  const lines = [
    approx ? `≈ ${title}` : title,
    '',
    `| ${unit} | | % run | % limit |`,
    '|---|--:|--:|--:|',
    `| self | ${fmtInt(s.self)} | ${fmtPct(s.self, ctx.total)} | ${fmtPct(s.self, ctx.limit)} |`,
    `| subtree | ${fmtInt(s.subtree)} | ${fmtPct(s.subtree, ctx.total)} | ${fmtPct(s.subtree, ctx.limit)} |`,
    `| hits | ${fmtInt(s.hits)} | | |`,
  ];

  if (s.nodes.length > 1) {
    lines.push('');
    for (const n of s.nodes.slice(0, MAX_HOVER_NODES)) {
      lines.push(`- \`#${n.termId}\` ${nodeLabel(n)} — ${fmtInt(n.self)} (${fmtPct(n.self, ctx.total)})`);
    }
    if (s.nodes.length > MAX_HOVER_NODES) lines.push(`- + ${fmtInt(s.nodes.length - MAX_HOVER_NODES)} more nodes on this line`);
  }

  lines.push('');
  // Named every time, because it is THE thing users get wrong about a UPLC profile.
  if (s.hits > 1) {
    lines.push(`${fmtInt(s.hits)} hits = one node re-evaluated — UPLC has no functions; recursion is a fixpoint combinator.`);
  }
  lines.push(ctx.attribution === 'last_term'
    ? 'Return-step cost is charged to the last node that executed (v1 attribution).'
    : 'Return-step cost is charged to the apply site it returns into.');
  // The dimmed bar, spelled out. Only reachable under `last_term`, so it always follows the
  // sentence it qualifies.
  if (approx) lines.push(`**≈** — most of this line's ${unit} is that Return-step cost, so it may belong to the apply site rather than here.`);
  return lines.join('\n');
}

/** `Builtin unConstrData` / `Var xs` / bare `Apply` — kind plus whatever the serializer labelled it
 *  with. Never derived from the line's TEXT: that differs between the two renderers. */
export function nodeLabel(n: { kind?: string; label?: string }): string {
  if (!n.kind) return n.label ?? 'Term';
  return n.label ? `${n.kind} ${n.label}` : n.kind;
}
