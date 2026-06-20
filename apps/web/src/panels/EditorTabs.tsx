import { lazy, Suspense } from 'react';
import { useStore } from '../store';
import { useTabsStore, TERM_TAB } from '../editor/tabs-store';
import { NodeExplorer } from '../editor/NodeExplorer';
import { triggerTermFind, triggerDataFind } from '../editor/editor-actions';
import { Codicon } from '../components/Codicon';

// Lazy so the Monaco + vscode-textmate chunk loads only when an editor first mounts.
const TermEditor = lazy(() => import('../editor/TermEditor').then((m) => ({ default: m.TermEditor })));
const CodeView = lazy(() => import('../editor/CodeView').then((m) => ({ default: m.CodeView })));

const EditorFallback = () => <div className="muted" style={{ padding: 24, textAlign: 'center' }}>Loading editor…</div>;

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

  // Find is available on the Term tab and on data (Monaco CodeView) tabs — NOT on node-explorer
  // tabs (those aren't Monaco editors; they have their own search box).
  const findTrigger = activeTabId === TERM_TAB
    ? (termText ? triggerTermFind : undefined)
    : activeData?.kind === 'data' ? triggerDataFind : undefined;

  return (
    <div className="panel">
      <div className="tabbar" role="tablist">
        <button
          id="tab-term"
          className={`tab${activeTabId === TERM_TAB ? ' active' : ''}`}
          role="tab"
          aria-selected={activeTabId === TERM_TAB}
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
              <Codicon name={t.kind === 'node' ? 'list-tree' : 'json'} />
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
        aria-labelledby={activeTabId === TERM_TAB ? 'tab-term' : `tab-${activeTabId}`}
      >
        <Suspense fallback={<EditorFallback />}>
          {activeTabId === TERM_TAB ? (
            // Mount Monaco only once there's a term (i.e. a session) — keeps the
            // heavy editor chunk off the initial page load (plan §lazy-import).
            termText ? (
              <TermEditor />
            ) : (
              <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
                Load a transaction and select a redeemer to view the term
              </div>
            )
          ) : activeData ? (
            activeData.kind === 'node' ? (
              <NodeExplorer source={activeData.source} path={activeData.path} nodeKind={activeData.nodeKind} label={activeData.title} />
            ) : (
              <CodeView content={activeData.content} language={activeData.language} />
            )
          ) : (
            <div className="muted" style={{ padding: 8 }}>(tab closed)</div>
          )}
        </Suspense>
      </div>
    </div>
  );
}
