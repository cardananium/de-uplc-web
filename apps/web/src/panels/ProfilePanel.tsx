import { useMemo } from 'react';
import { useStore, revealTermInEditor } from '../store';
import { Codicon } from '../components/Codicon';
import { fmtInt, fmtLn, fmtPct } from '../profile/format';
import { nodeLabel } from '../profile/heat';
import { metricWord, topNodes, TOP_N } from '../profile/derive';
import { dataDecoding } from '../profile/builtin-groups';
import {
  OpenReportButton, OutcomeNote, OutcomePill, ProfileBudget, ProfileEmpty, ProfileLiveRegion,
  ProfileProgress, RunMeta, useOutcome,
} from './profile/ProfileRunState';
import '../profile/profile.css';

/**
 * The PROFILE card in the sidebar: outcome, the two budgets, the one-line data-decoding verdict,
 * the five hottest nodes and the heat toggle. It is the profiler's ambient surface — the report tab
 * is where the analysis happens, this is what tells you whether to open it.
 *
 * Per-field selectors throughout (never `useStore()`), like every other panel: this one sits above
 * the inspector trees, which pull on every CEK step.
 */
export function ProfilePanel() {
  const status = useStore((s) => s.profileStatus);
  const profile = useStore((s) => s.profile);
  const index = useStore((s) => s.profileIndex);
  const stale = useStore((s) => s.profileStale);
  const metric = useStore((s) => s.profileMetric);
  const setProfileMetric = useStore((s) => s.setProfileMetric);
  const heat = useStore((s) => s.profileHeat);
  const toggleProfileHeat = useStore((s) => s.toggleProfileHeat);
  const clearProfile = useStore((s) => s.clearProfile);
  const outcome = useOutcome();

  const top = useMemo(() => (index ? topNodes(index, TOP_N) : undefined), [index]);
  const decode = useMemo(
    () => (profile ? dataDecoding(profile.builtins, metric) : undefined),
    [profile, metric],
  );

  const totals = profile?.totals;
  const spent = metric === 'cpu' ? totals?.cpuSpent : totals?.memSpent;
  const running = status === 'running';

  return (
    <div className="panel prof-panel">
      <div className="panel-title-row">
        <div className="panel-title">Profile</div>
        {/* Metric is global: the same toggle drives the heat lane, the ruler, F8 and the report. */}
        <div className="seg" role="tablist" aria-label="Profile metric">
          <button role="tab" aria-selected={metric === 'cpu'} className={`seg-item${metric === 'cpu' ? ' is-active' : ''}`}
            onClick={() => setProfileMetric('cpu')}>CPU</button>
          <button role="tab" aria-selected={metric === 'mem'} className={`seg-item${metric === 'mem' ? ' is-active' : ''}`}
            onClick={() => setProfileMetric('mem')}>Mem</button>
        </div>
      </div>

      <ProfileLiveRegion />

      {running && (
        <>
          <div className="prof-line" style={{ marginTop: 10 }}><OutcomePill outcome="Running" /></div>
          <ProfileProgress />
        </>
      )}

      {!running && !profile && status !== 'error' && <ProfileEmpty compact />}

      {!running && outcome && (outcome === 'Failed' || profile) && (
        <>
          <div className="prof-line" style={{ marginTop: 10 }}>
            <OutcomePill outcome={outcome} />
            {profile && <span className="prof-meta"><RunMeta /></span>}
          </div>
          <OutcomeNote outcome={outcome} />
        </>
      )}

      {/* Everything between the pill and the report button collapses at ≤ 900px, where the sidebar
          becomes a 46vh-tall column with nine panels in it: a summary below the fold is useless,
          but the way into the report is not. */}
      {!running && profile && totals && (
        <div className="prof-collapsible">
          <div className="budget" style={{ marginTop: 12 }}>
            <div className="budget-cols budget-head">
              <span />
              <span>Spent</span>
              <span>Limit</span>
            </div>
            {/* Verbatim the live run's metric widget — same spent/limit language, same overspend
                gradient — with the profiler's own labels, so the metric toggle above and the row
                below never disagree about what they are naming. */}
            <ProfileBudget label="CPU" spent={totals.cpuSpent} limit={totals.cpuLimit} />
            <ProfileBudget label="Memory" spent={totals.memSpent} limit={totals.memLimit} />
          </div>

          {/* Only when something was actually decoded: "Data decoding is 0.00% of CPU" is a verdict
              about nothing. The report tab's headline is a fixed part of its header and stays. */}
          {decode && decode.calls > 0 && spent !== undefined && spent > 0 && (
            <>
              <div className="panel-divider" />
              <div
                className="prof-line"
                title="the *Data builtins; the profiler cannot tell which Data value was decoded."
              >
                Data decoding is {fmtPct(metric === 'cpu' ? decode.cpu : decode.mem, spent)} of {metricWord(metric)}
              </div>
            </>
          )}

          {top && top.rows.length > 0 && (
            <>
              <div className="panel-divider" />
              <div className="prof-top-head">
                {/* Self, always — never the report's scope. Under subtree every ancestor of a hot
                    node carries nearly the same number and the list becomes the AST spine. */}
                <span>Hottest nodes (self)</span>
                <span>Top {top.rows.length} = {fmtPct(top.rows.reduce((a, r) => a + r.self, 0), spent)} of {metricWord(metric)}</span>
              </div>
              <div className="prof-top">
                {top.rows.map((row, i) => (
                  <div className="prof-top-row" key={row.termId}>
                    <span className="prof-top-rank">{i + 1}</span>
                    <span className="prof-top-label" title={`${nodeLabel(row)} · #${row.termId}`}>
                      <span className="prof-ln">{row.line === undefined ? '—' : fmtLn(row.line)}</span>
                      {' · '}
                      {nodeLabel(row)}
                    </span>
                    <span className="prof-top-stats">
                      <b>{fmtPct(row.self, spent)}</b> · {fmtInt(row.hits)}×
                    </span>
                    <button
                      className="prof-reveal"
                      title="Reveal this term in the editor"
                      aria-label={`Reveal ${nodeLabel(row)} in the editor`}
                      disabled={stale || row.line === undefined}
                      onClick={() => revealTermInEditor(row.termId)}
                    >
                      <Codicon name="go-to-file" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="panel-divider" />
          <label className="prof-check" title="Toggle the heat map (Ctrl/Cmd+Alt+P)">
            <input type="checkbox" checked={heat} onChange={toggleProfileHeat} />
            <span>Heat map in the term editor</span>
          </label>
        </div>
      )}

      {!running && profile && (
        <>
          <div className="prof-actions">
            <OpenReportButton />
            <button className="text-button" title="Clear profile" aria-label="Clear profile" onClick={clearProfile}>
              <Codicon name="close" /> Clear
            </button>
          </div>
          {index && (
            <div className="prof-meta prof-collapsible" style={{ marginTop: 8 }}>
              {fmtInt(index.nodeCount)} term nodes · {fmtInt(index.neverEvaluated)} never evaluated
              {index.noLocation.count > 0 && <> · {fmtInt(index.noLocation.count)} without a source location</>}
            </div>
          )}
        </>
      )}
    </div>
  );
}
