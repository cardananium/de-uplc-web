/**
 * The anti-flash timing behind EVERY loading indicator in the app — one implementation, consumed
 * only by `useBusyIndicator` (Busy.tsx). Pure and clock-injected, so it is unit-testable without a
 * DOM and so no call site can grow its own slightly-different variant.
 *
 * Two rules, both about not making the screen twitch:
 *  - work that finishes quickly must show NOTHING (`BUSY_DELAY_MS`). Most local loads land in well
 *    under a second, and a spinner that appears and vanishes inside ~80 ms reads as a rendering
 *    glitch, not as progress — it is strictly worse than no indicator at all.
 *  - an indicator that DID appear stays up for a short minimum (`BUSY_MIN_VISIBLE_MS`), or a load
 *    that finishes just past the delay produces exactly the flicker the delay exists to prevent.
 *
 * The two constants are picked against human perception rather than against any particular load:
 * ~200 ms is the low end of the range where a wait starts being *felt* (below it the UI still
 * reads as instantaneous, so an indicator would be answering a question nobody asked), and ~400 ms
 * is about the shortest a small glyph + a phrase can be on screen and still be READ. Together they
 * mean a load is either silent or legible, never a blink.
 */

/** How long work must be in flight before the indicator appears at all. */
export const BUSY_DELAY_MS = 200;
/** How long the indicator stays up once shown, even if the work has already finished. */
export const BUSY_MIN_VISIBLE_MS = 400;

/** Source length past which a script load shows the busy indicator immediately. */
export const BUSY_HEAVY_SOURCE_CHARS = 8192;

/**
 * What the indicator remembers between evaluations. Both fields are timestamps on the caller's
 * clock — a MONOTONIC ms source (`useBusyIndicator` passes `performance.now()`); `decideBusy`
 * never reads a clock itself, which is what makes it testable.
 */
export interface BusyMemo {
  /** When the current busy episode began; undefined while nothing is in flight. */
  busyAt?: number;
  /** When the indicator became visible; undefined while it is hidden. */
  shownAt?: number;
}

export interface BusyDecision {
  /** Should the indicator be on screen right now? */
  visible: boolean;
  /** The memo to carry into the next evaluation (the caller stores it verbatim). */
  memo: BusyMemo;
  /** Re-evaluate after this many ms; undefined when the state is stable and nothing is pending. */
  recheckIn?: number;
}

/**
 * One transition of the state machine: given what we remembered, whether work is in flight and the
 * current time, decide what the indicator shows and when to look again.
 *
 * Note what happens across back-to-back loads: when work stops, `busyAt` is dropped but `shownAt`
 * is kept until the minimum elapses, so a second load starting inside that tail finds the
 * indicator already visible and keeps it visible — continuously, with no gap and no restarted
 * clock. That is the case the naive "hide, then delay again" version strobes on.
 */
export function decideBusy(
  memo: BusyMemo,
  busy: boolean,
  now: number,
  delayMs: number = BUSY_DELAY_MS,
  minVisibleMs: number = BUSY_MIN_VISIBLE_MS,
): BusyDecision {
  if (busy) {
    const busyAt = memo.busyAt ?? now;
    // Already up: nothing to schedule — it stays up for as long as the work runs.
    if (memo.shownAt !== undefined) return { visible: true, memo: { busyAt, shownAt: memo.shownAt } };
    const waited = now - busyAt;
    if (waited >= delayMs) return { visible: true, memo: { busyAt, shownAt: now } };
    return { visible: false, memo: { busyAt }, recheckIn: delayMs - waited };
  }
  // Idle. Work that ended before the delay elapsed leaves no trace at all — that is the whole point.
  if (memo.shownAt === undefined) return { visible: false, memo: {} };
  const held = now - memo.shownAt;
  if (held >= minVisibleMs) return { visible: false, memo: {} };
  return { visible: true, memo: { shownAt: memo.shownAt }, recheckIn: minVisibleMs - held };
}
