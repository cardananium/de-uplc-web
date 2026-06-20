import { useEffect, useRef } from 'react';
import { useSettings, type ThemePref, type TermView } from '../platform/settings';
import { useStore } from '../store';
import { Codicon } from '../components/Codicon';
import { NumberField } from '../components/NumberField';

/** Settings modal: theme, inlay hints, and Koios provider settings (localStorage-backed). */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSettings();
  const inlayHints = useStore((st) => st.inlayHintsEnabled);
  const toggleInlay = useStore((st) => st.toggleInlayHints);
  const termView = useStore((st) => st.termView);
  const setTermView = useStore((st) => st.setTermView);

  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus management: focus the dialog on open, trap Tab inside it, restore focus on close.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const focusables = () => dialogRef.current
      ? [...dialogRef.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      : [];
    (focusables()[0] ?? dialogRef.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prevFocus?.focus?.(); };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1} style={{ maxWidth: 460 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Codicon name="settings-gear" />
          <span style={{ fontWeight: 600, flex: 1 }}>Settings</span>
          <button className="icon-button" title="Close" aria-label="Close settings" onClick={onClose}><Codicon name="close" /></button>
        </div>

        <div className="settings-grid">
          <label htmlFor="set-theme">Theme</label>
          <select id="set-theme" value={s.theme} onChange={(e) => s.set('theme', e.target.value as ThemePref)}>
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>

          <label htmlFor="set-termview">Term rendering</label>
          <select id="set-termview" value={termView} onChange={(e) => setTermView(e.target.value as TermView)}>
            <option value="tree">Debug tree</option>
            <option value="uplc">UPLC (uplc-crate syntax)</option>
          </select>

          <label htmlFor="set-inlay">Inlay hints</label>
          <div>
            <input id="set-inlay" type="checkbox" checked={inlayHints} onChange={toggleInlay} />
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>tree view · also Ctrl/Cmd+Alt+H in the editor</span>
          </div>

          <label htmlFor="set-stepdelay">Step delay (ms)</label>
          <div>
            <NumberField id="set-stepdelay" value={s.stepDelay} min={0} max={5000} step={50} width={90}
              onCommit={(n) => s.set('stepDelay', n)} />
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>pause between machine steps on Run (0 = full speed)</span>
          </div>

          <div className="settings-section">Koios provider</div>

          <label htmlFor="set-network">Default network</label>
          <select id="set-network" value={s.defaultNetwork} onChange={(e) => s.set('defaultNetwork', e.target.value as 'mainnet' | 'preview' | 'preprod')}>
            <option value="mainnet">mainnet</option>
            <option value="preview">preview</option>
            <option value="preprod">preprod</option>
          </select>

          <label htmlFor="set-apikey">API key</label>
          <input id="set-apikey" type="password" value={s.apiKey} placeholder="(optional Bearer token)"
            onChange={(e) => s.set('apiKey', e.target.value)} autoComplete="off" />

          <label htmlFor="set-timeout">Timeout (ms)</label>
          <NumberField id="set-timeout" value={s.timeout} min={1000} step={1000}
            onCommit={(n) => s.set('timeout', n)} />

          <label htmlFor="set-retries">Retry attempts</label>
          <NumberField id="set-retries" value={s.retryAttempts} min={1} max={10}
            onCommit={(n) => s.set('retryAttempts', n)} />
        </div>

        <div className="modal-actions">
          <button className="text-button" onClick={() => s.reset()}>Reset to defaults</button>
          <button className="text-button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
