import { useState, type CSSProperties } from 'react';
import { useStore } from '../store';
import { Codicon } from '../components/Codicon';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BusyPhase, BusySpinner, useBusyControl, useBusyIndicator } from '../components/Busy';
import {
  buttonStates, redeemerOptions, isConcreteRedeemer,
} from './button-states';
// One number formatter for the whole app: the profiler prints the same ExUnits figures next to
// these ones, and two `toLocaleString` call sites are two chances to disagree.
import { fmtInt as fmt } from '../profile/format';

export function MainControlsPanel() {
  // Per-field selectors (not `useStore()`) so this panel re-renders only when its own inputs
  // change, not on every inspector pull / treeGeneration bump. Actions are stable refs.
  const status = useStore((s) => s.status);
  const locked = useStore((s) => s.locked);
  const scriptOnly = useStore((s) => s.scriptOnly);
  const scriptHasContext = useStore((s) => s.scriptHasContext);
  const redeemers = useStore((s) => s.redeemers);
  const currentRedeemer = useStore((s) => s.currentRedeemer);
  const scriptHash = useStore((s) => s.scriptHash);
  const scriptPurpose = useStore((s) => s.scriptPurpose);
  const plutusLang = useStore((s) => s.plutusLang);
  const selectRedeemer = useStore((s) => s.selectRedeemer);
  const showContext = useStore((s) => s.showContext);
  const bs = buttonStates(status);
  const [pendingRedeemer, setPendingRedeemer] = useState<string | null>(null);
  // Choosing a redeemer builds a session and re-serialises the term — on a big script that is a
  // multi-second wait behind a control that used to do nothing visible but grey itself out.
  const [selectBusy, runSelect] = useBusyControl();
  const selectShown = useBusyIndicator(selectBusy);

  const onRedeemerChange = (next: string) => {
    if (next === currentRedeemer) return;
    if (isConcreteRedeemer(currentRedeemer)) {
      setPendingRedeemer(next); // changing an active session -> confirm
    } else {
      void runSelect(() => selectRedeemer(next)); // first pick from "Choose redeemer" -> no confirm
    }
  };

  return (
    <div className="panel">
      <div className="panel-title">Session</div>

      {!scriptOnly && redeemers.length === 0 && (
        <div className="muted" style={{ marginTop: 8, fontSize: 12.5 }}>Load a transaction or a plain UPLC script.</div>
      )}

      {/* ── tx mode: pick a redeemer, then show the selected script ── */}
      {!scriptOnly && redeemers.length > 0 && (
        <div className="mc-section">
          <div className="mc-row">
            <label>redeemer:&nbsp;
              <select value={currentRedeemer ?? ''} disabled={locked || status === 'running' || status === 'pause'}
                onChange={(e) => onRedeemerChange(e.target.value)}>
                {redeemerOptions(redeemers).map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            {/* No button was pressed here, so the spinner sits beside the control that WAS used. */}
            {selectShown && <BusySpinner />}
            <BusyPhase show={selectShown} />
          </div>
          <dl className="mc-kv">
            <dt>Script hash</dt>
            <dd className="mono break" title={scriptHash}>{scriptHash ?? '—'}</dd>
            <dt>Language</dt>
            <dd>{plutusLang ?? '—'}</dd>
            <dt>Purpose</dt>
            <dd>{scriptPurpose ?? '—'}</dd>
          </dl>
        </div>
      )}

      {/* ── scriptOnly mode: a plain UPLC program or a script + supplied args (a "parts" link) ──
          Both identify the script when they can: the hash needs only the script bytes + language
          (so hex input has one, UPLC text has none), and the purpose comes from the supplied
          context or from the link's own `purpose` label. `—` means the session names none. */}
      {scriptOnly && (
        <div className="mc-section">
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
            {scriptHasContext ? 'UPLC script + supplied context — no transaction.' : 'Plain UPLC program — no transaction context.'}
          </div>
          <dl className="mc-kv">
            <dt>Script hash</dt>
            <dd className="mono break" title={scriptHash}>{scriptHash ?? '—'}</dd>
            <dt>Language</dt>
            <dd>{plutusLang ?? '—'}</dd>
            <dt>Purpose</dt>
            <dd>{scriptPurpose ?? '—'}</dd>
          </dl>
        </div>
      )}

      {/* ── View: show the supplied / on-chain script context as a Data tree ── */}
      {((scriptOnly && scriptHasContext) ||
        (!scriptOnly && redeemers.length > 0 && (bs.showContext || isConcreteRedeemer(currentRedeemer)))) && (
        <>
          <div className="panel-divider" />
          <div className="mc-section">
            <div className="mc-row">
              <button className="text-button" disabled={!bs.showContext || locked} onClick={() => void showContext()}
                title={scriptOnly ? 'Show the supplied script context, decoded as a Data tree' : undefined}>
                <Codicon name="symbol-namespace" /> Show context
              </button>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={pendingRedeemer !== null}
        title="Change redeemer?"
        message="The current debugging session will be stopped and reset."
        onConfirm={() => { const next = pendingRedeemer; setPendingRedeemer(null); if (next) void runSelect(() => selectRedeemer(next)); }}
        onCancel={() => setPendingRedeemer(null)}
      />
    </div>
  );
}

/**
 * One budget metric: Spent / Limit (full grouped numbers) + a usage meter.
 *
 * Exported because the profiler reuses it VERBATIM (with `label="CPU"` / `"Memory"` instead of
 * `"Ex units"`): a profile's spent/limit/overspend is the same quantity as a live run's, and the
 * two must not grow two visual languages.
 * `limit` is the engine's `*Available` field — the DECLARED ExUnits (a constant cap: a tx
 * redeemer's, or the ones a parts deep-link carried), NOT a remaining balance. So that value IS the
 * limit; usage = spent / limit and the alarm state is spent >= limit. `null` means nothing declared
 * any: there is no denominator, so the row prints `—` and draws no meter at all.
 *
 * The fill is neutral while there is headroom and warms toward the limit (`--meter-t`, see
 * `.meter-fill`), so the two cards of the report header speak one language instead of painting a
 * nearly-exhausted CPU budget in a decorative green next to a Memory budget in alarm orange.
 */
export function BudgetMetric({ label, spent, limit, loading }: {
  label: string; spent?: number; limit?: number | null; loading: boolean;
}) {
  const has = typeof spent === 'number' && typeof limit === 'number';
  // AT the limit is the same alarm as OVER it: 100.00% means the run has no headroom left and one
  // more step fails on chain, which is the single most important thing this widget can say — and
  // with a `>` test it looked exactly like a comfortable 87%. The `limit > 0` guard keeps a session
  // that declares a zero budget (not a real limit) from painting every reading red.
  const over = has && (limit! > 0 ? spent! >= limit! : spent! > limit!);
  const rawPct = has && limit! > 0 ? (spent! / limit!) * 100 : 0; // true ratio (can exceed 100 on overspend)
  const pct = Math.min(100, rawPct);                              // clamped for the bar fill only
  const pctLabel = loading || !has ? '—' : `${rawPct.toFixed(2)}%`;
  // Give a tiny but real fill a minimum visible width so a 0.4% run isn't an empty bar.
  const fillWidth = loading || pct <= 0 ? '0' : `max(2px, ${pct}%)`;
  // A reading with no declared limit gets no meter — an empty bar next to `—` implies a scale that
  // does not exist. While loading (or before the first reading) the bar stays, so the panel doesn't
  // reflow every time a run starts.
  const noLimit = !loading && typeof spent === 'number' && typeof limit !== 'number';
  // How warm the fill is: neutral through the first half of the budget, then a straight ramp to
  // the warm end at the limit (`.danger` takes over at/over it). The knee is HALF the declared
  // budget because that is the point where "there is room" stops being the honest reading — and
  // tying the colour to the fill LENGTH means the warm end only ever paints a long bar.
  const warmth = loading || !has ? 0 : Math.min(1, Math.max(0, (rawPct - 50) / 50));
  // Which of the two the tone means, in words — the colour is never the only carrier.
  const alarm = !over ? undefined
    : spent! > limit!
      ? 'Over the declared limit — this script would fail on chain.'
      : 'At the declared limit exactly — no headroom left.';
  return (
    <div className={`budget-metric${over ? ' budget-overspend' : ''}`} title={alarm}>
      <div className="budget-cols">
        <span className="bt-label">{label}</span>
        <span className="bt-spent">{loading ? '—' : fmt(spent)}</span>
        <span title={noLimit ? 'This session declares no ExUnits, so there is no limit to measure against.' : undefined}>
          {loading || noLimit ? '—' : fmt(limit ?? undefined)}
        </span>
      </div>
      {!noLimit && (
        <div className="budget-meter-row">
          <div className="meter">
            <div
              className={`meter-fill${over ? ' danger' : ''}`}
              style={{ width: fillWidth, '--meter-t': warmth } as CSSProperties}
            />
          </div>
          <span className="meter-pct">{pctLabel}</span>
        </div>
      )}
    </div>
  );
}

/**
 * Budget panel: ex-units / memory usage as Spent · Limit (full numbers) with a usage meter
 * each. The engine's `*Available` is the session's DECLARED ExUnits (the constant cap), so it
 * IS the Limit — and it is `null` when nothing declared any, which prints as `—` with no meter.
 * Shown while running/paused and after a run completes; hidden otherwise.
 */
export function BudgetPanel() {
  const status = useStore((s) => s.status);
  const finalStatus = useStore((s) => s.finalStatus);
  const budget = useStore((s) => s.budget);
  const currentTermId = useStore((s) => s.currentTermId);
  const bs = buttonStates(status);

  if (!bs.budgetVisible && !finalStatus) return null;
  const loading = bs.budgetLoading; // running -> show "—"

  return (
    <div className="panel">
      <div className="panel-title">Budget</div>
      <div className="budget">
        <div className="budget-cols budget-head">
          <span />
          <span>Spent</span>
          <span>Limit</span>
        </div>
        <BudgetMetric label="Ex units" spent={budget?.exUnitsSpent} limit={budget?.exUnitsAvailable} loading={loading} />
        <BudgetMetric label="Memory" spent={budget?.memoryUnitsSpent} limit={budget?.memoryUnitsAvailable} loading={loading} />
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        Current term id: {currentTermId === undefined || currentTermId < 0 ? '—' : currentTermId}
      </div>
    </div>
  );
}
