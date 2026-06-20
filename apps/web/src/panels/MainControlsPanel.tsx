import { useState } from 'react';
import { useStore } from '../store';
import { Codicon } from '../components/Codicon';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  buttonStates, redeemerOptions, isConcreteRedeemer,
} from './button-states';

const fmt = (n?: number) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');

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
  const plutusLang = useStore((s) => s.plutusLang);
  const selectRedeemer = useStore((s) => s.selectRedeemer);
  const showContext = useStore((s) => s.showContext);
  const bs = buttonStates(status);
  const [pendingRedeemer, setPendingRedeemer] = useState<string | null>(null);

  const onRedeemerChange = (next: string) => {
    if (next === currentRedeemer) return;
    if (isConcreteRedeemer(currentRedeemer)) {
      setPendingRedeemer(next); // changing an active session -> confirm
    } else {
      void selectRedeemer(next); // first pick from "Choose redeemer" -> no confirm
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
          </div>
          <dl className="mc-kv">
            <dt>Script hash</dt>
            <dd className="mono break" title={scriptHash}>{scriptHash ?? '—'}</dd>
            <dt>Language</dt>
            <dd>{plutusLang ?? '—'}</dd>
          </dl>
        </div>
      )}

      {/* ── scriptOnly mode: a plain UPLC program, no redeemer / no on-chain script hash ── */}
      {scriptOnly && (
        <div className="mc-section">
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Plain UPLC program — no transaction context.</div>
          <dl className="mc-kv">
            <dt>Script hash</dt>
            <dd className="mono break">{scriptHash ?? '—'}</dd>
            <dt>Language</dt>
            <dd>{plutusLang ?? '—'}</dd>
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
        onConfirm={() => { const next = pendingRedeemer; setPendingRedeemer(null); if (next) void selectRedeemer(next); }}
        onCancel={() => setPendingRedeemer(null)}
      />
    </div>
  );
}

/**
 * One budget metric: Spent / Limit (full grouped numbers) + a usage meter.
 * `limit` is the engine's `*Available` field — the redeemer's declared ExUnits (a constant
 * cap = `real_budget`), NOT a remaining balance. So that value IS the limit; usage = spent / limit
 * and overspend is spent > limit.
 */
function BudgetMetric({ label, spent, limit, loading }: {
  label: string; spent?: number; limit?: number; loading: boolean;
}) {
  const has = typeof spent === 'number' && typeof limit === 'number';
  const over = has && spent! > limit!;
  const rawPct = has && limit! > 0 ? (spent! / limit!) * 100 : 0; // true ratio (can exceed 100 on overspend)
  const pct = Math.min(100, rawPct);                              // clamped for the bar fill only
  const pctLabel = loading || !has ? '—' : `${rawPct.toFixed(2)}%`;
  // Give a tiny but real fill a minimum visible width so a 0.4% run isn't an empty bar.
  const fillWidth = loading || pct <= 0 ? '0' : `max(2px, ${pct}%)`;
  return (
    <div className={`budget-metric${over ? ' budget-overspend' : ''}`}>
      <div className="budget-cols">
        <span className="bt-label">{label}</span>
        <span className="bt-spent">{loading ? '—' : fmt(spent)}</span>
        <span>{loading ? '—' : fmt(limit)}</span>
      </div>
      <div className="budget-meter-row">
        <div className="meter"><div className={`meter-fill${over ? ' danger' : ''}`} style={{ width: fillWidth }} /></div>
        <span className="meter-pct">{pctLabel}</span>
      </div>
    </div>
  );
}

/**
 * Budget panel: ex-units / memory usage as Spent · Limit (full numbers) with a usage meter
 * each. The engine's `*Available` is the redeemer's declared ExUnits (the constant cap), so it
 * IS the Limit. Shown while running/paused and after a run completes; hidden otherwise.
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
