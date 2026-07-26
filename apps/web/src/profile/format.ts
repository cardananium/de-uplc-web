// Number formatting for every profiler surface. One module so a cost never renders two ways:
// the sidebar's top-5, the report's columns, the inlay text and the hover card all read from here.
//
// The rule the spec fixes: budget columns show FULL grouped numbers — abbreviating an
// ExUnits figure hides exactly the digits a user compares against the declared limit. `fmtCompact`
// exists for chips and hovers, where the value is a headline and not something to be checked.

/** Full grouped integer, `en-US` — the budget columns' format (`117,002,990`). */
export function fmtInt(n?: number): string {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '0';
}

/**
 * A share of a whole, as a percentage with two decimals (`10.26%`). Returns the em dash — not
 * `0.00%` — when the denominator is missing or zero: `% limit` has no value when the session
 * declared no limit (`cpu_limit === null`), and a printed `0.00%` there would be a lie.
 */
export function fmtPct(part: number, whole?: number | null, digits = 2): string {
  if (whole === undefined || whole === null || !Number.isFinite(whole) || whole === 0) return '—';
  if (!Number.isFinite(part)) return '—';
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

/** Abbreviated magnitude for chips and hovers ONLY (`12.0 M`, `4.1 k`). Never a budget column. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)} G`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} k`;
  return fmtInt(n);
}

/**
 * Cost per hit (`240`) — the column that separates "rewrite the loop" from "replace the builtin".
 * Zero hits has no per-hit cost at all, so it prints as the em dash rather than as `0` or `∞`.
 *
 * `unit` (`cpu/hit`) is appended only when there IS a number; every caller that wants a suffix goes
 * through it rather than re-deciding what "no per-hit cost" looks like — the em dash lives here and
 * nowhere else (the table's `CPU/hit` column, the detail panel and the builtins' `CPU/call` all
 * print the same thing for the same reason).
 */
export function fmtPerHit(cost: number, hits: number, unit?: string): string {
  if (!hits || !Number.isFinite(hits) || !Number.isFinite(cost)) return '—';
  return unit ? `${fmtInt(cost / hits)} ${unit}` : fmtInt(cost / hits);
}

/** Throughput while a profile runs (`1.4 M steps/s`). Under a millisecond there is no rate yet. */
export function fmtRate(steps: number, elapsedMs: number): string {
  if (!Number.isFinite(steps) || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return '—';
  return `${fmtCompact((steps * 1000) / elapsedMs)} steps/s`;
}

/**
 * A 0-based model line as the human-readable `Ln 22,406`. THE second place (with
 * `new monaco.Range(ln + 1, …)`) that turns a 0-based line into a 1-based one — everything else
 * in the profiler keeps lines 0-based, exactly as `TermLocation` stores them.
 */
export function fmtLn(line0: number): string {
  return `Ln ${fmtInt(line0 + 1)}`;
}

/**
 * Elapsed wall time of a run: `38 ms` below a second, `0.9 s` below a minute, `2 m 04 s` above.
 *
 * The millisecond band is not a nicety. Most profiles finish in tens of milliseconds, and one
 * decimal of a second prints those as `0.0 s` — a counter that never started rather than a run that
 * was fast. Every surface that shows elapsed time (the sidebar meta line, the report header, the
 * in-flight progress card and the screen-reader announcement) reads it from here, so they cannot
 * disagree about what a fast run looks like.
 */
export function fmtSecs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  // Rounded BEFORE the band is chosen, so 999.7 ms is `1.0 s` and never `1000 ms`.
  const whole = Math.round(ms);
  if (whole < 1000) return `${whole} ms`;
  if (whole < 60_000) return `${(whole / 1000).toFixed(1)} s`;
  // The rounding happens on the whole duration for the same reason: 119.6 s is `2 m 00 s`, never
  // `1 m 60 s`. Seconds are zero-padded so a ticking counter does not change width every second.
  const secs = Math.round(whole / 1000);
  return `${Math.floor(secs / 60)} m ${String(secs % 60).padStart(2, '0')} s`;
}
