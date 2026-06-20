import { useRef, useState } from 'react';
import { useStore } from '../store';
import { Codicon } from '../components/Codicon';

// Accept sets differ per mode: a transaction is JSON/CBOR; a bare program is UPLC text or compiled
// Flat/CBOR hex (.plutus etc).
const TX_ACCEPT = '.json,.tx,.cbor,.txt,.bin';
const SCRIPT_ACCEPT = '.uplc,.flat,.cbor,.txt,.hex,.plutus';

type Mode = 'tx' | 'script';

export function TransactionPanel() {
  const load = useStore((s) => s.loadTransaction);
  const loadProgram = useStore((s) => s.loadProgram);
  const loading = useStore((s) => s.loading);
  const locked = useStore((s) => s.locked);
  const fileName = useStore((s) => s.fileName);
  const txId = useStore((s) => s.txId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [paste, setPaste] = useState('');
  // The active micro-tab drives BOTH inputs (file + paste): a transaction (full tx context) vs. a
  // plain UPLC program loaded with no context (`lang` picks the Plutus version: builtins + cost model).
  const [mode, setMode] = useState<Mode>('tx');
  const [lang, setLang] = useState('V3');
  const busy = loading || locked;
  const scriptMode = mode === 'script';

  // A dropped/opened file is loaded according to the active tab.
  const loadFile = async (file: File) => {
    if (scriptMode) await loadProgram(await file.text(), lang);
    else await load(await file.text(), file.name);
  };

  const loadPaste = async () => {
    const src = paste.trim();
    if (scriptMode) await loadProgram(src, lang);
    else await load(src, 'pasted');
    setPaste('');
  };

  return (
    // Dropping a file anywhere on the panel loads it (per the active tab); the whole panel
    // highlights while a file is dragged over it.
    <div
      className={`panel${dragging ? ' panel-drop' : ''}`}
      onDragOver={(e) => { e.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !busy) await loadFile(f);
      }}
    >
      <div className="panel-title-row">
        <div className="panel-title">Input</div>
        <div className="seg" role="tablist" aria-label="Input mode">
          <button role="tab" aria-selected={mode === 'tx'} disabled={busy}
            className={`seg-item${mode === 'tx' ? ' is-active' : ''}`} onClick={() => setMode('tx')}>
            Transaction
          </button>
          <button role="tab" aria-selected={mode === 'script'} disabled={busy}
            className={`seg-item${mode === 'script' ? ' is-active' : ''}`} onClick={() => setMode('script')}>
            UPLC script
          </button>
        </div>
      </div>

      <div className="mc-row" style={{ marginTop: 10 }}>
        <button className="text-button" disabled={busy} onClick={() => inputRef.current?.click()}>
          <Codicon name="folder-opened" /> Open file
        </button>
        <input ref={inputRef} type="file" accept={scriptMode ? SCRIPT_ACCEPT : TX_ACCEPT} style={{ display: 'none' }}
          onChange={async (e) => { const f = e.target.files?.[0]; if (f) await loadFile(f); e.target.value = ''; }} />
        {scriptMode && (
          <select value={lang} onChange={(e) => setLang(e.target.value)} disabled={busy}
            style={{ padding: '4px 6px' }} title="Plutus version — selects the available builtins + cost model">
            <option value="V3">Plutus V3</option>
            <option value="V2">Plutus V2</option>
            <option value="V1">Plutus V1</option>
          </select>
        )}
        {loading && <span className="muted">Loading…</span>}
        {!scriptMode && fileName && <span className="muted">{fileName}</span>}
        {!scriptMode && txId && <span className="muted" title={txId}>txId {txId.slice(0, 12)}…</span>}
      </div>

      <textarea
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder={scriptMode
          ? '(program 1.1.0 (con integer 42))   or   59… (compiled script CBOR hex)'
          : '84a90083…   or   { "transaction": "…", "utxos": [ … ] }'}
        rows={4}
        style={{ width: '100%', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
      <button className="text-button" disabled={busy || paste.trim().length === 0}
        onClick={() => void loadPaste()} style={{ marginTop: 8 }}>
        <Codicon name="run-all" /> {scriptMode ? 'Load script' : 'Load transaction'}
      </button>
    </div>
  );
}
