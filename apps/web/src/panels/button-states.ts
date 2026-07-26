/**
 * Single source of truth for the control-panel button enable/disable + icon, ported from the
 * VS Code panel's `updateButtonStates` (debugger-panel-view-provider.ts:863-908) and reconciled
 * with the body.<state> CSS. The webview had this logic duplicated between CSS and JS; here it
 * is one pure table, unit-tested cell-by-cell (button-states.test.ts).
 */
export type SessionState = 'empty' | 'stopped' | 'running' | 'pause';
export type MainIcon = 'start' | 'pause' | 'continue';

export interface ButtonStates {
  /** Icon shown on the toggle-main button. */
  mainIcon: MainIcon;
  toggleMain: boolean; // enabled?
  step: boolean;
  refresh: boolean;
  stop: boolean;
  showContext: boolean;
  /**
   * Whether profiling can be STARTED in this state. `pause` is true on purpose: the profile runner
   * builds its OWN machine from the entry term, so it never touches the paused debug session. The
   * one hard no is `running` — there is a single worker and the run already owns it. (The caller
   * additionally requires `!locked` and something runnable, the same predicate that gates Start.)
   */
  profile: boolean;
  /** Whether the budget section is shown for this state (running/pause). */
  budgetVisible: boolean;
  /** Whether budget values render as the "—" placeholder (mid-run, values not queried). */
  budgetLoading: boolean;
}

export function buttonStates(state: SessionState): ButtonStates {
  switch (state) {
    case 'empty':
      return { mainIcon: 'start', toggleMain: false, step: false, refresh: false, stop: false, showContext: false, profile: false, budgetVisible: false, budgetLoading: false };
    case 'stopped':
      return { mainIcon: 'start', toggleMain: true, step: false, refresh: false, stop: false, showContext: true, profile: true, budgetVisible: false, budgetLoading: false };
    case 'running':
      return { mainIcon: 'pause', toggleMain: true, step: false, refresh: true, stop: true, showContext: true, profile: false, budgetVisible: true, budgetLoading: true };
    case 'pause':
      return { mainIcon: 'continue', toggleMain: true, step: true, refresh: true, stop: true, showContext: true, profile: true, budgetVisible: true, budgetLoading: false };
  }
}

/** What the toggle-main button does in each state (null = disabled / no-op). */
export function toggleMainAction(state: SessionState): 'start' | 'pause' | 'continue' | null {
  switch (state) {
    case 'stopped': return 'start';
    case 'running': return 'pause';
    case 'pause': return 'continue';
    case 'empty': return null;
  }
}

/** Codicon class for each main-button icon. */
export function mainIconClass(icon: MainIcon): string {
  return { start: 'codicon-debug-start', pause: 'codicon-debug-pause', continue: 'codicon-debug-continue' }[icon];
}

// --- status badge (titlebar pill) ------------------------------------------
export type BadgeTone = 'idle' | 'running' | 'paused' | 'done' | 'error';
export interface StatusBadgeInfo { label: string; tone: BadgeTone; icon: string; }

/** Map (run state × terminal result) → a coloured status badge (label + icon + tone). */
export function statusBadge(state: SessionState, finalStatus?: 'Done' | 'Error'): StatusBadgeInfo {
  if (state === 'running') return { label: 'Running', tone: 'running', icon: 'loading' };
  if (state === 'pause') return { label: 'Paused', tone: 'paused', icon: 'debug-pause' };
  if (state === 'stopped' && finalStatus === 'Done') return { label: 'Finished', tone: 'done', icon: 'pass' };
  if (state === 'stopped' && finalStatus === 'Error') return { label: 'Error', tone: 'error', icon: 'error' };
  if (state === 'stopped') return { label: 'Ready', tone: 'idle', icon: 'circle-large-outline' };
  return { label: 'No session', tone: 'idle', icon: 'circle-large-outline' };
}

// --- redeemer helpers (ported from the panel) ------------------------------
export const CHOOSE_REDEEMER = 'Choose redeemer';
export const NO_REDEEMERS_AVAILABLE = 'No redeemers available';

/** Build the <select> option list: prepend "Choose redeemer" when real redeemers exist. */
export function redeemerOptions(redeemers: string[]): string[] {
  return redeemers.length ? [CHOOSE_REDEEMER, ...redeemers] : [NO_REDEEMERS_AVAILABLE];
}

/** A concrete redeemer is anything that isn't one of the two sentinels. */
export function isConcreteRedeemer(r: string | undefined | null): r is string {
  return !!r && r !== CHOOSE_REDEEMER && r !== NO_REDEEMERS_AVAILABLE;
}

/** Compare two redeemer lists ignoring the ephemeral "Choose redeemer" option (ported verbatim). */
export function compareRedeemerLists(list1?: string[], list2?: string[]): boolean {
  if (list1 === list2) return true;
  if (!list1 || !list2) return false;
  const f1 = new Set(list1.filter((r) => r !== CHOOSE_REDEEMER));
  const f2 = new Set(list2.filter((r) => r !== CHOOSE_REDEEMER));
  if (f1.size !== f2.size) return false;
  for (const r of f1) if (!f2.has(r)) return false;
  return true;
}
