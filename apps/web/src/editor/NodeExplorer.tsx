import { useEffect, useState } from 'react';
import { buildNodeChildren, type DataSource, type LazyKind, type UplcNode } from '@de-uplc/core';
import { getSession, useStore } from '../store';
import { useSettings } from '../platform/settings';
import { Tree, nodeIconColor } from '../components/Tree';
import { Codicon } from '../components/Codicon';
import { NumberField } from '../components/NumberField';

// A node budget caps the deep search regardless of depth, so it never re-creates the
// "dump the whole subtree" cost (each child load is a worker round-trip).
const SEARCH_MAX_NODES = 1500;

interface SearchResult {
  childrenOf: Map<UplcNode, UplcNode[]>; // loaded children, by node
  matched: Set<UplcNode>;                // nodes whose own label matched
  onPath: Set<UplcNode>;                 // a match, or an ancestor of one (the only nodes shown)
  count: number;
  truncated: boolean;                    // hit the depth/node budget — deeper matches may exist
}

/** Bounded walk: load children up to `maxDepth` / the node budget, mark matches + the paths to them. */
async function searchTree(roots: UplcNode[], query: string, maxDepth: number): Promise<SearchResult> {
  const needle = query.toLowerCase();
  const childrenOf = new Map<UplcNode, UplcNode[]>();
  const matched = new Set<UplcNode>();
  const onPath = new Set<UplcNode>();
  let count = 0;
  let visited = 0;
  let truncated = false;

  async function walk(node: UplcNode, depth: number): Promise<boolean> {
    if (visited++ >= SEARCH_MAX_NODES) { truncated = true; return false; }
    const view = node.toViewModel();
    // Bound the lowercase to a generous prefix: a loaded full value's label can be multi-MB, and
    // allocating a lowercased copy of every such label per keystroke is a real cost. 4 KB dwarfs the
    // 128-char preview, so normal searches are unaffected (matches past 4 KB inside a huge value are
    // the only thing skipped — acceptable for a preview-oriented tree).
    const hay = view.label.length > 4096 ? view.label.slice(0, 4096) : view.label;
    const selfMatch = hay.toLowerCase().includes(needle);
    if (selfMatch) { matched.add(node); count++; }
    let descMatch = false;
    if (view.collapsible) {
      if (depth >= maxDepth) {
        truncated = true;
      } else {
        let kids = childrenOf.get(node);
        if (!kids) {
          try { kids = await node.getChildren(); } catch { kids = []; }
          childrenOf.set(node, kids);
        }
        for (const k of kids) { if (await walk(k, depth + 1)) descMatch = true; }
      }
    }
    const onp = selfMatch || descMatch;
    if (onp) onPath.add(node);
    return onp;
  }

  for (const r of roots) await walk(r, 0);
  return { childrenOf, matched, onPath, count, truncated };
}

/** Renders a node from a completed search walk: only on-path children, all expanded, matches lit. */
function SearchRow({ node, depth, res }: { node: UplcNode; depth: number; res: SearchResult }) {
  const view = node.toViewModel();
  const kids = (res.childrenOf.get(node) ?? []).filter((k) => res.onPath.has(k));
  return (
    <div>
      <div className={`tree-row${view.wrap ? ' tree-row-wrap' : ''}`} style={{ paddingLeft: 6 + depth * 14 }} role="treeitem">
        <span className="tree-twisty">{kids.length ? <Codicon name="chevron-down" /> : null}</span>
        {view.icon && <span style={{ color: nodeIconColor(node, view.iconColor) }}><Codicon name={view.icon} /></span>}
        <span className={`tree-label${res.matched.has(node) ? ' tree-match' : ''}`} title={view.tooltip ?? view.label}>{view.label}</span>
        {view.description && <span className="muted" style={{ marginLeft: 6 }}>{view.description}</span>}
      </div>
      {kids.map((k, i) => <SearchRow key={i} node={k} depth={depth + 1} res={res} />)}
    </div>
  );
}

/**
 * A lazy explorer rooted at one tree node: loads only the node's children, then expands further on
 * demand (via getLazy) — the alternative to dumping the whole subtree as JSON. Re-resolves against
 * the live session on every step. A non-empty query runs a bounded DEEP search (auto-loads up to the
 * configurable `searchDepth` levels), shows the count, and renders only branches leading to matches.
 */
export function NodeExplorer({ source, path, nodeKind, label }: {
  source: DataSource; path: string[]; nodeKind: LazyKind; label: string;
}) {
  const gen = useStore((s) => s.treeGeneration);
  const session = getSession();
  const searchDepth = useSettings((s) => s.searchDepth);
  const setSetting = useSettings((s) => s.set);
  const [roots, setRoots] = useState<UplcNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  // (Re)load the node's children on session / step.
  useEffect(() => {
    let cancelled = false;
    if (!session) { setRoots([]); return; }
    setRoots(null);
    setError(null);
    buildNodeChildren(source, path, nodeKind, label, session)
      .then((r) => { if (!cancelled) setRoots(r); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
    // path is stable per tab; stringify so the dep is value-compared.
  }, [source, JSON.stringify(path), nodeKind, label, session, gen]);

  // Bounded deep search (debounced) when a query is present; re-runs when the depth changes.
  const q = query.trim();
  useEffect(() => {
    if (!q || !roots) { setResult(null); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      void searchTree(roots, q, searchDepth).then((r) => { if (!cancelled) { setResult(r); setSearching(false); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, roots, searchDepth]);

  const countLabel = searching
    ? 'searching…'
    : result
      // "+" (more may exist past the bound) only makes sense alongside a non-zero count.
      ? `${result.count} match${result.count === 1 ? '' : 'es'}${result.truncated && result.count > 0 ? '+' : ''}`
      : '';

  return (
    <div className="node-explorer">
      <div className="node-explorer-bar">
        <Codicon name="search" />
        <input
          className="node-search"
          type="text"
          placeholder={`Search (up to ${searchDepth} level${searchDepth === 1 ? '' : 's'})…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {q && <span className="muted" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{countLabel}</span>}
        <label className="node-depth" title="Max search depth — levels the search auto-loads (any depth; the search is still bounded by a node budget). Saved.">
          lvl
          <NumberField value={searchDepth} min={1} onCommit={(n) => setSetting('searchDepth', n)} />
        </label>
        {query && (
          <button className="icon-button" title="Clear filter" aria-label="Clear filter" onClick={() => setQuery('')}>
            <Codicon name="close" />
          </button>
        )}
      </div>
      <div className="node-explorer-tree">
        {error ? (
          <div className="muted" style={{ color: 'var(--error-fg)', padding: 8 }}>Failed to load: {error}</div>
        ) : roots === null ? (
          <div className="muted" style={{ padding: 8 }}>Loading…</div>
        ) : q ? (
          searching && !result ? (
            <div className="muted" style={{ padding: 8 }}>Searching…</div>
          ) : result && result.onPath.size === 0 ? (
            <div className="muted" style={{ padding: 8 }}>No matches in the first {searchDepth} levels — raise the depth (lvl) to search deeper.</div>
          ) : result ? (
            <div role="tree" className="tree">
              {roots.filter((r) => result.onPath.has(r)).map((r, i) => <SearchRow key={i} node={r} depth={0} res={result} />)}
              {result.truncated && (
                <div className="muted" style={{ padding: '4px 8px', fontSize: 11.5 }}>
                  bounded at {searchDepth} levels / {SEARCH_MAX_NODES} nodes — raise the depth or expand manually to go deeper
                </div>
              )}
            </div>
          ) : null
        ) : (
          <Tree roots={roots} generation={gen} />
        )}
      </div>
    </div>
  );
}
