import { useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { useStore } from './store';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSettings, resolveTheme } from './platform/settings';
import { applyMonacoTheme } from './editor/theme';
import { TransportControls } from './panels/TransportControls';
import { SettingsModal } from './panels/SettingsModal';
import { ShareModal } from './panels/ShareModal';
import { Codicon } from './components/Codicon';
import { DebuggerView } from './panels/DebuggerView';
import { resolveUrlLaunch } from './url-launch';

export function App() {
  const load = useStore((s) => s.loadTransaction);
  const loading = useStore((s) => s.loading);
  const locked = useStore((s) => s.locked);
  const scriptOnly = useStore((s) => s.scriptOnly);
  const txId = useStore((s) => s.txId);
  const theme = useSettings((s) => s.theme);
  const [shareOpen, setShareOpen] = useState(false);
  // Shareable when a UPLC script/parts session (scriptOnly) OR a full transaction (txId) is loaded.
  const canShare = scriptOnly || !!txId;
  const setTheme = useSettings((s) => s.set);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Apply the resolved theme to <html> + Monaco; re-resolve when the OS theme changes on 'system'.
  useEffect(() => {
    const apply = () => {
      const resolved = resolveTheme(theme);
      document.documentElement.dataset.theme = resolved;
      applyMonacoTheme(resolved);
    };
    apply();
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);

  // Debug deep-link: if the URL carries a `script` (± context/redeemer/datum/costModels), or a
  // compressed `d` payload, open it in the debugger on first load. Runs once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const launch = await resolveUrlLaunch();
      if (!launch || cancelled) return;
      const s = useStore.getState();
      if (launch.kind === 'program') void s.loadProgram(launch.script, launch.version);
      else if (launch.kind === 'parts') void s.loadProgramParts(launch.parts);
      else {
        // Full transaction: load it, then reopen the shared redeemer (if any) once redeemers exist.
        void (async () => {
          await s.loadTransaction(launch.tx, 'shared-tx.json');
          if (launch.redeemer && !cancelled) void useStore.getState().selectRedeemer(launch.redeemer);
        })();
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadSample = async () => {
    try {
      const txt = await (await fetch(`${import.meta.env.BASE_URL}sample/test-tx.json`)).text();
      await load(txt, 'test-tx.json');
    } catch (e) {
      toast.error(`Failed to load sample: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const showShortcuts = () =>
    toast.info('Keyboard shortcuts', {
      description: 'F9 — toggle breakpoint at the cursor · Ctrl/Cmd+Alt+H — toggle inline hints · Ctrl/Cmd+F — find in term',
    });

  const resolved = resolveTheme(theme);

  return (
    <div className="app-shell">
      <Toaster position="top-right" richColors theme={resolved} />

      {/* brand corner (above the rail) */}
      <div className="app-brand">
        <span className="app-brand-logo" title="de-uplc"><Codicon name="layers" /></span>
      </div>

      {/* top titlebar: title · load + transport · theme/settings */}
      <header className="app-titlebar">
        <h1 className="app-title">de-uplc — web</h1>
        <button className="text-button" disabled={loading || locked} onClick={loadSample}>Load sample</button>
        <TransportControls />
        <div style={{ flex: 1 }} />
        {canShare && (
          <button className="chrome-button" title="Share a link to this session"
            aria-label="Share link" onClick={() => setShareOpen(true)}>
            <Codicon name="link" />
          </button>
        )}
        <button
          className="chrome-button"
          title={`Theme: ${theme} (click to cycle)`}
          aria-label="Toggle theme"
          onClick={() => setTheme('theme', theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light')}
        >
          <Codicon name={resolved === 'dark' ? 'color-mode' : 'lightbulb'} />
        </button>
        <button className="chrome-button" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Codicon name="settings-gear" />
        </button>
      </header>

      {/* left activity rail */}
      <nav className="app-rail" aria-label="Activity">
        <button className="chrome-button is-active" title="Debugger" aria-label="Debugger" aria-pressed="true">
          <Codicon name="debug-alt" />
        </button>
        <span className="rail-spacer" />
        <button className="chrome-button" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={showShortcuts}><Codicon name="question" /></button>
      </nav>

      <ErrorBoundary>
        <div className="app-content">
          <DebuggerView />
        </div>
      </ErrorBoundary>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  );
}
