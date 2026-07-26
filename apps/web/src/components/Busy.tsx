import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Codicon } from './Codicon';
import { decideBusy, type BusyMemo } from './busy-timing';

/**
 * The loading-indicator vocabulary, in one module: a delayed spinner, the live phase text next to
 * it, and the deep-link overlay. Every load in the app speaks it — the timing rules live in
 * `busy-timing.ts` and are applied here and nowhere else.
 */

/**
 * Delayed + minimum-held visibility for a piece of in-flight work. THE single application of the
 * anti-flash rules: call sites pass a raw "is it busy" boolean and render whatever this returns.
 */
export function useBusyIndicator(busy: boolean, opts?: { delayMs?: number }): boolean {
  const memo = useRef<BusyMemo>({});
  const delayMs = opts?.delayMs;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Re-evaluate now, and again whenever the decision says a deadline is pending (the delay is
    // still running, or the minimum hold has not elapsed). No interval, no polling.
    // `performance.now()` and not `Date.now()`: these are pure durations, and a wall-clock that
    // steps backwards mid-load would push the next re-check that far into the future.
    const tick = () => {
      const d = decideBusy(memo.current, busy, performance.now(), delayMs);
      memo.current = d.memo;
      setVisible(d.visible);
      if (d.recheckIn !== undefined) timer = setTimeout(tick, d.recheckIn);
    };
    tick();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [busy, delayMs]);

  return visible;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Live `prefers-reduced-motion`. Live, not read-once: the preference is toggled at runtime. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION).matches);
  useEffect(() => {
    const mq = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduced(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

/**
 * The spinner glyph. Purely decorative — `Codicon` marks it `aria-hidden`, and the phase text
 * beside it is what a screen reader actually hears.
 *
 * Under `prefers-reduced-motion` the rotating codicon is swapped for a STATIC ellipsis rather than
 * merely frozen: a spin arrow stopped mid-turn looks like a bug, whereas "…" says "working" with
 * nothing moving. (tokens.css also hard-stops `.codicon-modifier-spin` under the same query, which
 * covers the spinners this component doesn't own.)
 */
export function BusySpinner() {
  const reduced = usePrefersReducedMotion();
  return reduced ? <Codicon name="ellipsis" /> : <Codicon name="loading" spin />;
}

/**
 * The live phase line ("Fetching 8 UTXOs…"), read straight from the store so every call site shows
 * the same step.
 *
 * Mounted whether or not it has something to say: an `aria-live` region that is inserted together
 * with its first text is announced inconsistently, while one that already exists reliably announces
 * each change. Empty renders as no child nodes at all, so `:empty` collapses it and a row never
 * reserves space for a message it isn't showing.
 */
export function BusyPhase({ show }: { show: boolean }) {
  const phase = useStore((s) => s.loadingPhase);
  // Latched, like the overlay's label: the store clears the phase the moment the work ends, but the
  // indicator is still held for its minimum-visible tail — and a spinner with the text yanked out
  // from under it is worse than one that finishes its sentence. Also covers the case where the work
  // blocks the main thread and the phase is gone by the time React can paint anything at all.
  const last = useRef<string | undefined>(undefined);
  if (phase) last.current = phase;
  if (!show) last.current = undefined;
  return (
    <span className="busy-phase" role="status" aria-live="polite">
      {show ? last.current ?? null : null}
    </span>
  );
}

/**
 * "THIS control started the current load", so the spinner appears in the button that was pressed
 * instead of in all of them at once. The store's `loading` is global by design — Load sample, Open
 * file, drag-and-drop and Load transaction all call the same action — so the source is knowable
 * only at the call site. Wrap the action in `run` and the returned flag follows it, failures
 * included.
 */
export function useBusyControl(): readonly [boolean, (fn: () => Promise<unknown>) => Promise<void>] {
  const [busy, setBusy] = useState(false);
  // A dead engine worker never settles its Comlink promise — no reject path, and `terminate()`
  // settles nothing — so the `finally` below may simply never run and the spinner would turn
  // forever. `crashEpoch` is the signal that does arrive: `onFatalWorker` bumps it, and a flag
  // armed under the previous engine stops counting.
  const crashEpoch = useStore((s) => s.crashEpoch);
  const armed = useRef(crashEpoch);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    armed.current = useStore.getState().crashEpoch;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }, []);
  return [busy && crashEpoch === armed.current, run] as const;
}

/** Which of the three shared kinds a deep link is opening. */
export type LaunchKind = 'transaction' | 'program' | 'parts';

// Named in the app's own vocabulary (the load toasts say "Transaction loaded" / "UPLC program
// loaded" / "Script + context loaded"), because "Loading…" over a blank workspace tells a
// first-time visitor neither what is coming nor that they are in the right place.
const LAUNCH_LABEL: Record<LaunchKind, string> = {
  transaction: 'Opening shared transaction…',
  program: 'Opening shared program…',
  parts: 'Opening shared script…',
};

/**
 * The deep-link affordance. A shared link is the one path reached with NO click: the user lands on
 * an empty shell while the WASM engine boots, Koios is queried and a 40k-line term is serialised,
 * and without this the app looks broken rather than busy. So the workspace itself carries the
 * indicator — dead centre, where a first-time visitor is already looking.
 *
 * `kind` goes null when the load ends; the label is latched so the card keeps saying what it was
 * opening through the minimum-visible tail instead of blanking out mid-fade.
 */
export function LaunchOverlay({ kind }: { kind: LaunchKind | null }) {
  // Same crash guard as `useBusyControl`, and it matters more here: this overlay is a scrim over the
  // whole workspace, so a stuck one would sit on top of the crash banner and its recovery button.
  const crashEpoch = useStore((s) => s.crashEpoch);
  const armed = useRef(crashEpoch);
  const live = kind !== null && crashEpoch === armed.current;
  // NO delay here, unlike every other indicator. Two reasons, and the second is decisive:
  //  · there is nothing to flash over — a shared link opens into an empty workspace, so the card is
  //    the only thing on screen either way;
  //  · the delay could not be honoured anyway. Opening a link parses a large script and serialises
  //    its term on the main thread, which blocks for seconds; a 200 ms timer set just before that
  //    fires only once the work is over. Measured on a 15k-node link: the card never appeared at
  //    all — 3.1 s warm, 5.9 s cold, and the user watched an empty page for all of it.
  // The minimum-visible hold still applies, so a warm, tiny link cannot strobe it.
  const visible = useBusyIndicator(live, { delayMs: 0 });
  const phase = useStore((s) => s.loadingPhase);
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (kind) { armed.current = useStore.getState().crashEpoch; setLabel(LAUNCH_LABEL[kind]); }
  }, [kind]);

  // The live region stays MOUNTED and is emptied instead of unmounted: a region inserted together
  // with its first text is announced inconsistently, and this is the path with the least other
  // context for a screen-reader user. `hidden` keeps it out of the visual and the a11y tree.
  const off = !visible || !label;
  // It covers `.app-content` only, so the titlebar (theme, settings) stays reachable while a
  // shared link opens — and the workspace under it has nothing to click yet anyway.
  return (
    <div className="launch-overlay" hidden={off}>
      <div className="launch-card">
        {off ? null : <BusySpinner />}
        {/* ONE live region for the card rather than a `BusyPhase` nested inside a second one:
            what a screen reader should hear here is the whole sentence — what is opening, then
            which step of it is running. */}
        <div className="launch-text" role="status" aria-live="polite">
          <div className="launch-title">{off ? null : label}</div>
          <div className="busy-phase">{off ? null : phase ?? null}</div>
        </div>
      </div>
    </div>
  );
}
