import { useEffect, useRef, useState } from 'react';
import type * as MonacoT from 'monaco-editor';
import { ensureMonaco, type MonacoNS } from './monaco';
import { currentThemeName } from './theme';
import { setDataFindHandler } from './editor-actions';
import './term-editor.css';

/**
 * Generic read-only Monaco view for data tabs (uplc-data-viewer / plain text).
 * Created once and updated in place via `model.setValue` (mirrors TermEditor) so a content
 * refresh preserves scroll/find state instead of flashing a brand-new editor. Highlighting for
 * `plutus-types-json` comes from the same TextMate bridge as the term editor.
 */
export function CodeView({ content, language }: { content: string; language: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoT.editor.IStandaloneCodeEditor>();
  const monacoRef = useRef<MonacoNS>();
  const [ready, setReady] = useState(false);

  // Create the editor ONCE; [content, language] changes swap the model below.
  useEffect(() => {
    let disposed = false;
    let model: MonacoT.editor.ITextModel | undefined;

    void ensureMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = monaco;
      model = monaco.editor.createModel(content, language);
      const editor = monaco.editor.create(containerRef.current, {
        model,
        readOnly: true,
        glyphMargin: false,
        lineNumbers: 'on',
        minimap: { enabled: false },
        theme: currentThemeName(),
        automaticLayout: true,
        scrollBeyondLastLine: false,
        // 'gutter' marks the caret line in the line-number column only — a "where am I" cue that
        // doesn't paint a full-width band (data tabs have no debug band to compete with anyway).
        renderLineHighlight: 'gutter',
        // Script Context holds single very long values (bech32 addresses, hex policy ids, datum
        // blobs); wrap them so they stay fully visible instead of running off the right edge.
        wordWrap: 'on',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12.5,
      });
      editorRef.current = editor;
      // Tab-bar Find button → open Monaco's native find widget on this view (cleared on dispose).
      setDataFindHandler(() => { editorRef.current?.getAction('actions.find')?.run(); editorRef.current?.focus(); });
      setReady(true);
    });

    return () => {
      disposed = true;
      setDataFindHandler(undefined);
      editorRef.current?.dispose();
      editorRef.current = undefined;
      model?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create once; updates handled below.
  }, []);

  // Content/language changed (or the editor just became ready) → update the model in place
  // (no editor churn, scroll/find preserved).
  useEffect(() => {
    if (!ready) return;
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const model = editor?.getModel();
    if (!editor || !monaco || !model) return;
    if (model.getValue() !== content) model.setValue(content);
    monaco.editor.setModelLanguage(model, language);
  }, [ready, content, language]);

  return (
    <div className="term-editor-wrap">
      <div ref={containerRef} className="term-editor" data-testid="code-view" />
    </div>
  );
}
