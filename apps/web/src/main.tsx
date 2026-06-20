import { createRoot } from 'react-dom/client';
import { toast } from 'sonner';
import '@vscode/codicons/dist/codicon.css';
import './theme/tokens.css';
import { App } from './App';
import { useStore, getSession } from './store';
import { useTabsStore } from './editor/tabs-store';
import { useSettings } from './platform/settings';

// Last-resort sink for fire-and-forget rejections (void pullInspectors/syncBreakpoints,
// loadSample, event handlers) — make them visible instead of silently vanishing.
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
  toast.error(`Unexpected error: ${e.reason instanceof Error ? e.reason.message : String(e.reason)}`);
});

// Test hooks for the headless-Chrome M-series verification (and handy in the console).
(window as unknown as { __store: typeof useStore }).__store = useStore;
(window as unknown as { __tabs: typeof useTabsStore }).__tabs = useTabsStore;
(window as unknown as { __settings: typeof useSettings }).__settings = useSettings;
(window as unknown as { __getSession: typeof getSession }).__getSession = getSession;
(window as unknown as { __loadSample: () => Promise<void> }).__loadSample = async () => {
  const txt = await (await fetch(`${import.meta.env.BASE_URL}sample/test-tx.json`)).text();
  await useStore.getState().loadTransaction(txt, 'test-tx.json');
};

createRoot(document.getElementById('root')!).render(<App />);
