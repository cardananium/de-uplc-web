import { useEffect, useState } from 'react';
import type { LazyKind, UplcNode } from '@de-uplc/core';
import { Codicon } from './Codicon';
import { EmptyState } from './EmptyState';
import { openNodeInTab, revealTermInEditor } from '../store';

function iconColorVar(iconColor?: string): string | undefined {
  if (!iconColor) return undefined;
  // A caller that already speaks CSS passes its own token through untouched (the profiler's cost
  // tree tints each row with `var(--prof-heat-N)`); the rest are VS Code ThemeColor ids, mapped.
  if (iconColor.startsWith('var(--')) return iconColor;
  if (iconColor.toLowerCase().includes('warning')) return 'var(--dbg-pause)';
  if (iconColor.toLowerCase().includes('error')) return 'var(--error-fg)';
  return undefined;
}

// Soft per-kind icon tints so the tree reads as a coloured structure instead of grey-on-grey.
const KIND_COLORS: Record<string, string> = {
  machineState: 'var(--node-state)',
  context: 'var(--node-context)',
  env: 'var(--node-env)',
  value: 'var(--node-value)',
  constant: 'var(--node-constant)',
  runtime: 'var(--node-runtime)',
  term: 'var(--node-term)',
};

/** Icon tint: a warning/error colour wins, otherwise a soft per-kind colour (shared with SearchRow). */
export function nodeIconColor(node: UplcNode, iconColor?: string): string | undefined {
  return iconColorVar(iconColor) ?? (node.lazyKind ? KIND_COLORS[node.lazyKind] : undefined);
}

// Kinds the engine can RE-LOAD standalone via getLazy(path), so they can root a NodeExplorer tab.
// A 'runtime' can't be navigated to as a value ("Machine error: Cannot return runtime as value"),
// so it gets no open-in-tab button — a Builtin Runtime stays fully explorable inline / inside its
// parent Builtin value's tab. (value/constant/env/context/machineState all re-load fine.)
const TAB_OPENABLE = new Set<string>(['machineState', 'context', 'env', 'value', 'constant']);

function TreeRow({ node, depth, filter }: { node: UplcNode; depth: number; filter: string }) {
  const view = node.toViewModel();
  const [expanded, setExpanded] = useState(!!view.expanded);
  const [children, setChildren] = useState<UplcNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const q = filter.toLowerCase();
  const matches = q !== '' && view.label.toLowerCase().includes(q);
  // A multi-MB label would otherwise be duplicated into a (useless) native tooltip — only set
  // `title` for short labels or an explicit tooltip, so expanding a huge value doesn't double the DOM.
  const rowTitle = view.tooltip ?? (view.label.length <= 1024 ? view.label : undefined);
  // While filtering, hide a non-matching LEAF — collapsible branches stay so you can drill in to
  // search deeper (laziness: only loaded nodes are searchable; expanding loads more).
  if (q !== '' && !matches && !view.collapsible) return null;

  const load = async () => {
    if (children !== null) return;
    setLoading(true);
    try {
      const c = await node.getChildren();
      setChildren(c);
      setFailed(false);
    } catch (e) {
      setChildren([]);
      setFailed(true);
      console.error('[tree] getChildren failed', e);
    } finally {
      setLoading(false);
    }
  };

  const toggle = async () => {
    if (!view.collapsible) return;
    if (!expanded) await load();
    setExpanded((e) => !e);
  };

  // A node that STARTS expanded has to load its children itself — the load used to live inside
  // `toggle()`, so `expanded: true` rendered an open node with nothing under it until it was
  // collapsed and reopened.
  useEffect(() => {
    if (view.collapsible && view.expanded) void load();
    // Mount only: `expanded` is component state from here on, and re-running would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div
        className={`tree-row${view.wrap ? ' tree-row-wrap' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => void toggle()}
        role="treeitem"
        aria-expanded={view.collapsible ? expanded : undefined}
        tabIndex={view.collapsible ? 0 : -1}
        onKeyDown={(e) => { if (view.collapsible && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void toggle(); } }}
      >
        <span className="tree-twisty">
          {view.collapsible ? <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} /> : null}
        </span>
        {view.icon && (
          <span style={{ color: nodeIconColor(node, view.iconColor) }}>
            <Codicon name={view.icon} />
          </span>
        )}
        <span className={`tree-label${matches ? ' tree-match' : ''}`} title={rowTitle}>{view.label}</span>
        {view.description && <span className="muted" style={{ marginLeft: 6 }}>{view.description}</span>}
        {loading && <span className="muted" style={{ marginLeft: 6 }}>…</span>}
        {node.termId !== undefined && (
          <button
            className="tree-open-tab tree-reveal"
            title="Reveal this term in the editor"
            aria-label="Reveal in editor"
            onClick={(e) => { e.stopPropagation(); revealTermInEditor(node.termId!); }}
          >
            <Codicon name="go-to-file" />
          </button>
        )}
        {node.dataSource && node.lazyKind && TAB_OPENABLE.has(node.lazyKind) && (
          <button
            className="tree-open-tab"
            title="Open in a lazy explorer tab"
            aria-label="Open in tab"
            onClick={(e) => { e.stopPropagation(); openNodeInTab(node.path ?? [], node.dataSource!, view.label, node.lazyKind as LazyKind); }}
          >
            <Codicon name="link-external" />
          </button>
        )}
      </div>
      {expanded && failed && (
        <div className="tree-row muted" style={{ paddingLeft: 6 + (depth + 1) * 14, color: 'var(--error-fg)' }}>failed to load</div>
      )}
      {expanded && children && children.map((c, i) => <TreeRow key={i} node={c} depth={depth + 1} filter={filter} />)}
    </div>
  );
}

/**
 * Custom async tree. `generation` is the React key so a step/refresh remounts the whole subtree
 * (discarding per-row expansion + node caches). `filter` (optional) highlights matching node
 * labels and hides non-matching leaves among what's loaded.
 */
export function Tree({ roots, generation, filter = '' }: { roots: UplcNode[]; generation: number; filter?: string }) {
  if (roots.length === 0) return <EmptyState title="Nothing to show" compact />;
  return (
    <div key={generation} role="tree" className="tree">
      {roots.map((n, i) => <TreeRow key={i} node={n} depth={0} filter={filter} />)}
    </div>
  );
}
