import type { DebuggerTypes } from '@de-uplc/core';
import { useStore } from '../../store';
import { fmtInt, fmtPct } from '../../profile/format';
import { metricWord } from '../../profile/derive';
import { builtinTotals } from '../../profile/builtin-groups';

/**
 * The ten step rows: the nine machine step kinds plus `StartUp`, which is not a step at all — it is
 * the flat charge `ManualMachine::new` makes before anything runs, and it belongs to no node. It is
 * separated by a rule rather than listed among the nine, because summing the column with it in
 * silently double-counts the run's origin.
 *
 * Low information density by design: this is the table you open to check an invariant, not
 * to find a hot spot, so it lives inside a collapsed `<details class="dc-group">`.
 */
export function StepKindsTable({ profile, open }: { profile: DebuggerTypes.Profile; open?: boolean }) {
  const metric = useStore((s) => s.profileMetric);
  const unit = metricWord(metric);
  const spent = metric === 'cpu' ? profile.totals.cpuSpent : profile.totals.memSpent;
  const value = (s: DebuggerTypes.ProfileStep) => (metric === 'cpu' ? s.cpu : s.mem);

  const machine = profile.steps.filter((s) => s.kind !== 'StartUp');
  const startup = profile.steps.find((s) => s.kind === 'StartUp');
  const builtins = builtinTotals(profile.builtins);
  const builtinCost = metric === 'cpu' ? builtins.cpu : builtins.mem;
  // SUMMED, never `spent - builtinCost`: this row is the accounting invariant made visible (the acceptance tests),
  // and derived by subtraction it would print `= 100%` however far the Rust accounting had drifted.
  // `StartUp` is inside the steps side — it is a real charge, just not a machine step.
  const machineCost = profile.steps.reduce((a, s) => a + value(s), 0);
  const accounted = machineCost + builtinCost;
  // `100%` is a CLAIM this line has to be able to withdraw. Both sides are counted independently
  // (Σ `steps[]` against Σ `builtins[]`), so when they do not add up to `*_spent` — a drift in the
  // Rust accounting — it prints the share they DO add up to instead of a 100% it cannot back.
  const exact = accounted === spent;

  return (
    <details className="dc-group" open={open} style={{ margin: '10px 14px' }}>
      <summary>
        <div className="dc-group-head">
          <span className="dc-group-title">Step kinds ({profile.steps.length})</span>
          <span className={`dc-group-desc ${exact ? 'muted' : 'prof-warn'}`}
            title={`${fmtInt(machineCost)} over ${profile.steps.length} step kinds + ${fmtInt(builtinCost)} over ${profile.builtins.length} builtins, against ${fmtInt(spent)} ${metric} spent.`}>
            machine {fmtPct(machineCost, spent)} + builtins {fmtPct(builtinCost, spent)} ={' '}
            {exact ? '100%' : `${fmtPct(accounted, spent)} — accounting drift`}
          </span>
        </div>
      </summary>
      <div className="dc-group-body">
        <table className="prof-table">
          <thead>
            <tr>
              <th scope="col" className="prof-th">Kind</th>
              <th scope="col" className="prof-th">Count</th>
              <th scope="col" className="prof-th">{unit}</th>
              <th scope="col" className="prof-th">% run</th>
              <th scope="col" className="prof-th prof-drop">{metric === 'cpu' ? 'Mem' : 'CPU'}</th>
            </tr>
          </thead>
          <tbody>
            {machine.map((s) => (
              <tr key={s.kind}>
                <td>{s.kind}</td>
                <td className="prof-num">{fmtInt(s.count)}</td>
                <td className="prof-num">{fmtInt(value(s))}</td>
                <td className="prof-num">{fmtPct(value(s), spent)}</td>
                <td className="prof-num prof-sub-col prof-drop">{fmtInt(metric === 'cpu' ? s.mem : s.cpu)}</td>
              </tr>
            ))}
            {startup && (
              <tr className="prof-startup-row" title="A flat charge in ManualMachine::new — not a machine step, and attributed to no node.">
                <td>{startup.kind}</td>
                <td className="prof-num">{fmtInt(startup.count)}</td>
                <td className="prof-num">{fmtInt(value(startup))}</td>
                <td className="prof-num">{fmtPct(value(startup), spent)}</td>
                <td className="prof-num prof-sub-col prof-drop">{fmtInt(metric === 'cpu' ? startup.mem : startup.cpu)}</td>
              </tr>
            )}
            <tr className="prof-total-row" title={`${fmtInt(machineCost)} steps + ${fmtInt(builtinCost)} builtins against ${fmtInt(spent)} spent.`}>
              <td>Machine {fmtPct(machineCost, spent)} + builtins {fmtPct(builtinCost, spent)}</td>
              <td className="prof-num">—</td>
              <td className="prof-num">{fmtInt(accounted)}</td>
              <td className="prof-num">{fmtPct(accounted, spent)}</td>
              <td className="prof-num prof-drop">—</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  );
}
