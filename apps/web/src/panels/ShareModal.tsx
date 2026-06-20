import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { Codicon } from '../components/Codicon';

type EncodeState =
  | { status: 'encoding' }
  | { status: 'ok'; url: string }
  | { status: 'error'; msg: string };

const sizeLabel = (n: number): string => (n < 1024 ? `${n} chars` : `${(n / 1024).toFixed(1)} KB`);

/**
 * Share dialog: shows the deep-link to the current session and copies it. The URL is built when the
 * dialog opens, so the Copy button writes an ALREADY-BUILT string synchronously on click — that keeps
 * the click's user-activation valid (writeText after the async gzip is what browsers reject), and the
 * link is visible for manual select-and-copy as a fallback.
 */
export function ShareModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const getShareUrl = useStore((s) => s.getShareUrl);
  const [state, setState] = useState<EncodeState>({ status: 'encoding' });
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<HTMLTextAreaElement>(null);

  // Build the link when the dialog opens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ status: 'encoding' });
    setCopied(false);
    getShareUrl()
      .then((url) => {
        if (cancelled) return;
        setState(url
          ? { status: 'ok', url }
          : { status: 'error', msg: 'Nothing to share — load a transaction or UPLC script first.' });
      })
      .catch((e) => { if (!cancelled) setState({ status: 'error', msg: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [open, getShareUrl]);

  // Esc to close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const url = state.status === 'ok' ? state.url : '';

  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — select the field so the user can copy manually.
      urlRef.current?.focus();
      urlRef.current?.select();
    }
  };

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Share link" style={{ maxWidth: 540 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <Codicon name="link" />
          <span style={{ fontWeight: 600, flex: 1 }}>Share link</span>
          <button className="icon-button" title="Close" aria-label="Close" onClick={onClose}><Codicon name="close" /></button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, margin: '0 0 12px' }}>
          A self-contained link to this session — whoever opens it gets the same script / transaction
          (and selected redeemer), no setup needed.
        </p>

        {state.status === 'encoding' && (
          <div className="muted" style={{ padding: '14px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
            <Codicon name="loading" spin /> Building link…
          </div>
        )}
        {state.status === 'error' && (
          <div className="app-error" role="alert" style={{ margin: '4px 0' }}>
            <Codicon name="error" /><span className="app-error-msg">{state.msg}</span>
          </div>
        )}
        {state.status === 'ok' && (
          <>
            <textarea
              ref={urlRef}
              className="share-url"
              readOnly
              value={url}
              rows={4}
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="share-meta">{sizeLabel(url.length)}{url.length > 16000 ? ' · long link, some chat apps may truncate it' : ''}</div>
          </>
        )}

        <div className="modal-actions">
          {state.status === 'ok' && (
            <>
              <a className="text-button" href={url} target="_blank" rel="noopener noreferrer">
                <Codicon name="link-external" /> Open
              </a>
              <button className="text-button share-copy" onClick={() => void copy()}>
                {copied ? <><Codicon name="check" /> Copied</> : <><Codicon name="copy" /> Copy link</>}
              </button>
            </>
          )}
          <button className="text-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
