import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { termIndexFor } from '@de-uplc/core';
import { useStore } from '../../store';
import { useSettings } from '../../platform/settings';
import { setProfileFilterFocus } from '../../editor/tabs-store';
import { Codicon } from '../../components/Codicon';
import { fmtInt, fmtPct } from '../../profile/format';
import {
  TAIL_PAGE, defaultSortKey, deriveReport, fmtThreshold, metricUnit, metricWord,
  type SortDir, type SortKey,
} from '../../profile/derive';
import { dataDecoding } from '../../profile/builtin-groups';
import { BuiltinsTable } from './BuiltinsTable';
import { NodeDetail } from './NodeDetail';
import {
  OutcomeNote, OutcomePill, ProfileBudget, ProfileEmpty, ProfileProgress, RunMeta, useOutcome,
} from './ProfileRunState';
import { StepKindsTable } from './StepKindsTable';
import { TermsTable, TermsTail } from './TermsTable';
import '../../profile/profile.css';

type Pane = 'terms' | 'builtins' | 'steps';

/**
 * The report tab. A header that cannot be scrolled away from the numbers it qualifies, one pair of
 * switches (metric × scope) that drives every profiler surface at once, and three tables.
 *
 * Widths are measured on the TAB, not the viewport: the same tab is 1400px wide with the sidebar
 * collapsed and 700px wide beside it, and it is the table that has to decide which denominators it
 * can still afford to print.
 */
export function ProfileTab() {
  const profile = useStore((s) => s.profile);
  const index = useStore((s) => s.profileIndex);
  const status = useStore((s) => s.profileStatus);
  const metric = useStore((s) => s.profileMetric);
  const setProfileMetric = useStore((s) => s.setProfileMetric);
  const scope = useStore((s) => s.profileScope);
  const setProfileScope = useStore((s) => s.setProfileScope);
  const locations = useStore((s) => s.termLocations);
  const view = useStore((s) => s.termView);
  const fileName = useStore((s) => s.fileName);
  const redeemer = useStore((s) => s.currentRedeemer);
  const runProfile = useStore((s) => s.runProfile);
  const clearProfile = useStore((s) => s.clearProfile);
  const settingMinShare = useSettings((s) => s.profileMinShare);
  const outcome = useOutcome();

  const [pane, setPane] = useState<Pane>('terms');
  const [sortKey, setSortKey] = useState<SortKey>(defaultSortKey(scope));
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [text, setText] = useState('');
  const [tailShown, setTailShown] = useState(0);
  // Filter state is LOCAL to the tab: the auto-raised threshold and a removed chip are things this
  // view is doing, not settings, and `deuplc.profile.minShare` is never written from here.
  const [threshold, setThreshold] = useState(true);
  const [autoRaise, setAutoRaise] = useState(true);
  const [hideNeverExecuted, setHideNeverExecuted] = useState(true);
  const [narrow, setNarrow] = useState({ narrow: false, stacked: false });
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // The tab bar's Find action targets this box instead of Monaco's find widget while the report is
  // the active tab (`EditorTabs`), so the report registers it while mounted.
  useEffect(() => {
    setProfileFilterFocus(() => filterRef.current?.focus());
    return () => setProfileFilterFocus(undefined);
  }, []);

  // `.is-narrow` at < 1000px of TAB width, `.is-stacked` at < 760px — a media query would measure
  // the viewport, which is not what changes when the sidebar collapses.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setNarrow((prev) => {
        const next = { narrow: w < 1000, stacked: w < 760 };
        return prev.narrow === next.narrow && prev.stacked === next.stacked ? prev : next;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The scope switch re-sorts the table and nothing else.
  useEffect(() => { setSortKey(defaultSortKey(scope)); setSortDir('desc'); }, [scope]);
  useEffect(() => { setTailShown(0); }, [text, metric, scope, threshold, hideNeverExecuted]);

  const termIndex = useMemo(
    () => (locations.length > 0 ? termIndexFor(locations, view) : undefined),
    [locations, view],
  );
  const derived = useMemo(
    () => (index
      ? deriveReport(index, termIndex, {
        scope, sortKey, sortDir, text, tailShown, hideNeverExecuted, autoRaise,
        minSharePct: threshold ? settingMinShare : 0,
      })
      : undefined),
    [index, termIndex, scope, sortKey, sortDir, text, tailShown, hideNeverExecuted, autoRaise, threshold, settingMinShare],
  );
  const decode = useMemo(() => (profile ? dataDecoding(profile.builtins, metric) : undefined), [profile, metric]);

  // While a profile runs the tab is the progress card, even when an older report is still in the
  // store: the tables would be the PREVIOUS run's, under a pill that says Profiling.
  if (status === 'running') {
    return (
      <div className="prof-tab" ref={rootRef}>
        <div className="prof-head">
          <div className="prof-head-row"><OutcomePill outcome="Running" /></div>
          <ProfileProgress />
        </div>
      </div>
    );
  }
  if (!profile || !index || !derived) {
    return (
      <div className="prof-tab" ref={rootRef}>
        {status === 'error' && outcome ? <OutcomeNote outcome={outcome} /> : <ProfileEmpty />}
      </div>
    );
  }

  const totals = profile.totals;
  const spent = metric === 'cpu' ? totals.cpuSpent : totals.memSpent;
  const unit = metricWord(metric);
  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    else { setSortKey(key); setSortDir('desc'); }
  };

  return (
    <div className={`prof-tab${narrow.narrow ? ' is-narrow' : ''}${narrow.stacked ? ' is-stacked' : ''}`} ref={rootRef}>
      <div className="prof-head">
        <div className="prof-head-row">
          {outcome && <OutcomePill outcome={outcome} />}
          <span className="prof-title">
            {fileName && <b>{fileName}</b>}
            {fileName && <span>·</span>}
            {redeemer && <span>{redeemer}</span>}
            {redeemer && <span>·</span>}
            <RunMeta />
          </span>
          <span className="prof-spacer" />
          <button className="icon-button" title="Re-profile" aria-label="Re-profile" onClick={() => void runProfile()}>
            <Codicon name="refresh" />
          </button>
          <button className="icon-button" title="Clear profile" aria-label="Clear profile" onClick={clearProfile}>
            <Codicon name="close" />
          </button>
        </div>

        {outcome && outcome !== 'Done' && <OutcomeNote outcome={outcome} />}

        <div className="prof-budgets">
          <div>
            <div className="budget-cols budget-head"><span /><span>Spent</span><span>Limit</span></div>
            <ProfileBudget label="CPU" spent={totals.cpuSpent} limit={totals.cpuLimit} />
          </div>
          <div>
            <div className="budget-cols budget-head"><span /><span>Spent</span><span>Limit</span></div>
            <ProfileBudget label="Memory" spent={totals.memSpent} limit={totals.memLimit} />
          </div>
        </div>

        {decode && (
          <div className="prof-headline">
            <Codicon name="arrow-small-right" />
            <span title="the *Data builtins; the profiler cannot tell which Data value was decoded.">
              <b>DATA DECODING</b> is {fmtInt(metric === 'cpu' ? decode.cpu : decode.mem)} {metricUnit(metric)} ={' '}
              {fmtPct(metric === 'cpu' ? decode.cpu : decode.mem, spent)} of the run
              {' '}({fmtPct(decode.shareOfBuiltins, 1)} of all builtin cost, {fmtInt(decode.calls)} calls
              across {fmtInt(decode.builtins)} builtins).
            </span>
          </div>
        )}

        {/* Always visible, never behind a <details>: it is the single most common wrong assumption
            about a UPLC profile, and a folded explanation is one nobody reads. */}
        <div className="prof-note">
          Costs are per NODE of this UPLC term, not per Aiken function — UPLC has none. Recursion is a
          fixpoint combinator, so a loop is ONE node with many hits, not repeated rows.{' '}
          {totals.attribution === 'last_term'
            ? 'Return-step cost is charged to the last node that executed (v1 attribution). Rows dominated by it are marked ≈.'
            : 'Return-step cost is charged to the apply site it returns into.'}
        </div>

        <div className="prof-controls">
          <div className="prof-group">
            <span>Metric</span>
            <div className="seg" role="tablist" aria-label="Metric">
              <button role="tab" aria-selected={metric === 'cpu'} className={`seg-item${metric === 'cpu' ? ' is-active' : ''}`} onClick={() => setProfileMetric('cpu')}>CPU</button>
              <button role="tab" aria-selected={metric === 'mem'} className={`seg-item${metric === 'mem' ? ' is-active' : ''}`} onClick={() => setProfileMetric('mem')}>Mem</button>
            </div>
          </div>
          <div className="prof-group">
            <span>Cost</span>
            <div className="seg" role="tablist" aria-label="Cost scope">
              <button role="tab" aria-selected={scope === 'self'} className={`seg-item${scope === 'self' ? ' is-active' : ''}`} onClick={() => setProfileScope('self')}>Self</button>
              <button role="tab" aria-selected={scope === 'subtree'} className={`seg-item${scope === 'subtree' ? ' is-active' : ''}`} onClick={() => setProfileScope('subtree')}>Subtree</button>
            </div>
          </div>
          <span className="prof-spacer" style={{ flex: '1 1 auto' }} />
          <div className="seg" role="tablist" aria-label="Report table">
            <button role="tab" aria-selected={pane === 'terms'} className={`seg-item${pane === 'terms' ? ' is-active' : ''}`} onClick={() => setPane('terms')}>Terms</button>
            <button role="tab" aria-selected={pane === 'builtins'} className={`seg-item${pane === 'builtins' ? ' is-active' : ''}`} onClick={() => setPane('builtins')}>Builtins</button>
            <button role="tab" aria-selected={pane === 'steps'} className={`seg-item${pane === 'steps' ? ' is-active' : ''}`} onClick={() => setPane('steps')}>Step kinds</button>
          </div>
        </div>

        {pane === 'terms' && (
          <div className="prof-chips">
            {/* Every cap this view applies is a chip, and every chip removes — so a table that came
                back short is always one visible click away from being complete. */}
            {/* One chip, two removals: while the threshold is RAISED, ⊗ drops the raise back to the
                configured value; after that it drops the threshold altogether. The persisted
                `deuplc.profile.minShare` is never written from here — the raise is a state of this
                view, and it says so. */}
            <Chip
              on={threshold}
              auto={derived.autoRaised}
              onToggle={() => (derived.autoRaised ? setAutoRaise(false) : setThreshold((t) => !t))}
              label={derived.autoRaised
                ? <>≥ <b>{fmtThreshold(derived.effectiveMinSharePct)}</b> (raised automatically from {fmtThreshold(settingMinShare)})</>
                : <>≥ <b>{fmtThreshold(settingMinShare)}</b></>}
              title={derived.autoRaised
                ? 'Too many nodes sit above the configured threshold to list, so this view raised it. The setting itself is untouched.'
                : 'Hide nodes below this share of the run (Settings ▸ Profiler).'}
            />
            <Chip
              on={hideNeverExecuted}
              onToggle={() => setHideNeverExecuted((h) => !h)}
              label={<>hide never-executed (<b>{fmtInt(index.neverEvaluated)}</b>)</>}
              title="Nodes of this term that the run never reached."
            />
            <label className="prof-search">
              <Codicon name="search" />
              <input
                ref={filterRef}
                value={text}
                placeholder="filter nodes"
                aria-label="Filter nodes"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setText(''); } }}
              />
            </label>
            <span className="prof-meta">
              {text.trim() === ''
                ? 'matched — · —'
                : `matched ${fmtInt(derived.matchedCount)} nodes · ${fmtPct(derived.matchedSelf, index.total)} of ${unit}`}
            </span>
          </div>
        )}
      </div>

      <div className="prof-split">
        <div className="prof-main">
          {pane === 'terms' && (
            <>
              <TermsTable
                derived={derived}
                index={index}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={onSort}
                onFocusFilter={() => filterRef.current?.focus()}
                onClearFilter={() => setText('')}
              />
              <TermsTail derived={derived} index={index} onShowMore={() => setTailShown((n) => n + TAIL_PAGE)} />
              <div className="prof-foot">
                Self = charged directly at this node (including the builtins applied here). Subtree =
                self summed over this node's static AST descendants. Children + self = subtree, exactly.
                <br />
                % run is of {metricUnit(metric)}_spent. Node self-costs sum to {metricUnit(metric)}_spent −
                startup_{metricUnit(metric)} — StartUp is a flat 100 cpu / 100 mem charged in{' '}
                <code>ManualMachine::new</code> and belongs to no node.
              </div>
            </>
          )}
          {pane === 'builtins' && (
            <>
              <BuiltinsTable profile={profile} />
              <StepKindsTable profile={profile} />
            </>
          )}
          {pane === 'steps' && <StepKindsTable profile={profile} open />}
        </div>

        {pane === 'terms' && (
          narrow.stacked ? (
            <details className="prof-side" open>
              <summary className="prof-sec-title" style={{ cursor: 'pointer' }}>Selected node</summary>
              <NodeDetail />
            </details>
          ) : (
            <aside className="prof-side"><NodeDetail /></aside>
          )
        )}
      </div>
    </div>
  );
}

/** A filter chip: what is being hidden, and the one control that stops hiding it. Removing a chip
 *  leaves it in place as a re-add affordance — the state stays visible either way. */
function Chip({ on, auto, label, title, onToggle }: {
  on: boolean;
  auto?: boolean;
  label: ReactNode;
  title: string;
  onToggle: () => void;
}) {
  return (
    <span className={`prof-chip${auto ? ' is-auto' : ''}`} title={title} style={on ? undefined : { opacity: 0.55 }}>
      {label}
      <button className="prof-chip-x" onClick={onToggle}
        title={on ? 'Remove this filter' : 'Apply this filter again'}
        aria-label={on ? 'Remove this filter' : 'Apply this filter again'}>
        <Codicon name={on ? 'close' : 'add'} />
      </button>
    </span>
  );
}
