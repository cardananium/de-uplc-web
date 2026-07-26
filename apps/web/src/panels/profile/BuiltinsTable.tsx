import { Fragment, useMemo, useState } from 'react';
import type { DebuggerTypes } from '@de-uplc/core';
import { useStore } from '../../store';
import { Codicon } from '../../components/Codicon';
import { EmptyState } from '../../components/EmptyState';
import { fmtInt, fmtPct, fmtPerHit } from '../../profile/format';
import { metricWord } from '../../profile/derive';
import { builtinTotals, groupBuiltins } from '../../profile/builtin-groups';

/**
 * Builtins, grouped. 87 flat rows are a glossary, not a list, so the table opens on six buckets and
 * expands into them; `Flat` is one click away for when you already know the name you are looking
 * for. The grouping is a naming heuristic and the footer says so — it is not a claim about what the
 * engine did.
 */
export function BuiltinsTable({ profile }: { profile: DebuggerTypes.Profile }) {
  const metric = useStore((s) => s.profileMetric);
  const [flat, setFlat] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupBuiltins(profile.builtins, metric), [profile.builtins, metric]);
  const all = useMemo(() => builtinTotals(profile.builtins), [profile.builtins]);

  const unit = metricWord(metric);
  const spent = metric === 'cpu' ? profile.totals.cpuSpent : profile.totals.memSpent;
  const cost = (b: DebuggerTypes.ProfileBuiltin) => (metric === 'cpu' ? b.cpu : b.mem);
  const rows = useMemo(
    () => [...profile.builtins].sort((a, b) => cost(b) - cost(a) || a.name.localeCompare(b.name)),
    [profile.builtins, metric],
  );
  // Summed over `steps[]`, not `spent - builtins`: the row below claims an invariant, and a value
  // obtained by subtraction satisfies it by construction.
  const machine = profile.steps.reduce((a, s) => a + (metric === 'cpu' ? s.cpu : s.mem), 0);

  if (profile.builtins.length === 0) {
    return <EmptyState icon="symbol-method" title="No builtin was applied in this run." />;
  }

  return (
    <>
      <div className="prof-controls" style={{ padding: '8px 14px 0' }}>
        <div className="seg" role="tablist" aria-label="Builtin grouping">
          <button role="tab" aria-selected={!flat} className={`seg-item${!flat ? ' is-active' : ''}`} onClick={() => setFlat(false)}>Grouped</button>
          <button role="tab" aria-selected={flat} className={`seg-item${flat ? ' is-active' : ''}`} onClick={() => setFlat(true)}>Flat</button>
        </div>
        <span className="prof-meta">Grouping is a naming heuristic over the 87 builtin names.</span>
      </div>

      <table className="prof-table">
        <thead>
          <tr>
            <th scope="col" className="prof-th">{flat ? 'Builtin' : 'Builtin / group'}</th>
            <th scope="col" className="prof-th">Calls</th>
            <th scope="col" className="prof-th">{unit}</th>
            <th scope="col" className="prof-th">% run</th>
            <th scope="col" className="prof-th prof-drop">{metric === 'cpu' ? 'Mem' : 'CPU'}</th>
            <th scope="col" className="prof-th">{unit}/call</th>
          </tr>
        </thead>
        <tbody>
          {flat
            ? rows.map((b) => <BuiltinRow key={b.name} builtin={b} metric={metric} spent={spent} />)
            : groups.map((g) => (
              <Fragment key={g.id}>
                <tr className="prof-group-row">
                  <td>
                    <button className="prof-twisty" aria-expanded={!!open[g.id]} onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}>
                      <Codicon name={open[g.id] ? 'chevron-down' : 'chevron-right'} />
                      {g.title}
                    </button>
                  </td>
                  <td className="prof-num">{fmtInt(g.calls)}</td>
                  <td className="prof-num">{fmtInt(metric === 'cpu' ? g.cpu : g.mem)}</td>
                  <td className="prof-num">{fmtPct(metric === 'cpu' ? g.cpu : g.mem, spent)}</td>
                  <td className="prof-num prof-sub-col prof-drop">{fmtInt(metric === 'cpu' ? g.mem : g.cpu)}</td>
                  {/* A group has no per-call cost: averaging across different builtins is a number
                      with no referent. */}
                  <td className="prof-num">—</td>
                </tr>
                {open[g.id] && g.rows.map((b) => <BuiltinRow key={b.name} builtin={b} metric={metric} spent={spent} child />)}
              </Fragment>
            ))}
          <tr className="prof-total-row">
            <td>Builtins</td>
            <td className="prof-num">{fmtInt(all.calls)}</td>
            <td className="prof-num">{fmtInt(metric === 'cpu' ? all.cpu : all.mem)}</td>
            <td className="prof-num">{fmtPct(metric === 'cpu' ? all.cpu : all.mem, spent)}</td>
            <td className="prof-num prof-drop">{fmtInt(metric === 'cpu' ? all.mem : all.cpu)}</td>
            <td className="prof-num">—</td>
          </tr>
          {/* The accounting invariant, made visible: machine steps + builtins = the whole run. Both sides
              are counted independently, so a drift in the Rust accounting shows up here as two
              percentages that do not add to 100. */}
          <tr className="prof-total-row" title={`Σ steps[] against ${fmtInt(spent)} ${metric} spent.`}>
            <td>Machine steps</td>
            <td className="prof-num">—</td>
            <td className="prof-num">{fmtInt(machine)}</td>
            <td className="prof-num">{fmtPct(machine, spent)}</td>
            <td className="prof-num prof-drop">—</td>
            <td className="prof-num">—</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

function BuiltinRow({ builtin, metric, spent, child }: {
  builtin: DebuggerTypes.ProfileBuiltin;
  metric: 'cpu' | 'mem';
  spent: number;
  child?: boolean;
}) {
  const value = metric === 'cpu' ? builtin.cpu : builtin.mem;
  const other = metric === 'cpu' ? builtin.mem : builtin.cpu;
  return (
    <tr className={child ? 'prof-child' : undefined}>
      <td>{builtin.name}</td>
      <td className="prof-num">{fmtInt(builtin.calls)}</td>
      <td className="prof-num">{fmtInt(value)}</td>
      <td className="prof-num">{fmtPct(value, spent)}</td>
      <td className="prof-num prof-sub-col prof-drop">{fmtInt(other)}</td>
      <td className="prof-num">{fmtPerHit(value, builtin.calls)}</td>
    </tr>
  );
}
