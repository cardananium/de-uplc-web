import { useEffect, useRef, useState } from 'react';
import { termIndexFor } from '@de-uplc/core';
import { useStore, revealTermInEditor } from '../../store';
import { useSettings } from '../../platform/settings';
import { useTabsStore } from '../../editor/tabs-store';
import { Codicon } from '../../components/Codicon';
import { BudgetMetric } from '../MainControlsPanel';
import { EmptyState } from '../../components/EmptyState';
import { fmtInt, fmtRate, fmtSecs } from '../../profile/format';

// The states a profile can be in, as UI: no profile yet, one running, one that stopped early, and
// one taken against a term that has since been re-rendered. They live in one file because the
// SIDEBAR and the REPORT TAB show the same states and must not word them differently — a partial
// profile labelled `⚠ Limit` in one place and "incomplete" in the other is two bugs waiting.
//
// The wording here is the product copy: change it in one place, not per surface.

export type Outcome = 'Done' | 'Error' | 'Limit' | 'Cancelled' | 'Failed' | 'Stale' | 'Running';

const PILL: Record<Outcome, { label: string; icon: string; tone: string; spin?: boolean }> = {
  Done: { label: 'Done', icon: 'pass', tone: 'tone-done' },
  Error: { label: 'Error', icon: 'error', tone: 'tone-error' },
  Failed: { label: 'Failed', icon: 'error', tone: 'tone-error' },
  Limit: { label: 'Limit', icon: 'warning', tone: 'tone-warn' },
  Cancelled: { label: 'Cancelled', icon: 'circle-slash', tone: 'tone-warn' },
  Stale: { label: 'Stale', icon: 'warning', tone: 'tone-warn' },
  Running: { label: 'Profiling…', icon: 'loading', tone: 'tone-profile', spin: true },
};

/**
 * Which badge the current store state deserves. `Stale` outranks the run's own outcome: the numbers
 * are still true of the run that produced them, but they no longer point at lines, and that is the
 * thing the user has to know first.
 */
export function useOutcome(): Outcome | undefined {
  const status = useStore((s) => s.profileStatus);
  const outcome = useStore((s) => s.profileOutcome);
  const profile = useStore((s) => s.profile);
  const stale = useStore((s) => s.profileStale);
  if (status === 'running') return 'Running';
  if (status === 'error') return 'Failed';
  if (!profile) return undefined;
  if (stale) return 'Stale';
  return outcome ?? 'Done';
}

/** The outcome badge. Text + icon, so it never depends on the tone alone. */
export function OutcomePill({ outcome }: { outcome: Outcome }) {
  const p = PILL[outcome];
  return (
    <span className={`prof-pill ${p.tone}`}>
      <Codicon name={p.icon} spin={p.spin} />
      {p.label}
    </span>
  );
}

/** `1,284,955 steps · 0.9 s · exact, not sampled` — the line beside the pill. */
export function RunMeta() {
  const run = useStore((s) => s.profileRun);
  const profile = useStore((s) => s.profile);
  const steps = profile?.totals.steps ?? run?.steps ?? 0;
  return (
    <>
      <span>{fmtInt(steps)} steps</span>
      <span>·</span>
      <span>{fmtSecs(run?.elapsedMs ?? 0)}</span>
      <span>·</span>
      <span
        className="prof-hint"
        title={'Exact instruction accounting, not sampling — totals reproduce to the unit on a re-run.'
          // The approximation caveat belongs to v1 only: there a return step is charged to the last
          // term that ran, which lands a builtin's cost on its argument. Under apply-site attribution
          // it is charged to the application it returns into, so the sentence would be a lie.
          + (profile?.totals.attribution === 'last_term'
            ? ' Per-node attribution of return steps is approximate while v1 attribution is in effect.'
            : '')}
      >
        exact, not sampled
      </span>
    </>
  );
}

/** Sentence + actions for an outcome that is not a plain `Done`. Rendered under the pill in the
 *  sidebar and as a banner over the tables in the report — the same words in both. */
export function OutcomeNote({ outcome }: { outcome: Outcome }) {
  const run = useStore((s) => s.profileRun);
  const error = useStore((s) => s.profileError);
  const profile = useStore((s) => s.profile);
  const runnerLive = useStore((s) => s.profileRunnerLive);
  const stale = useStore((s) => s.profileStale);
  const locations = useStore((s) => s.termLocations);
  const view = useStore((s) => s.termView);
  const runProfile = useStore((s) => s.runProfile);
  const continueProfile = useStore((s) => s.continueProfile);
  const clearProfile = useStore((s) => s.clearProfile);
  const maxSteps = useSettings((s) => s.profileMaxSteps);

  const failure = profile?.totals.outcome.outcome_type === 'Error' ? profile.totals.outcome : undefined;
  const failureLine = failure && locations.length > 0
    ? termIndexFor(locations, view).lineOfTerm(failure.termId)
    : undefined;

  switch (outcome) {
    case 'Done':
      return null;
    case 'Failed':
      return (
        <div className="prof-note">
          The profiler could not finish: {error ?? 'unknown error'}. The debug session is unaffected.
          <div className="prof-actions">
            <button className="text-button" onClick={() => void runProfile()}>
              <Codicon name="refresh" /> Try again
            </button>
          </div>
        </div>
      );
    case 'Cancelled':
      return (
        <div className="prof-note">
          Partial — cancelled at {fmtInt(run?.steps ?? 0)} steps of an unknown total. Percentages are of what ran.
          <div className="prof-actions">
            {runnerLive ? (
              <button className="text-button" onClick={() => void continueProfile()}>
                <Codicon name="debug-continue" /> Continue profiling
              </button>
            ) : (
              <button className="text-button" onClick={() => void runProfile()}>
                <Codicon name="refresh" /> Re-profile
              </button>
            )}
          </div>
        </div>
      );
    case 'Limit':
      return (
        <div className="prof-note">
          {/* The cap the run actually stopped at, not the setting: a Continue lifts the ceiling to
              `steps so far + profileMaxSteps`, so after one Continue the setting says 50 M about a
              run that reached 100 M. */}
          Stopped at the {fmtInt(run?.cap ?? maxSteps)}-step cap — raise it in Settings ▸ Profiler.
          <div className="prof-actions">
            {runnerLive ? (
              <button className="text-button" onClick={() => void continueProfile()}>
                <Codicon name="debug-continue" /> Continue profiling
              </button>
            ) : (
              <button className="text-button" onClick={() => void runProfile()}>
                <Codicon name="refresh" /> Re-profile
              </button>
            )}
          </div>
        </div>
      );
    case 'Error':
      return (
        <div className="prof-note">
          The script failed before finishing — these numbers cover the part that ran.
          {failure && <div className="prof-meta" style={{ marginTop: 4 }}>{failure.message}</div>}
          {failure && (
            <div className="prof-actions">
              <button
                className="text-button"
                disabled={stale || failureLine === undefined}
                onClick={() => revealTermInEditor(failure.termId)}
              >
                <Codicon name="go-to-file" /> Go to failure
                {failureLine !== undefined && <> · Ln {fmtInt(failureLine + 1)}</>}
              </button>
            </div>
          )}
        </div>
      );
    case 'Stale':
      return (
        <div className="app-error app-error--script" role="status" style={{ marginBottom: 0 }}>
          <Codicon name="warning" />
          <span className="app-error-msg" style={{ fontFamily: 'inherit', fontSize: 12 }}>
            This profile was taken on a different term — node ids no longer map to lines. The numbers
            are still valid for the run that produced them.
          </span>
          <div className="prof-actions" style={{ marginTop: 0 }}>
            <button className="text-button" onClick={() => void runProfile()}>
              <Codicon name="refresh" /> Re-profile
            </button>
            <button className="text-button" onClick={clearProfile}>
              <Codicon name="close" /> Discard
            </button>
          </div>
        </div>
      );
    case 'Running':
      return null;
  }
}

/** No profile yet: what the button will do, and the promise that it will not disturb the session. */
export function ProfileEmpty({ compact }: { compact?: boolean }) {
  const runProfile = useStore((s) => s.runProfile);
  const status = useStore((s) => s.status);
  const locked = useStore((s) => s.locked);
  const busy = status === 'running' || locked;
  return (
    <EmptyState
      compact={compact}
      icon={compact ? undefined : 'flame'}
      title="Profile this script"
      hint={'Runs the whole program to completion in the engine and maps its ExUnits back to the '
        + 'nodes of this term. Your debug session, breakpoints and current step are untouched.'}
      action={(
        <button className="text-button" disabled={busy} onClick={() => void runProfile()}>
          <Codicon name="flame" /> Profile this script
        </button>
      )}
    />
  );
}

/**
 * A run in flight. There is no honest "% done" — the total step count is unknowable in advance — so
 * the bar is cpu-so-far against the DECLARED cpu limit and says exactly that. Past the limit the
 * fill clamps and the caption changes rather than the bar lying about its range.
 */
export function ProfileProgress() {
  const run = useRunSnapshot();
  const metric = useStore((s) => s.profileMetric);
  const cancelProfile = useStore((s) => s.cancelProfile);
  const profile = useStore((s) => s.profile);
  const budget = useStore((s) => s.budget);

  const spent = metric === 'cpu' ? run?.cpu ?? 0 : run?.mem ?? 0;
  // Before the first report lands, the declared limit is only known from the live session's budget —
  // which is `null` for a session that declared none, so it answers the question by itself (no
  // scriptOnly gate: a parts link carrying `exUnits` declares a limit and has no redeemer).
  const limit = (metric === 'cpu'
    ? profile?.totals.cpuLimit ?? budget?.exUnitsAvailable
    : profile?.totals.memLimit ?? budget?.memoryUnitsAvailable) ?? null;
  const raw = limit && limit > 0 ? (spent / limit) * 100 : undefined;
  const over = raw !== undefined && raw > 100;
  const pct = raw === undefined ? 0 : Math.min(100, raw);

  return (
    <div className="prof-progress">
      {raw !== undefined && (
        <>
          <div className="budget-meter-row">
            <div className="meter">
              <div className={`meter-fill is-live${over ? ' danger' : ''}`} style={{ width: pct <= 0 ? '0' : `max(2px, ${pct}%)` }} />
            </div>
            <span className="meter-pct">{Math.round(raw)}%</span>
          </div>
          <div className="prof-meta" style={{ marginTop: 4 }}>
            {over
              ? `over the declared ${metric === 'cpu' ? 'CPU' : 'memory'} limit · ${Math.round(raw)}%`
              : `of the declared ${metric === 'cpu' ? 'CPU' : 'memory'} limit`}
          </div>
        </>
      )}
      <div className="prof-meta" style={{ marginTop: 4 }}>
        {fmtInt(run?.steps ?? 0)} steps · {fmtRate(run?.steps ?? 0, run?.elapsedMs ?? 0)} · {fmtSecs(run?.elapsedMs ?? 0)}
      </div>
      <div className="prof-meta">
        {metric === 'cpu' ? 'cpu' : 'mem'} so far {fmtInt(spent)}
      </div>
      <div className="prof-actions">
        <button className="text-button" onClick={cancelProfile}>
          <Codicon name="debug-stop" /> Cancel
        </button>
        <span className="prof-meta">Partial results are kept.</span>
      </div>
    </div>
  );
}

/**
 * The counters the panel prints. Normally that is the live value at ~8 updates/s — moving integers
 * ARE the liveness indicator here, there is no separate animation. Under `prefers-reduced-motion`
 * they tick about once a second instead: digits changing eight times a second are motion, whatever
 * the CSS says. The last tick before the run ends may be dropped; the outcome line, not this one,
 * carries the final numbers.
 */
function useRunSnapshot() {
  const run = useStore((s) => s.profileRun);
  const [slow, setSlow] = useState(run);
  const last = useRef(0);
  const reduced = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (!reduced) return;
    const now = Date.now();
    if (now - last.current < 1000) return;
    last.current = now;
    setSlow(run);
  }, [run, reduced]);

  return reduced ? slow : run;
}

/**
 * The screen-reader channel — a SEPARATE element from the visible counters, rewritten at most once
 * every 5 s plus once at every state change. The visible numbers tick ~8×/s on purpose (moving
 * integers are the liveness indicator); handing that to a screen reader would be a queue of
 * hundreds of announcements.
 */
export function ProfileLiveRegion() {
  const run = useStore((s) => s.profileRun);
  const status = useStore((s) => s.profileStatus);
  const outcome = useStore((s) => s.profileOutcome);
  const [msg, setMsg] = useState('');
  const last = useRef('');
  const bucket = status === 'running' ? Math.floor((run?.elapsedMs ?? 0) / 5000) : -1;
  const key = `${status}:${outcome ?? ''}:${bucket}`;

  useEffect(() => {
    if (key === last.current) return;
    last.current = key;
    const r = useStore.getState().profileRun;
    setMsg(status === 'running'
      ? `Profiling: ${fmtInt(r?.steps ?? 0)} steps, ${fmtSecs(r?.elapsedMs ?? 0)}`
      : status === 'ready' && outcome
        ? `Profile ${outcome.toLowerCase()}: ${fmtInt(r?.steps ?? 0)} steps`
        : '');
  }, [key, status, outcome]);

  return (
    <span role="status" aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
      {msg}
    </span>
  );
}

/** `[ ⌗ Open profile report ]` — the sidebar's way into the tab, and the only control the panel
 *  keeps when the layout collapses it. */
export function OpenReportButton() {
  const openProfileTab = useTabsStore((s) => s.openProfileTab);
  return (
    <button className="text-button" title="Open profile report" aria-label="Open profile report" onClick={openProfileTab}>
      <Codicon name="graph" /> Open profile report
    </button>
  );
}

/**
 * A profile budget row. With a declared limit it IS `BudgetMetric` — the live run's widget, reused
 * verbatim so spent/limit/overspend read the same everywhere — with the profiler's own labels
 * (`CPU` / `Memory`, not `Ex units`), because the metric toggle above it says CPU.
 *
 * Without a declared limit (`cpu_limit === null` — a plain UPLC program, or a parts link that
 * carried no `exUnits`) there is no meter at all: the only alternative denominator is
 * `ExBudget::default()`, a reference budget that has nothing to do with this script.
 */
export function ProfileBudget({ label, spent, limit }: { label: string; spent: number; limit?: number | null }) {
  if (typeof limit === 'number') return <BudgetMetric label={label} spent={spent} limit={limit} loading={false} />;
  return (
    <div className="budget-metric">
      <div className="budget-cols">
        <span className="bt-label">{label}</span>
        <span className="bt-spent">{fmtInt(spent)}</span>
        <span title="This session declares no ExUnits, so there is no limit to measure against.">—</span>
      </div>
    </div>
  );
}
