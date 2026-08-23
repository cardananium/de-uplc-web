import { useCallback, useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import { useStore } from './store';
import { useDecompiler } from './decompiler/decompiler-store';
import { getAtPath } from './decompiler/catalogue';
import { buildShareUrl, resolveUrlLaunch } from './url-launch';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useSettings, resolveTheme } from './platform/settings';
import { applyMonacoTheme } from './editor/theme';
import { TransportControls } from './panels/TransportControls';
import { SettingsModal } from './panels/SettingsModal';
import { ShareModal } from './panels/ShareModal';
import { WelcomeModal, shouldShowWelcome, markWelcomeSeen } from './panels/WelcomeModal';
import { GitHubStars } from './components/GitHubStars';
import { Codicon } from './components/Codicon';
import { BusyPhase, BusySpinner, LaunchOverlay, useBusyControl, useBusyIndicator, type LaunchKind } from './components/Busy';
import { DebuggerView } from './panels/DebuggerView';
import { DecompilerView } from './decompiler/DecompilerView';

type AppView = 'debugger' | 'decompiler';

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
  const [view, setView] = useState<AppView>('debugger');
  const debuggerView = view === 'debugger';
  const dcInput = useDecompiler((s) => s.input);
  const dcOptions = useDecompiler((s) => s.options);
  const canShareDecompiler = dcInput.replace(/\s+/g, '').length > 0;
  const shareDecompiler = useCallback(() => {
    const hex = dcInput.replace(/\s+/g, '');
    if (!hex) return Promise.resolve(null);
    const version = typeof getAtPath(dcOptions ?? {}, ['script_version']) === 'string'
      ? (getAtPath(dcOptions ?? {}, ['script_version']) as string)
      : undefined;
    const purpose = typeof getAtPath(dcOptions ?? {}, ['validator_shape', 'purpose']) === 'string'
      ? (getAtPath(dcOptions ?? {}, ['validator_shape', 'purpose']) as string)
      : undefined;
    return buildShareUrl({ kind: 'decompile', script: hex, version, purpose });
  }, [dcInput, dcOptions]);
  // First-run intro: once, and only on a clean entry (no deep-link hash/query). Decided synchronously
  // on first render so a deep-link visit never flashes the welcome before the launch effect runs.
  const [welcomeOpen, setWelcomeOpen] = useState(shouldShowWelcome);
  useEffect(() => { if (welcomeOpen) markWelcomeSeen(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A deep link is opening: which of the three kinds, or null when nothing is launching. Only the
  // effect below ever sets it — a click has a button to spin, a URL has nothing at all.
  const [launching, setLaunching] = useState<LaunchKind | null>(null);
  const [sampleBusy, runSample] = useBusyControl();
  const sampleShown = useBusyIndicator(sampleBusy);

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

  // Deep-link: debugger (`script` / parts / `#d=`) or decompiler (`#decompile=` / `view=decompiler`).
  // Runs once on first load.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const launch = await resolveUrlLaunch();
      if (!launch || cancelled) return;
      setLaunching(launch.kind);
      void (async () => {
        try {
          if (launch.kind === 'decompile') {
            setView('decompiler');
            const dc = useDecompiler.getState();
            dc.setInput(launch.script);
            dc.applyLaunchHints({ version: launch.version, purpose: launch.purpose });
            if (launch.script) await dc.decompile();
            return;
          }
          const s = useStore.getState();
          if (launch.kind === 'program') await s.loadProgram(launch.script, launch.version);
          else if (launch.kind === 'parts') await s.loadProgramParts(launch.parts);
          else {
            await s.loadTransaction(launch.tx, 'shared-tx.json');
            if (launch.redeemer && !cancelled) await useStore.getState().selectRedeemer(launch.redeemer);
          }
        } finally {
          setLaunching(null);
        }
      })();
    })();
    return () => { cancelled = true; };
  }, []);

  const loadSample = () => runSample(async () => {
    try {
      const txt = await (await fetch(`${import.meta.env.BASE_URL}sample/test-tx.json`)).text();
      await load(txt, 'test-tx.json');
    } catch (e) {
      toast.error(`Failed to load sample: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Every key the term editor binds, in one place — this toast is the only surface that names them
  // all, so a key missing here is a key nobody finds.
  const showShortcuts = () =>
    toast.info('Keyboard shortcuts', {
      description: 'F9 — toggle breakpoint at the cursor · Ctrl/Cmd+Alt+H — toggle inline hints · Ctrl/Cmd+F — find in term · F8 / Shift+F8 — next / previous hot node · Ctrl/Cmd+Alt+P — toggle the heat map · Ctrl/Cmd+Alt+U — toggle the inline costs',
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
        <h1 className="app-title">{debuggerView ? 'de-uplc — web' : 'de-uplc — decompiler'}</h1>
        {debuggerView && (
          <>
            <button className="text-button" disabled={loading || locked} onClick={() => void loadSample()}>
              {sampleShown ? <BusySpinner /> : <Codicon name="file-code" />} Load sample
            </button>
            <BusyPhase show={sampleShown} />
            <TransportControls />
          </>
        )}
        <div style={{ flex: 1 }} />
        {((debuggerView && canShare) || (!debuggerView && canShareDecompiler)) && (
          <button className="chrome-button" title="Share a link to this session"
            aria-label="Share link" onClick={() => setShareOpen(true)}>
            <Codicon name="link" />
          </button>
        )}
        <GitHubStars />
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
        <button
          className={`chrome-button${debuggerView ? ' is-active' : ''}`}
          title="Debugger"
          aria-label="Debugger"
          aria-pressed={debuggerView}
          onClick={() => setView('debugger')}
        >
          <Codicon name="debug-alt" />
        </button>
        <button
          className={`chrome-button${!debuggerView ? ' is-active' : ''}`}
          title="Decompiler"
          aria-label="Decompiler"
          aria-pressed={!debuggerView}
          onClick={() => setView('decompiler')}
        >
          <Codicon name="code" />
        </button>
        <span className="rail-spacer" />
        <button className="chrome-button" title="Keyboard shortcuts" aria-label="Keyboard shortcuts" onClick={showShortcuts}><Codicon name="question" /></button>
      </nav>

      <ErrorBoundary>
        <div className="app-content">
          <div style={{ display: debuggerView ? 'contents' : 'none' }}>
            <DebuggerView />
          </div>
          {view === 'decompiler' && <DecompilerView />}
          <LaunchOverlay kind={launching} />
        </div>
      </ErrorBoundary>

      <footer className="app-footer">
        Provided as is, without warranty of any kind. The authors accept no responsibility or
        liability for any use of this tool or its output, by any person or entity, for any
        purpose.
      </footer>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        getUrl={debuggerView ? undefined : shareDecompiler}
        blurb={debuggerView ? undefined : 'A self-contained link to this decompilation — whoever opens it lands on the Decompiler tab with the same bytecode.'}
      />
      <WelcomeModal open={welcomeOpen} onClose={() => setWelcomeOpen(false)} onLoadSample={() => void loadSample()} />
    </div>
  );
}
