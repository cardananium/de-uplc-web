import { lazy, Suspense, useRef } from 'react';
import { useDecompiler } from './decompiler-store';
import { DecompilerOptions } from './DecompilerOptions';
import { Codicon } from '../components/Codicon';

// Reuse the read-only Monaco view from the debugger for the rendered output (lazy → Monaco chunk
// loads only when the decompiler is first used).
const CodeView = lazy(() => import('../editor/CodeView').then((m) => ({ default: m.CodeView })));
const EditorFallback = () => <div className="muted" style={{ padding: 24, textAlign: 'center' }}>Loading editor…</div>;

const ACCEPT = '.hex,.txt,.uplc,.flat,.cbor,.plutus';

export function DecompilerView() {
  const input = useDecompiler((s) => s.input);
  const fileName = useDecompiler((s) => s.fileName);
  const setInput = useDecompiler((s) => s.setInput);
  const decompile = useDecompiler((s) => s.decompile);
  const output = useDecompiler((s) => s.output);
  const error = useDecompiler((s) => s.error);
  const loading = useDecompiler((s) => s.loading);
  const elapsedMs = useDecompiler((s) => s.elapsedMs);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = () => void decompile();

  return (
    <div className="app-body" onKeyDown={(e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !loading && input.trim()) {
        e.preventDefault();
        run();
      }
    }}>
      <aside className="app-sidebar">
        <div className="panel">
          <div className="panel-title">Bytecode</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
            <button className="text-button" disabled={loading} onClick={() => inputRef.current?.click()}>
              <Codicon name="folder-opened" /> Open file
            </button>
            <input ref={inputRef} type="file" accept={ACCEPT} style={{ display: 'none' }}
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) setInput((await f.text()).trim(), f.name); e.target.value = ''; }} />
            {fileName && <span className="muted">{fileName}</span>}
          </div>
          <textarea
            className="dc-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste compiled script bytecode — CBOR/Flat hex or a .plutus cborHex string (e.g. 5904ac0100003232…)"
            spellCheck={false}
            rows={6}
            style={{ width: '100%', marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 12 }}
          />
          <button className="text-button dc-run" disabled={loading || input.trim().length === 0} onClick={run} style={{ marginTop: 8 }}>
            {loading ? <><Codicon name="loading" spin /> Decompiling…</> : <><Codicon name="run-all" /> Decompile</>}
          </button>
        </div>
        <DecompilerOptions />
      </aside>

      <main className="app-main">
        <div className="panel dc-output-panel">
          <div className="tabbar" role="tablist">
            <span className="tab active" role="tab" aria-selected="true"><Codicon name="symbol-namespace" /> Decompiled</span>
            {typeof elapsedMs === 'number' && !error && <span className="status-meta" style={{ marginLeft: 'auto' }}>· {elapsedMs} ms</span>}
          </div>
          <div className="tab-content">
            {error ? (
              <div className="app-error" role="alert" style={{ margin: 12 }}>
                <Codicon name="error" />
                <span className="app-error-msg">{error}</span>
              </div>
            ) : output ? (
              <Suspense fallback={<EditorFallback />}>
                <CodeView content={output} language="dehosk" wordWrap="off" />
                <div className="editor-statusbar">
                  <span
                    className="sb-hint"
                    title={'Ctrl/Cmd+click or F12 — jump to definition · Shift+F12 — find all references · '
                      + 'Ctrl/Cmd+Shift+O — go to symbol · Ctrl/Cmd+F — find in the output'}
                  >
                    Ctrl/Cmd+click — jump to definition · Shift+F12 — find references · Ctrl/Cmd+Shift+O — go to symbol
                  </span>
                </div>
              </Suspense>
            ) : (
              <div className="muted" style={{ padding: 24, textAlign: 'center' }}>
                Paste compiled UPLC bytecode and press <strong>Decompile</strong> to render readable Aiken-like pseudocode.
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
