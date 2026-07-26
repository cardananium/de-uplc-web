import { lazy, Suspense, useEffect, useRef } from 'react';
import { useStore } from '../store';
import { useTabsStore, focusProfileFilter, TERM_TAB, type Tab } from '../editor/tabs-store';
import { NodeExplorer } from '../editor/NodeExplorer';
import { triggerTermFind, triggerDataFind } from '../editor/editor-actions';
import { Codicon } from '../components/Codicon';
import { EmptyState } from '../components/EmptyState';

// Lazy so the Monaco + vscode-textmate chunk loads only when an editor first mounts.
const TermEditor = lazy(() => import('../editor/TermEditor').then((m) => ({ default: m.TermEditor })));
const CodeView = lazy(() => import('../editor/CodeView').then((m) => ({ default: m.CodeView })));
const ProfileTab = lazy(() => import('./profile/ProfileTab').then((m) => ({ default: m.ProfileTab })));

const EditorFallback = () => <EmptyState title="Loading editor…" />;

const TAB_ICON: Record<Tab['kind'], string> = { data: 'json', node: 'list-tree', profile: 'graph' };

/**
 * App tab bar + editor content area. The Term tab hosts the Monaco term editor;
 * data tabs (Script Context, …) host a read-only CodeView. Mirrors the
 * extension's tab group, but app-managed.
 */
export function EditorTabs() {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  const setActive = useTabsStore((s) => s.setActive);
  const closeTab = useTabsStore((s) => s.closeTab);
  const termText = useStore((s) => s.termText);

  const activeData = activeTabId === TERM_TAB ? undefined : tabs.find((t) => t.id === activeTabId);
  const termActive = activeTabId === TERM_TAB;
  const termWrap = useRef<HTMLDivElement>(null);

  // `inert` is set imperatively: React 18's typings have no such attribute, and this is the one
  // place that needs it — a hidden-but-mounted 41k-line editor must leave the accessibility tree,
  // find-in-page and the tab order.
  useEffect(() => {
    const el = termWrap.current;
    if (!el) return;
    if (termActive) {
      el.removeAttribute('inert');
      el.removeAttribute('aria-hidden');
    } else {
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    }
  }, [termActive]);

  // Find is available on the Term tab, on data (Monaco CodeView) tabs, and on the profile report —
  // where it means "focus the row filter", not Monaco's find widget. NOT on node-explorer tabs
  // (those aren't Monaco editors; they have their own search box).
  const findTrigger = termActive
    ? (termText ? triggerTermFind : undefined)
    : activeData?.kind === 'data' ? triggerDataFind
      : activeData?.kind === 'profile' ? focusProfileFilter
        : undefined;

  return (
    <div className="panel">
      <div className="tabbar" role="tablist">
        <button
          id="tab-term"
          className={`tab${termActive ? ' active' : ''}`}
          role="tab"
          aria-selected={termActive}
          aria-controls="editor-tabpanel"
          onClick={() => setActive(TERM_TAB)}
        >
          <Codicon name="symbol-structure" />
          Script
        </button>
        {tabs.map((t) => (
          // The span is presentational scaffolding (the role="tab" is the inner label button); the
          // close button must NOT be a child of the tablist, so the span is role="presentation".
          <span key={t.id} role="presentation" className={`tab${activeTabId === t.id ? ' active' : ''}`}>
            <button
              id={`tab-${t.id}`}
              className="tab-label"
              role="tab"
              aria-selected={activeTabId === t.id}
              aria-controls="editor-tabpanel"
              onClick={() => setActive(t.id)}
            >
              <Codicon name={TAB_ICON[t.kind]} />
              {t.title}
            </button>
            <button className="tab-close" title="Close tab" aria-label={`Close ${t.title}`} onClick={() => closeTab(t.id)}>
              <Codicon name="close" />
            </button>
          </span>
        ))}
        {findTrigger && (
          <div className="tabbar-actions">
            <button className="tabbar-action" title="Find (Ctrl/Cmd+F)" aria-label="Find" onClick={findTrigger}>
              <Codicon name="search" />
            </button>
          </div>
        )}
      </div>
      <div
        className="tab-content"
        role="tabpanel"
        id="editor-tabpanel"
        aria-labelledby={termActive ? 'tab-term' : `tab-${activeTabId}`}
      >
        {/*
          The Script tab stays MOUNTED and is hidden with `display: none` — it is never unmounted by
          a tab switch. `TermEditor`'s cleanup disposes the editor, the model and every decoration
          collection, so the profiler's main loop (hot line → report → back) would pay a full
          `editor.create` plus a TextMate tokenisation of 41k lines in both directions, and lose the
          scroll position each way. `TermEditor` subscribes to `activeTabId` itself and re-layouts
          when it becomes visible.

          `<TermEditor/>` is mounted UNCONDITIONALLY, term or no term. Every
          `loadTransaction` / `loadProgram` / `loadProgramParts` / `selectRedeemer` sets
          `termText: undefined` before the new term arrives, so a `termText ? … : placeholder`
          ternary here would destroy and re-create the editor on every single load — exactly the
          cost this whole arrangement exists to avoid. The empty state is drawn by `TermEditor` as
          an OVERLAY on the editor instead. The price is that the Monaco chunk now loads with the
          first paint rather than with the first session; the editor is created once for the life of
          the page in exchange.

          Hidden means hidden: `inert` + `aria-hidden` keep a 41k-line term out of the accessibility
          tree, out of the browser's find-in-page and out of the tab order.

          Each tab gets its OWN <Suspense>: with one boundary for the whole panel, the first lazy
          import of `ProfileTab` would suspend the already-mounted `TermEditor` with it and replace
          the editor with the fallback.
        */}
        <div ref={termWrap} style={{ display: termActive ? 'contents' : 'none' }}>
          <Suspense fallback={<EditorFallback />}>
            <TermEditor />
          </Suspense>
        </div>

        {!termActive && (
          <Suspense fallback={<EditorFallback />}>
            {(() => {
              if (!activeData) return <EmptyState title="This tab was closed." />;
              switch (activeData.kind) {
                case 'node':
                  return <NodeExplorer source={activeData.source} path={activeData.path} nodeKind={activeData.nodeKind} label={activeData.title} />;
                case 'data':
                  return <CodeView content={activeData.content} language={activeData.language} />;
                case 'profile':
                  return <ProfileTab />;
                default: {
                  const _x: never = activeData;
                  return null;
                }
              }
            })()}
          </Suspense>
        )}
      </div>
    </div>
  );
}
