import { describe, it, expect } from 'vitest';
import { decideBusy, BUSY_DELAY_MS, BUSY_MIN_VISIBLE_MS, type BusyMemo } from './busy-timing';

// The anti-flash rules are the whole reason this indicator is bearable, and they are invisible in a
// screenshot: the bugs they prevent are a spinner that blinks for 80 ms and one that strobes across
// two quick loads. Both are timing, and timing is exactly what a pure clock-injected function can
// be pinned down on.

/**
 * Replay a busy/idle timeline through the state machine, honouring the `recheckIn` deadlines the
 * decision asks for — i.e. exactly what `useBusyIndicator`'s setTimeout does, minus React.
 * `at` is the ms offset of each event; the result is every VISIBILITY CHANGE, as [ms, visible].
 */
function replay(events: { at: number; busy: boolean }[], until: number): [number, boolean][] {
  const changes: [number, boolean][] = [];
  let memo: BusyMemo = {};
  let visible = false;
  let busy = false;
  let due: number | undefined;

  // Step the clock over the union of event times and pending deadlines.
  for (let t = 0; t <= until; t++) {
    const ev = events.find((e) => e.at === t);
    const wake = due !== undefined && t >= due;
    if (!ev && !wake) continue;
    if (ev) busy = ev.busy;
    const d = decideBusy(memo, busy, t);
    memo = d.memo;
    due = d.recheckIn === undefined ? undefined : t + d.recheckIn;
    if (d.visible !== visible) { visible = d.visible; changes.push([t, visible]); }
  }
  return changes;
}

describe('decideBusy — the delay', () => {
  it('never shows anything for work that finishes inside the delay', () => {
    expect(replay([{ at: 0, busy: true }, { at: 80, busy: false }], 2000)).toEqual([]);
  });

  it('shows nothing at the very last moment before the delay elapses', () => {
    expect(replay([{ at: 0, busy: true }, { at: BUSY_DELAY_MS - 1, busy: false }], 2000)).toEqual([]);
  });

  it('shows exactly at the delay for work that is still running', () => {
    const changes = replay([{ at: 0, busy: true }, { at: 5000, busy: false }], 6000);
    expect(changes[0]).toEqual([BUSY_DELAY_MS, true]);
  });

  it('asks to be re-checked when the remaining delay elapses, not sooner', () => {
    const d = decideBusy({ busyAt: 1000 }, true, 1120);
    expect(d).toEqual({ visible: false, memo: { busyAt: 1000 }, recheckIn: BUSY_DELAY_MS - 120 });
  });

  it('starts the clock on the first busy evaluation (an empty memo adopts `now`)', () => {
    const d = decideBusy({}, true, 7000);
    expect(d.memo.busyAt).toBe(7000);
    expect(d.visible).toBe(false);
  });
});

describe('decideBusy — the minimum hold', () => {
  it('keeps a just-shown indicator up for the minimum after the work ends', () => {
    // Work ends 10 ms after the spinner appeared: without the hold that is a 10 ms flash.
    const changes = replay([{ at: 0, busy: true }, { at: BUSY_DELAY_MS + 10, busy: false }], 3000);
    expect(changes).toEqual([[BUSY_DELAY_MS, true], [BUSY_DELAY_MS + BUSY_MIN_VISIBLE_MS, false]]);
  });

  it('hides immediately when the work outlasted the minimum anyway', () => {
    const end = BUSY_DELAY_MS + BUSY_MIN_VISIBLE_MS + 500;
    const changes = replay([{ at: 0, busy: true }, { at: end, busy: false }], end + 2000);
    expect(changes).toEqual([[BUSY_DELAY_MS, true], [end, false]]);
  });

  it('asks to be re-checked when the remaining hold elapses', () => {
    const d = decideBusy({ shownAt: 1000 }, false, 1100);
    expect(d).toEqual({ visible: true, memo: { shownAt: 1000 }, recheckIn: BUSY_MIN_VISIBLE_MS - 100 });
  });

  it('forgets everything once hidden, so the next load starts a fresh delay', () => {
    expect(decideBusy({ busyAt: 1, shownAt: 2 }, false, 9999)).toEqual({ visible: false, memo: {} });
  });
});

describe('decideBusy — no strobing', () => {
  it('stays continuously up across two loads separated by less than the minimum', () => {
    const changes = replay(
      [
        { at: 0, busy: true },
        { at: 300, busy: false },   // shown at 200, so the hold runs to 600
        { at: 400, busy: true },    // second load starts inside the hold
        { at: 450, busy: false },
      ],
      3000,
    );
    // One show, one hide — never a hide/show pair in between.
    expect(changes).toEqual([[BUSY_DELAY_MS, true], [BUSY_DELAY_MS + BUSY_MIN_VISIBLE_MS, false]]);
  });

  it('does not restart the hold clock when a second load lands inside it', () => {
    // Visible since 200; a load running at 500 must not push the hide past 600 by itself.
    const d = decideBusy({ shownAt: 200 }, true, 500);
    expect(d).toEqual({ visible: true, memo: { busyAt: 500, shownAt: 200 } });
    expect(decideBusy(d.memo, false, 500).recheckIn).toBe(BUSY_MIN_VISIBLE_MS - 300);
  });

  it('applies the full delay again once the indicator has actually gone away', () => {
    const changes = replay(
      [{ at: 0, busy: true }, { at: 5000, busy: false }, { at: 6000, busy: true }, { at: 6100, busy: false }],
      9000,
    );
    // The second load is 100 ms — under the delay — so it adds no third/fourth change.
    expect(changes).toEqual([[BUSY_DELAY_MS, true], [5000, false]]);
  });
});

describe('decideBusy — constants', () => {
  it('is silent below the delay and readable above it', () => {
    expect(BUSY_DELAY_MS).toBeGreaterThan(0);
    expect(BUSY_MIN_VISIBLE_MS).toBeGreaterThan(BUSY_DELAY_MS);
  });

  it('honours injected thresholds (nothing is baked into the algorithm)', () => {
    expect(decideBusy({ busyAt: 0 }, true, 50, 40, 100).visible).toBe(true);
    expect(decideBusy({ busyAt: 0 }, true, 30, 40, 100)).toEqual({ visible: false, memo: { busyAt: 0 }, recheckIn: 10 });
    expect(decideBusy({ shownAt: 0 }, false, 60, 40, 100).visible).toBe(true);
    expect(decideBusy({ shownAt: 0 }, false, 100, 40, 100).visible).toBe(false);
  });
});
