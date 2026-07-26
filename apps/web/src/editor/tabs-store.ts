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

/** The profiler's report. A SINGLETON tab (fixed id): a second Profile click re-focuses the one
 *  that is open instead of stacking indistinguishable copies of the same report. It carries no
 *  payload — the report lives in the store, so the tab is just a way to look at it. */
export interface ProfileTab {
  kind: 'profile';
  id: typeof PROFILE_TAB;
  title: string;
}

export type Tab = DataTab | NodeTab | ProfileTab;

export const TERM_TAB = 'term';
export const PROFILE_TAB = 'profile';

interface TabsState {
  tabs: Tab[];
  activeTabId: string;
  openDataTab: (title: string, content: string, language: string) => void;
  openNodeTab: (title: string, source: DataSource, path: string[], nodeKind: LazyKind) => void;
  /** Open (or re-focus) the profile report. */
  openProfileTab: () => void;
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

  openProfileTab() {
    set((s) => ({
      tabs: s.tabs.some((t) => t.id === PROFILE_TAB)
        ? s.tabs
        : [...s.tabs, { kind: 'profile', id: PROFILE_TAB, title: 'Profile' }],
      activeTabId: PROFILE_TAB,
    }));
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

// ── Find, on the report tab ──────────────────────────────────────────────────────────────────
// The tab bar's Find action means "search what I am looking at". On Monaco tabs that is the find
// widget; on the report it is the row filter, which is an ordinary <input> owned by a lazily
// loaded component. A registration slot keeps `EditorTabs` from having to import that component
// eagerly just to be able to focus its box.

let profileFilterFocus: (() => void) | undefined;

/** Called by the report tab while it is mounted (and with `undefined` on unmount). */
export function setProfileFilterFocus(focus?: () => void): void {
  profileFilterFocus = focus;
}

/** Focus the report's row filter, if the report is mounted. */
export function focusProfileFilter(): void {
  profileFilterFocus?.();
}
