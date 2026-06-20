import { useEffect } from 'react';
import { Codicon } from '../components/Codicon';

/**
 * First-run intro. Shown ONCE (persisted via localStorage) and only on a clean entry — see
 * shouldShowWelcome(): a deep-link visit (any `#…`/`?…`) skips it so shared sessions open straight away.
 */
const SEEN_KEY = 'deuplc.welcomeSeen';

/** True only when there are no URL params (clean `…/de-uplc-web/`) and the intro hasn't been seen. */
export function shouldShowWelcome(): boolean {
  try {
    // Never interrupt automation (puppeteer/headless E2E) with the onboarding modal.
    if (navigator.webdriver) return false;
    const hash = window.location.hash;
    const clean = (!hash || hash === '#') && !window.location.search;
    return clean && !localStorage.getItem(SEEN_KEY);
  } catch {
    return false;
  }
}

export function markWelcomeSeen(): void {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
}

const FEATURES: { icon: string; text: string }[] = [
  { icon: 'debug-alt', text: 'Step through CEK execution — over a transaction, a script + context, or a plain UPLC program.' },
  { icon: 'debug-breakpoint', text: 'Set breakpoints (gutter / F9) and inspect the machine state, context, environments and budget at each step.' },
  { icon: 'flame', text: 'See exactly where and why a validator finishes or fails — the failing term is highlighted in the code.' },
  { icon: 'link', text: 'Share a self-contained link that reopens the same session for anyone, no setup needed.' },
];

export function WelcomeModal({ open, onClose, onLoadSample }: {
  open: boolean;
  onClose: () => void;
  onLoadSample: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal welcome-modal" role="dialog" aria-modal="true" aria-label="Welcome to de-uplc" style={{ maxWidth: 540 }}>
        <div className="welcome-brand">
          <span className="welcome-logo"><Codicon name="layers" /></span>
          <div>
            <div className="welcome-title">de-uplc</div>
            <div className="muted" style={{ fontSize: 12.5 }}>A step-debugger for Untyped Plutus Core</div>
          </div>
          <button className="icon-button" title="Close" aria-label="Close" style={{ marginLeft: 'auto' }} onClick={onClose}>
            <Codicon name="close" />
          </button>
        </div>

        <p style={{ fontSize: 13.5, lineHeight: 1.5, margin: '14px 0 12px' }}>
          de-uplc runs Cardano’s on-chain script language (UPLC) right in your browser and lets you
          <strong> walk through evaluation one step at a time</strong> — to understand a validator, or
          to find out why a transaction’s script failed.
        </p>

        <ul className="welcome-features">
          {FEATURES.map((f) => (
            <li key={f.icon}><Codicon name={f.icon} /><span>{f.text}</span></li>
          ))}
        </ul>

        <div className="modal-actions">
          <button className="text-button" onClick={onClose}>Start from scratch</button>
          <button className="text-button welcome-cta" onClick={() => { onClose(); onLoadSample(); }}>
            <Codicon name="run-all" /> Load a sample transaction
          </button>
        </div>
      </div>
    </div>
  );
}
