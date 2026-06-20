import { create } from 'zustand';
import type { DataSource, LazyKind } from '@de-uplc/core';

// App-managed editor tab bar, replacing the extension's vscode.window.tabGroups.
// The "Term" tab is implicit (id `term`, always present). Opened tabs are either:
//  - `data`: a read-only Monaco view of a fixed string (Show context, script source);
//  - `node`: a LAZY node explorer rooted at a tree node's handle (navigates on demand
//    instead of dumping the whole subtree as JSON).

export interface DataTab {
  kind: 'data';
  id: string;
  title: string;
  content: string;
  /** Monaco language id, e.g. 'plutus-types-json' | 'plaintext'. */
  language: string;
}

export interface NodeTab {
  kind: 'node';
  id: string;
  title: string;
  /** Lazy handle: which machine tree, the absolute path, and the cursor kind to re-root with. */
  source: DataSource;
  path: string[];
  nodeKind: LazyKind;
}

export type Tab = DataTab | NodeTab;

export const TERM_TAB = 'term';

interface TabsState {
  tabs: Tab[];
  activeTabId: string;
  openDataTab: (title: string, content: string, language: string) => void;
  openNodeTab: (title: string, source: DataSource, path: string[], nodeKind: LazyKind) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
  /** Drop all tabs and re-focus the term (on new tx / redeemer change). */
  reset: () => void;
}

let seq = 0;

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeTabId: TERM_TAB,

  openDataTab(title, content, language) {
    set((s) => {
      // Dedup by title: repeat "Show context" clicks re-focus (and refresh) the one tab instead of
      // stacking indistinguishable duplicates that each retain a full copy of the (large) content.
      const existing = s.tabs.find((t) => t.kind === 'data' && t.title === title);
      if (existing) {
        return {
          tabs: s.tabs.map((t) => (t.id === existing.id ? { ...t, content, language } : t)),
          activeTabId: existing.id,
        };
      }
      const id = `data-${++seq}`;
      return { tabs: [...s.tabs, { kind: 'data', id, title, content, language }], activeTabId: id };
    });
  },

  openNodeTab(title, source, path, nodeKind) {
    const id = `node-${++seq}`;
    set((s) => ({ tabs: [...s.tabs, { kind: 'node', id, title, source, path, nodeKind }], activeTabId: id }));
  },

  closeTab(id) {
    set((s) => ({
      tabs: s.tabs.filter((t) => t.id !== id),
      activeTabId: s.activeTabId === id ? TERM_TAB : s.activeTabId,
    }));
  },

  setActive(id) {
    set({ activeTabId: id });
  },

  reset() {
    set({ tabs: [], activeTabId: TERM_TAB });
  },
}));
