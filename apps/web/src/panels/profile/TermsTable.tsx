import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useStore, revealTermInEditor } from '../../store';
import { Codicon } from '../../components/Codicon';
import { EmptyState } from '../../components/EmptyState';
import { SortHeader } from '../../components/SortHeader';
import { fmtInt, fmtPct, fmtPerHit } from '../../profile/format';
import { bucketOf, nodeLabel, NO_BUCKET } from '../../profile/heat';
import {
  fmtThreshold, isReturnDominated, metricWord, type DerivedReport, type SortDir, type SortKey,
} from '../../profile/derive';
import type { ProfileIndex } from '../../profile/profile-index';

/**
 * Hot terms: the ranked node table.
 *
 * Three things about it are load-bearing and easy to lose in a refactor.
 *
 * ONE TAB STOP, ON THE GRID. `role="grid"` sits on the `<table>` and carries `tabIndex=0` plus the
 * roving `aria-activedescendant` — 300 focusable rows would be an unusable tab order,
 * and putting a button in each row would be 300 more. It has to be the TABLE and not the `<tbody>`
 * for two reasons: `rowgroup` does not support `aria-activedescendant`, and inside a `grid` the
 * cells keep their column semantics (`th` → `columnheader`, `td` → `gridcell`, HTML-AAM) instead of
 * being stranded under a `listbox` that may not contain them. Arrow keys move the active row (which
 * is also the selection, so the detail panel follows), `Enter` reveals it in the editor.
 *
 * ONE `aria-sort`. Exactly one header may say anything but `none`, so the active key is passed in
 * rather than each header deciding for itself.
 *
 * NO-LOCATION ROWS ARE INERT. A row whose id is not in this rendering has nowhere to be revealed,
 * so it says so in the `Node` column, is not clickable, and sorts to the end of `Ln` either way
 * (the acceptance tests). Its cost is still real and still counted — by the warning line under the table.
 */
export function TermsTable({ derived, index, sortKey, sortDir, onSort, onFocusFilter, onClearFilter }: {
  derived: DerivedReport;
  index: ProfileIndex;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onFocusFilter: () => void;
  onClearFilter: () => void;
}) {
  const selected = useStore((s) => s.profileSelected);
  const select = useStore((s) => s.selectProfileNode);
  const stale = useStore((s) => s.profileStale);
  const metric = useStore((s) => s.profileMetric);
  const termText = useStore((s) => s.termText);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLTableElement>(null);

  // While the profile is stale the rows point at a rendering that is no longer on screen, so the
  // fragment would quote the wrong line — the one thing worse than no fragment.
  const starts = useMemo(() => (termText && !stale ? lineStarts(termText) : undefined), [termText, stale]);

  const rows = derived.rows;
  const attribution = index.context.attribution;
  const unit = metricWord(metric);
  // The cursor follows the STORE's selection whenever that row is on screen, and falls back to
  // local state otherwise. That is what makes leaving for the editor and coming back keep your
  // place: the tab unmounts on a tab switch, the selection does not. It also keeps a
  // filter that re-ranks under the cursor from leaving it past the end of the list.
  const selectedIndex = useMemo(() => rows.findIndex((r) => r.row.termId === selected), [rows, selected]);
  const cursor = selectedIndex >= 0 ? selectedIndex : Math.min(active, Math.max(0, rows.length - 1));

  // On (re)mount, bring the selected row back into view — the scroll position is DOM state and did
  // not survive the tab switch, but the selection did.
  useEffect(() => {
    if (selectedIndex >= 0) scrollRowIntoView(listRef.current, rows[selectedIndex].row.termId);
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (next: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, next));
    setActive(clamped);
    const row = rows[clamped];
    if (!row) return;
    // A no-location row is not selectable, but the cursor still has to travel over it — and `cursor`
    // follows the STORE's selection whenever it is on screen, so the selection is CLEARED rather
    // than left behind on the row we just moved off (which would pin the cursor there).
    select(row.row.line === undefined ? undefined : row.row.termId);
    scrollRowIntoView(listRef.current, row.row.termId);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // The grid is the tab stop, and the sortable headers inside it are real buttons, so
    // their keys bubble through here: `Enter` on a header must sort, not reveal a row — and
    // `preventDefault` here would swallow the button's activation entirely.
    if (e.target instanceof HTMLElement && e.target.closest('button')) return;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(cursor + 1); break;
      case 'ArrowUp': e.preventDefault(); move(cursor - 1); break;
      case 'Home': e.preventDefault(); move(0); break;
      case 'End': e.preventDefault(); move(rows.length - 1); break;
      case 'PageDown': e.preventDefault(); move(cursor + 20); break;
      case 'PageUp': e.preventDefault(); move(cursor - 20); break;
      case 'Enter': {
        e.preventDefault();
        const row = rows[cursor];
        if (row && !stale && row.row.line !== undefined) revealTermInEditor(row.row.termId);
        break;
      }
      case '/': e.preventDefault(); onFocusFilter(); break;
      case 'Escape': e.preventDefault(); onClearFilter(); break;
      default: break;
    }
  };

  if (rows.length === 0) {
    return <EmptyState icon="filter" title="No nodes match — remove a filter." />;
  }

  return (
    <table
      className="prof-table"
      ref={listRef}
      role="grid"
      aria-label="Hot terms"
      tabIndex={0}
      aria-activedescendant={rows[cursor] ? `prof-row-${rows[cursor].row.termId}` : undefined}
      onKeyDown={onKeyDown}
    >
      <thead>
        <tr>
          <th scope="col" className="prof-th">#</th>
          <SortHeader label="Ln" sortKey="line" active={sortKey} dir={sortDir} onSort={onSort}
            hint="Sort by line — nodes with no location in this rendering collect at the end either way." />
          <th scope="col" className="prof-th">Node<span className="prof-sub">kind · #id · source</span></th>
          <SortHeader label="Hits" sortKey="hits" active={sortKey} dir={sortDir} onSort={onSort}
            hint="Sort by hits — one node re-evaluated, which is what recursion looks like in UPLC." />
          <SortHeader label={`${unit}/hit`} sortKey="perHit" active={sortKey} dir={sortDir} onSort={onSort}
            hint={`Sort by ${unit} per hit — it separates "rewrite the loop" from "replace the builtin".`} />
          <SortHeader label={`Self ${unit}`} sub="% run" sortKey="self" active={sortKey} dir={sortDir} onSort={onSort}
            hint={`Sort by self ${unit} — charged directly at this node.`} />
          {/* Σ% is a running sum of the self share, so it means something only under self-descending;
              under any other sort the cells print an em dash and the header dims. */}
          <th scope="col" className={`prof-th${derived.cumulativeMeaningful ? '' : ' is-muted'}`}
            title={derived.cumulativeMeaningful
              ? 'Running total of % run, top-down — how much of the run the rows above cover.'
              : 'Meaningful only when sorted by self, descending.'}>
            Σ %
            <span className="prof-sub prof-drop">% limit</span>
          </th>
          <SortHeader label={`Subtree ${unit}`} sub="% sub" sortKey="subtree" active={sortKey} dir={sortDir} onSort={onSort}
            hint="Sort by subtree — it degenerates into the AST spine (every ancestor of a hot node has nearly the same subtree). Use the tree in the panel instead." />
        </tr>
      </thead>
      <tbody className="prof-rows">
        {rows.map(({ row, rank, cum }, i) => {
          const bucket = bucketOf(row.self, index.total, row.hits);
          const share = index.total > 0 ? (row.self / index.total) * 100 : 0;
          const approx = isReturnDominated(row, attribution);
          const line = row.line;
          const frag = line !== undefined && termText && starts ? lineFragment(termText, starts, line) : '';
          return (
            <tr
              key={row.termId}
              id={`prof-row-${row.termId}`}
              aria-selected={row.termId === selected}
              aria-disabled={line === undefined ? true : undefined}
              className={`${row.termId === selected ? ' is-selected' : ''}${i === cursor ? ' is-active' : ''}`}
              onClick={line === undefined ? undefined : () => { setActive(i); select(row.termId); }}
              onDoubleClick={line === undefined ? undefined : () => { if (!stale) revealTermInEditor(row.termId); }}
            >
              <td className="prof-num">{rank}</td>
              <td className="prof-num">{line === undefined ? '—' : fmtInt(line + 1)}</td>
              {/* kind + #id + a fragment of the source line: a bare `Apply` names nothing on
                  its own. The fragment is DECORATION — kind and label come from `TermLocation`,
                  never from the line's text, which differs between the two renderers. */}
              <td className="prof-node" title={`${nodeLabel(row)} · #${row.termId}${frag ? ` · ${frag}` : ''}`}>
                {line === undefined
                  ? <span className="prof-noloc">#{row.termId} (no source location)</span>
                  : <>{nodeLabel(row)}<span className="prof-id"> #{row.termId}</span></>}
                {approx && (
                  <span className="prof-approx" title="Return-step cost is charged to the last node that executed (v1 attribution)."> ≈</span>
                )}
                {frag && <span className="prof-frag"> {frag}</span>}
              </td>
              <td className="prof-num">{fmtInt(row.hits)}</td>
              <td className="prof-num">{fmtPerHit(row.self, row.hits)}</td>
              {/* The proportional bar rides on the cell itself: no extra DOM, and it cannot fall out
                  of step with the number printed on top of it. */}
              <td
                className="prof-num prof-bar"
                style={bucket === NO_BUCKET ? undefined : ({ '--prof-c': `var(--prof-heat-${bucket})`, '--prof-w': `${Math.min(100, share)}%` } as CSSProperties)}
              >
                {fmtInt(row.self)}
                <span className="prof-sub">{fmtPct(row.self, index.total)}</span>
              </td>
              <td className="prof-num">
                {Number.isNaN(cum) ? '—' : fmtPct(cum, 1)}
                <span className="prof-sub prof-drop">{fmtPct(row.self, index.limit)}</span>
              </td>
              {/* Muted and with NO bar: a second bar in the same row would be measured against a
                  different denominator and the eye would compare them anyway. */}
              <td className="prof-num prof-sub-col">
                {fmtInt(row.subtree)}
                <span className="prof-sub prof-drop">{fmtPct(row.subtree, index.total)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function scrollRowIntoView(list: HTMLElement | null, termId: number): void {
  list?.querySelector(`#prof-row-${CSS.escape(String(termId))}`)?.scrollIntoView({ block: 'nearest' });
}

/** Longest source fragment the `Node` cell carries. The cell ellipsises in CSS; this only keeps a
 *  4 000-character line out of the DOM 2 000 times over. */
const FRAGMENT_MAX = 80;

/**
 * Offsets of every 0-based line in the term text, built once per text identity.
 *
 * An OFFSET index rather than `termText.split('\n')`: at most `RENDER_CAP` fragments are ever
 * printed, and splitting a 200k-line term would materialise 200k strings to show 2 000 of them.
 * Length is `lines + 1` — the last entry is a sentinel one past the end, so the slice below needs
 * no special case for the final line.
 */
function lineStarts(text: string): Int32Array {
  let lines = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines += 1;
  const starts = new Int32Array(lines + 1);
  let k = 1;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts[k++] = i + 1;
  starts[lines] = text.length + 1;
  return starts;
}

/** The 0-based line's text, trimmed and clipped. Empty when the line is outside this text — which
 *  is what a rendering that no longer matches the profile looks like. */
function lineFragment(text: string, starts: Int32Array, line: number): string {
  if (line < 0 || line + 1 >= starts.length) return '';
  const from = starts[line];
  return text.slice(from, Math.min(starts[line + 1] - 1, from + FRAGMENT_MAX)).trim();
}

/** The line under the table: what the threshold is hiding, what the ceiling cut, and what never ran
 *  at all. Every one of them is a number the UI owes the user. */
export function TermsTail({ derived, index, onShowMore }: {
  derived: DerivedReport;
  index: ProfileIndex;
  onShowMore: () => void;
}) {
  const metric = useStore((s) => s.profileMetric);
  const unit = metricWord(metric);
  return (
    <div className="prof-tail">
      {derived.tailCount > 0 && (
        <div>
          <Codicon name="chevron-right" />
          and {fmtInt(derived.tailCount)} more executed nodes below {fmtThreshold(derived.effectiveMinSharePct)} ({fmtPct(derived.tailSelf, index.total)} of {unit})
          {!derived.capped && (
            <button className="text-button" onClick={onShowMore}>Show 200 more</button>
          )}
        </div>
      )}
      {derived.capped && (
        <div>showing {fmtInt(derived.rows.length)} of {fmtInt(derived.totalMatched)} — narrow the filter to see more</div>
      )}
      <div>{fmtInt(index.neverEvaluated)} of {fmtInt(index.nodeCount)} nodes were never evaluated.</div>
      {index.noLocation.count > 0 && (
        <div className="prof-warn">
          <Codicon name="warning" /> {fmtInt(index.noLocation.count)} nodes ({fmtPct(index.noLocation.self, index.total)} {metric})
          have no source location — not revealable.
        </div>
      )}
    </div>
  );
}
