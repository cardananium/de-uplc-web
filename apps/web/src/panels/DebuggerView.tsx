import { useStore } from '../store';
import { Codicon } from '../components/Codicon';
import { TransactionPanel } from './TransactionPanel';
import { MainControlsPanel, BudgetPanel } from './MainControlsPanel';
import { EditorTabs } from './EditorTabs';
import { isConcreteRedeemer } from './button-states';
import {
  MachineStatePanel, MachineContextPanel, EnvironmentsPanel, LogsPanel, BreakpointsPanel,
} from './InspectorPanels';

/** The debugger workspace: persistent error banner + sidebar (tx/session/inspectors) + editor. */
export function DebuggerView() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const errorTone = useStore((s) => s.errorTone);
  const clearError = useStore((s) => s.clearError);
  const currentRedeemer = useStore((s) => s.currentRedeemer);
  const scriptOnly = useStore((s) => s.scriptOnly);
  // The inspector trees are noise until there's a LIVE session: a concrete redeemer (tx mode) or a
  // plain UPLC program (scriptOnly). A tx loaded with no redeemer yet is 'stopped' but session-less.
  const hasSession = status !== 'empty' && (scriptOnly || isConcreteRedeemer(currentRedeemer));

  return (
    <>
      {/* Persistent banner only for engine-crash / load failures (an app-state problem). A plain
          script failure (errorTone 'script') is a normal run result: the toast + the editor's
          highlighted error line already convey it, so no banner. */}
      {error && errorTone !== 'script' && (
        <div className={`app-error app-error--${errorTone ?? 'crash'}`} role="alert">
          <Codicon name="error" />
          <span className="app-error-msg">{error}</span>
          <button className="icon-button" title="Dismiss" aria-label="Dismiss error" onClick={clearError}><Codicon name="close" /></button>
        </div>
      )}
      <div className="app-body">
        {/* Left: transaction + controls + inspectors + logs. Right: the editor. */}
        <aside className="app-sidebar">
          <TransactionPanel />
          <MainControlsPanel />
          <BudgetPanel />
          {hasSession && (
            <>
              <MachineStatePanel />
              <MachineContextPanel />
              <EnvironmentsPanel />
              <BreakpointsPanel />
              <LogsPanel />
            </>
          )}
        </aside>
        <main className="app-main">
          <EditorTabs />
        </main>
      </div>
    </>
  );
}
