import { useMemo, useRef, useState } from 'react';
import { termIndexFor } from '@de-uplc/core';
import { useStore, revealTermInEditor } from '../../store';
import { Codicon } from '../../components/Codicon';
import { EmptyState } from '../../components/EmptyState';
import { Tree } from '../../components/Tree';
import { fmtInt, fmtLn, fmtPct, fmtPerHit } from '../../profile/format';
import { nodeLabel } from '../../profile/heat';
import { metricUnit } from '../../profile/derive';
import { CostTree, costRoots, enclosingNodes } from '../../profile/cost-nodes';

/**
 * The report's right-hand half: what the selected node costs, what encloses it and what is inside
 * it. Both halves are derived on the client from `TermLocation` intervals — the Rust payload has no
 * tree in it, and does not need one.
 */
export function NodeDetail() {
  const selected = useStore((s) => s.profileSelected);
  const index = useStore((s) => s.profileIndex);
  const profile = useStore((s) => s.profile);
  const locations = useStore((s) => s.termLocations);
  const view = useStore((s) => s.termView);
  const metric = useStore((s) => s.profileMetric);
  const stale = useStore((s) => s.profileStale);
  const generation = useProfileGeneration();
  const [allAncestors, setAllAncestors] = useState(false);

  const tree = useMemo(
    () => (index && locations.length > 0 ? new CostTree(termIndexFor(locations, view), index) : undefined),
    [index, locations, view],
  );
  const roots = useMemo(() => (tree ? costRoots(tree, selected) : []), [tree, selected, generation]);
  const ancestors = useMemo(() => (tree ? enclosingNodes(tree, selected) : []), [tree, selected]);

  if (!index) return null;
  const row = selected === undefined ? undefined : index.rowFor(selected);
  const loc = selected === undefined ? undefined : termIndexFor(locations, view).locationOf(selected);
  if (selected === undefined || (!row && !loc)) {
    return <EmptyState compact icon="list-tree" title="No node selected" hint="Pick a row to see what it costs and what is inside it." />;
  }

  const total = index.total;
  const other = metric === 'cpu' ? 'mem' : 'cpu';
  const otherTotal = metric === 'cpu' ? profile?.totals.memSpent : profile?.totals.cpuSpent;
  const otherSelf = row ? (metric === 'cpu' ? row.selfMem : row.selfCpu) : 0;
  const self = row?.self ?? 0;
  const subtree = row?.subtree ?? 0;
  const hits = row?.hits ?? 0;

  const shown = allAncestors || ancestors.length <= 3 ? ancestors : [...ancestors.slice(0, 2), ...ancestors.slice(-1)];
  const hiddenAncestors = ancestors.length - shown.length;

  return (
    <>
      <div className="prof-detail-title">
        <span>{nodeLabel(loc ?? row ?? {})}</span>
        <span className="prof-id">#{selected}</span>
        <span className="prof-id">{loc ? fmtLn(loc.startLine) : '—'}</span>
        <button
          className="prof-reveal"
          title="Reveal this term in the editor"
          aria-label="Reveal this term in the editor"
          disabled={stale || !loc}
          onClick={() => revealTermInEditor(selected)}
        >
          <Codicon name="go-to-file" />
        </button>
      </div>

      <dl className="prof-kv">
        <dt>self</dt>
        <dd>{fmtInt(self)} {metricUnit(metric)}</dd>
        <dd className="prof-kv-pct">{fmtPct(self, total)} / {fmtPct(self, index.limit)}</dd>
        <dt>subtree</dt>
        <dd>{fmtInt(subtree)} {metricUnit(metric)}</dd>
        <dd className="prof-kv-pct">{fmtPct(subtree, total)} / {fmtPct(subtree, index.limit)}</dd>
        {/* The other metric's self, so the panel answers "is this cpu-bound or mem-bound?" without
            flipping the global toggle and losing the ranking you were reading. */}
        <dt>self {other}</dt>
        <dd>{fmtInt(otherSelf)}</dd>
        <dd className="prof-kv-pct">{fmtPct(otherSelf, otherTotal)}</dd>
        <dt>hits</dt>
        <dd>{fmtInt(hits)}</dd>
        <dd className="prof-kv-pct">{fmtPerHit(self, hits, `${metricUnit(metric)}/hit`)}</dd>
      </dl>

      <div className="prof-sec-title">Enclosing nodes (root → here)</div>
      {ancestors.length === 0 ? (
        <div className="prof-meta" style={{ marginTop: 6 }}>This is the root of the term.</div>
      ) : (
        <div className="prof-anc">
          {shown.map((a, i) => (
            <Ancestor key={a.termId} node={a} total={total} gapAfter={!allAncestors && hiddenAncestors > 0 && i === 1} hidden={hiddenAncestors} onExpand={() => setAllAncestors(true)} />
          ))}
        </div>
      )}
      <div className="prof-note" style={{ marginTop: 6 }}>
        Enclosing term nodes — not a call stack. UPLC has no call stack. Under recursion these are
        the static AST parents, not the path the machine took.
      </div>

      <div className="prof-sec-title">Inside this node (AST subtrees)</div>
      {/* The generation is the tree's React key, and it is a PROFILE generation on purpose:
          `treeGeneration` bumps in `pullInspectors` on every CEK step and would collapse this tree
          under the user on each `step()`. */}
      <Tree roots={roots} generation={generation} />
    </>
  );
}

/** One `ENCLOSING NODES` row; the id selects, so the chain is navigable without leaving the panel. */
function Ancestor({ node, total, gapAfter, hidden, onExpand }: {
  node: ReturnType<CostTree['costAt']>;
  total: number;
  gapAfter: boolean;
  hidden: number;
  onExpand: () => void;
}) {
  const select = useStore((s) => s.selectProfileNode);
  return (
    <>
      <button className="prof-id" style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
        onClick={() => select(node.termId)} title="Select this node">
        #{node.termId}
      </button>
      <span className="prof-anc-label">{nodeLabel(node)}</span>
      <span>{fmtPct(node.subtree, total)}</span>
      <span className="prof-id">{node.line === undefined ? '—' : fmtLn(node.line)}</span>
      {gapAfter && (
        <span className="prof-anc-more">
          <button onClick={onExpand}>… {fmtInt(hidden)} more</button>
        </span>
      )}
    </>
  );
}

/**
 * A generation that changes only when the COST TREE's content does. `<Tree>` uses its `generation`
 * as a React key to discard expansion state, so feeding it the store's `treeGeneration` (bumped on
 * every inspector pull, i.e. every step) would re-collapse this tree constantly.
 */
export function useProfileGeneration(): number {
  const profile = useStore((s) => s.profile);
  const metric = useStore((s) => s.profileMetric);
  const scope = useStore((s) => s.profileScope);
  const selected = useStore((s) => s.profileSelected);
  const gen = useRef(0);
  const key = useRef<[unknown, string, string, number | undefined]>();
  const k = key.current;
  if (!k || k[0] !== profile || k[1] !== metric || k[2] !== scope || k[3] !== selected) {
    key.current = [profile, metric, scope, selected];
    gen.current += 1;
  }
  return gen.current;
}
