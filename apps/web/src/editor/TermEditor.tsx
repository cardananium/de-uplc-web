import { useEffect, useRef, useState } from 'react';
import type * as MonacoT from 'monaco-editor';
import { termAtLineForBreakpoint, type TermLocation } from '@de-uplc/core';
import { ensureMonaco, type MonacoNS } from './monaco';
import { currentThemeName } from './theme';
import { setTermFindHandler } from './editor-actions';
import { useStore, revealTermInEditor, type Breakpoint } from '../store';
import { useSettings } from '../platform/settings';
import './term-editor.css';

// ── Inlay hints provider (registered once, reads live store state) ──────────────
// Monaco's InlayHintsProvider is global per language, so we register a single
// provider that reads the Zustand store and re-fires when the inlay UI state
// changes. Mirrors the extension's TermInlayHintsProvider (kind → VS Code kind).

let inlayChangeEmitter: MonacoT.Emitter<void> | undefined;
let inlayRegistered = false;

// The debugger/finished/error trailing comment. Rendered as an inlay hint at the
// end of the current term line: Monaco's decoration injected text (`after`) does
// not render in this build, but the InlayHintsProvider injected text does, and
// it is the same inline-annotation idea as the extension's trailing comment. The
// colour of the state is carried by the whole-line background.
const STATUS_COMMENT: Record<HighlightKind, string> = {
  debugger: ' // Debugger is paused here',
  finished: ' // Execution finished here',
  error: ' // Error occurred here',
};

/** Is the current run an animated playback (stepDelay > 0)? The current term advances each step. */
function isStepThrough(st: ReturnType<typeof useStore.getState>): boolean {
  return st.status === 'running' && useSettings.getState().stepDelay > 0;
}

function debugHighlightKind(st: ReturnType<typeof useStore.getState>): HighlightKind | undefined {
  if (st.finalStatus === 'Done') return 'finished';
  if (st.finalStatus === 'Error') return 'error';
  if (st.status === 'pause' || isStepThrough(st)) return 'debugger';
  return undefined;
}

function registerInlayProvider(monaco: MonacoNS): void {
  if (inlayRegistered) return;
  inlayRegistered = true;
  inlayChangeEmitter = new monaco.Emitter<void>();
  monaco.languages.registerInlayHintsProvider('uplc', {
    onDidChangeInlayHints: inlayChangeEmitter.event,
    provideInlayHints(model, range) {
      const st = useStore.getState();
      const hints: MonacoT.languages.InlayHint[] = [];

      // Term inlay hints (toggleable, per-kind).
      if (st.inlayHintsEnabled) {
        for (const h of st.termHints) {
          if (h.line + 1 < range.startLineNumber || h.line + 1 > range.endLineNumber) continue;
          hints.push({
            position: { lineNumber: h.line + 1, column: h.character + 1 },
            label: h.text,
            kind:
              h.kind === 'term' || h.kind === 'constant_type'
                ? monaco.languages.InlayHintKind.Type
                : monaco.languages.InlayHintKind.Parameter,
            paddingLeft: false,
            paddingRight: true,
          });
        }
      }

      // Debugger/finished/error trailing comment at the current term's line end
      // (always shown, independent of the inlay-hints toggle; -1 / missing guarded). During an
      // animated playback (status 'running') we show only the moving highlight, not a "paused"
      // comment, so the text isn't misleading while it auto-advances.
      const kind = debugHighlightKind(st);
      const line = kind && st.currentTermId !== undefined ? lineForTermId(st.termLocations, st.currentTermId) : undefined;
      if (kind && st.status !== 'running' && line !== undefined && line + 1 >= range.startLineNumber && line + 1 <= range.endLineNumber && line + 1 <= model.getLineCount()) {
        const ln = line + 1;
        hints.push({
          position: { lineNumber: ln, column: model.getLineMaxColumn(ln) },
          label: STATUS_COMMENT[kind],
          paddingLeft: true,
        });
      }

      return { hints, dispose() {} };
    },
  });
}

function fireInlayChange(): void {
  inlayChangeEmitter?.fire();
}

// ── Decoration helpers ──────────────────────────────────────────────────────────

function lineForTermId(locs: TermLocation[], termId: number): number | undefined {
  return locs.find((l) => l.termId === termId)?.startLine;
}

// Horizontal-reveal heuristic: deep UPLC terms sit far right, but we don't want to re-scroll
// horizontally on every step when the term is already comfortably on screen. So we only re-centre
// the term's start column when it is off-screen, sits in the rightmost slice of the viewport, or
// too little of the line-from-its-start is visible.
const REVEAL_RIGHT_SLICE = 1 / 3; // term start in the rightmost third → re-centre
const REVEAL_MIN_VISIBLE = 0.5;   // < 50% of the line-from-start on screen → re-centre

/**
 * Reveal a 0-based term line. Vertically: reveal the line (centred; `ifOutside` only when it's
 * off-screen, to avoid step jitter). Horizontally: nudge the scroll so the term's first character
 * (after its indent) is visible — but ONLY when it's hidden / crammed to the right (see the
 * heuristic above), then centre it. Returns the 1-based start column.
 */
function revealTermLine(
  monaco: MonacoNS,
  editor: MonacoT.editor.IStandaloneCodeEditor,
  model: MonacoT.editor.ITextModel,
  line: number,
  ifOutside: boolean,
): number {
  const ln = line + 1;
  const col = model.getLineFirstNonWhitespaceColumn(ln) || 1;
  // Vertical only — horizontal is handled below so we control the heuristic.
  if (ifOutside) editor.revealLineInCenterIfOutsideViewport(ln);
  else editor.revealLineInCenter(ln);

  const viewW = editor.getLayoutInfo().contentWidth;
  // The term text is monospace, so the content-x of a column is column*charWidth — computed from
  // the font metrics (NOT getOffsetForColumn, which is unreliable until the target line renders).
  const charW = editor.getOption(monaco.editor.EditorOption.fontInfo).spaceWidth || 7;
  if (viewW > 0 && charW > 0) {
    const startX = (col - 1) * charW;                              // content-x of the term start
    const endX = (model.getLineMaxColumn(ln) - 1) * charW;         // content-x of line end
    const scrollLeft = editor.getScrollLeft();
    const viewRight = scrollLeft + viewW;
    const visibleFromStart = Math.max(0, Math.min(endX, viewRight) - Math.max(startX, scrollLeft));
    const visibleFrac = visibleFromStart / Math.min(Math.max(1, endX - startX), viewW);
    const hidden = startX < scrollLeft || startX > viewRight;
    const inRightSlice = startX > scrollLeft + viewW * (1 - REVEAL_RIGHT_SLICE);
    if (hidden || inRightSlice || visibleFrac < REVEAL_MIN_VISIBLE) {
      editor.setScrollLeft(Math.max(0, Math.round(startX - viewW / 2)));
    }
  }
  return col;
}

/** Breakpoint gutter glyphs: a faint ring on every possible line, filled on active/disabled. */
function breakpointDecos(
  monaco: MonacoNS,
  locs: TermLocation[],
  bps: Breakpoint[],
): MonacoT.editor.IModelDeltaDecoration[] {
  const activeLines = new Set<number>();
  const disabledLines = new Set<number>();
  for (const b of bps) {
    const ln = lineForTermId(locs, b.id);
    if (ln === undefined) continue;
    (b.active ? activeLines : disabledLines).add(ln);
  }

  const decos: MonacoT.editor.IModelDeltaDecoration[] = [];
  const seen = new Set<number>();
  for (const loc of locs) {
    const ln = loc.startLine;
    if (seen.has(ln)) continue;
    seen.add(ln);
    const cls = activeLines.has(ln)
      ? 'glyph-bp-active'
      : disabledLines.has(ln)
        ? 'glyph-bp-disabled'
        : 'glyph-bp-possible';
    const hover = activeLines.has(ln)
      ? 'Active breakpoint — click to remove'
      : disabledLines.has(ln)
        ? 'Inactive breakpoint — click to remove'
        : 'Click to toggle a breakpoint here';
    decos.push({
      range: new monaco.Range(ln + 1, 1, ln + 1, 1),
      options: {
        glyphMarginClassName: cls,
        glyphMarginHoverMessage: { value: hover },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
  }
  return decos;
}

type HighlightKind = 'debugger' | 'finished' | 'error';

const LINE_CLASS: Record<HighlightKind, string> = {
  debugger: 'dbg-line',
  finished: 'dbg-finished-line',
  error: 'dbg-error-line',
};

// Terminal states (finished/error) also drop a gutter glyph on the line so where execution
// ended is unmistakable, not just a faint band. The paused/debugger band has no glyph.
const GLYPH_CLASS: Partial<Record<HighlightKind, string>> = {
  finished: 'dbg-finished-glyph',
  error: 'dbg-error-glyph',
};

function highlightDeco(monaco: MonacoNS, line: number, kind: HighlightKind): MonacoT.editor.IModelDeltaDecoration {
  // Whole-line background carries the state colour; the trailing comment is an
  // inlay hint (decoration injected text does not render in this Monaco build).
  const ln = line + 1;
  return {
    range: new monaco.Range(ln, 1, ln, 1),
    options: { isWholeLine: true, className: LINE_CLASS[kind], glyphMarginClassName: GLYPH_CLASS[kind] },
  };
}

// ── Component ────────────────────────────────────────────────────────────────────

/**
 * Resolve, for a 0-based editor line, whether a breakpoint can be placed there
 * (a term starts on the line, matching the gutter dot) and whether one is
 * already set on that term. Reads live store state so the right-click menu and
 * the gutter agree. `set` is only meaningful when `possible` is true.
 */
function breakpointStateAtLine(line: number): { possible: boolean; set: boolean } {
  const st = useStore.getState();
  const possible = st.termLocations.some((loc) => loc.startLine === line);
  if (!possible) return { possible: false, set: false };
  const hit = termAtLineForBreakpoint(line, st.termLocations);
  const set = hit ? st.breakpoints.some((b) => b.id === hit.termId) : false;
  return { possible: true, set };
}

export function TermEditor() {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoT.editor.IStandaloneCodeEditor>();
  const monacoRef = useRef<MonacoNS>();
  const bpDecoRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  const hlDecoRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  const locateDecoRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  // 0-based line under the cursor at the last mousedown — drives the right-click
  // breakpoint action so it acts on the clicked line, not the caret.
  const ctxLineRef = useRef<number | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  const termText = useStore((s) => s.termText);
  const termLocations = useStore((s) => s.termLocations);
  const breakpoints = useStore((s) => s.breakpoints);
  const currentTermId = useStore((s) => s.currentTermId);
  const status = useStore((s) => s.status);
  const finalStatus = useStore((s) => s.finalStatus);
  const inlayHintsEnabled = useStore((s) => s.inlayHintsEnabled);
  const revealRequest = useStore((s) => s.revealRequest);
  const stepDelay = useSettings((s) => s.stepDelay);

  // Create the editor once (lazy-loads Monaco).
  useEffect(() => {
    let disposed = false;
    let editor: MonacoT.editor.IStandaloneCodeEditor | undefined;
    let model: MonacoT.editor.ITextModel | undefined;

    void ensureMonaco().then((monaco) => {
      if (disposed || !containerRef.current) return;
      monacoRef.current = monaco;
      registerInlayProvider(monaco);

      model = monaco.editor.createModel(useStore.getState().termText ?? '', 'uplc', monaco.Uri.parse('inmemory://term/main'));
      editor = monaco.editor.create(containerRef.current, {
        model,
        readOnly: true,
        glyphMargin: true,
        lineNumbers: 'on',
        minimap: { enabled: false },
        theme: currentThemeName(),
        automaticLayout: true,
        scrollBeyondLastLine: false,
        // 'gutter' marks the caret line in the line-number column only — restores a "where's my
        // caret" cue when the user clicks a line to read, WITHOUT a full-width band that would fight
        // the debug/finished/error band's full-line tint + left accent rail.
        renderLineHighlight: 'gutter',
        guides: { indentation: true, highlightActiveIndentation: false },
        padding: { top: 8, bottom: 8 },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 20,
      });
      editorRef.current = editor;
      bpDecoRef.current = editor.createDecorationsCollection();
      hlDecoRef.current = editor.createDecorationsCollection();
      locateDecoRef.current = editor.createDecorationsCollection();

      // Tab-bar search button → open Monaco's find widget (cleared on dispose).
      setTermFindHandler(() => { editorRef.current?.getAction('actions.find')?.run(); editorRef.current?.focus(); });
      // Status-bar Ln/Col follows the caret.
      editor.onDidChangeCursorPosition((e) => setCursor({ line: e.position.lineNumber, col: e.position.column }));

      // Right-click context menu → "Add/Remove Breakpoint", shown only on lines
      // where a breakpoint can be placed (a term starts there, like the gutter dot).
      // mousedown fires before the contextmenu event, so the context keys are set by
      // the time Monaco builds the menu.
      const bpPossibleCtx = editor.createContextKey<boolean>('uplcBreakpointPossible', false);
      const bpSetCtx = editor.createContextKey<boolean>('uplcBreakpointSet', false);
      editor.addAction({
        id: 'uplc.addBreakpoint',
        label: 'Add Breakpoint',
        contextMenuGroupId: 'debug',
        contextMenuOrder: 1,
        precondition: 'uplcBreakpointPossible && !uplcBreakpointSet',
        run: () => { if (ctxLineRef.current !== undefined) useStore.getState().toggleBreakpointAtLine(ctxLineRef.current); },
      });
      editor.addAction({
        id: 'uplc.removeBreakpoint',
        label: 'Remove Breakpoint',
        contextMenuGroupId: 'debug',
        contextMenuOrder: 1,
        precondition: 'uplcBreakpointPossible && uplcBreakpointSet',
        run: () => { if (ctxLineRef.current !== undefined) useStore.getState().toggleBreakpointAtLine(ctxLineRef.current); },
      });

      // Gutter click → toggle breakpoint at that line. Every mousedown (incl. the
      // right-click that opens the context menu) records the line and refreshes the
      // breakpoint context keys so the menu reflects the clicked line.
      editor.onMouseDown((e) => {
        const line = e.target.position ? e.target.position.lineNumber - 1 : undefined;
        ctxLineRef.current = line;
        const { possible, set } = line !== undefined ? breakpointStateAtLine(line) : { possible: false, set: false };
        bpPossibleCtx.set(possible);
        bpSetCtx.set(set);
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && line !== undefined) {
          useStore.getState().toggleBreakpointAtLine(line);
        }
      });
      // F9 → toggle breakpoint at cursor; Ctrl/Cmd+Alt+H → toggle inlay hints. (Editor-focus scoped.)
      editor.addCommand(monaco.KeyCode.F9, () => {
        const ln = editorRef.current?.getPosition()?.lineNumber;
        if (ln) useStore.getState().toggleBreakpointAtLine(ln - 1);
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH, () => {
        useStore.getState().toggleInlayHints();
      });

      setReady(true);
    });

    return () => {
      disposed = true;
      setTermFindHandler(undefined);
      editor?.dispose();
      model?.dispose();
      editorRef.current = undefined;
    };
  }, []);

  // Term text changed (new session) → replace model contents.
  useEffect(() => {
    if (!ready) return;
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== (termText ?? '')) {
      model.setValue(termText ?? '');
    }
  }, [ready, termText]);

  // Breakpoint glyphs depend on locations + breakpoints (+ termText reset).
  useEffect(() => {
    if (!ready || !monacoRef.current || !bpDecoRef.current) return;
    bpDecoRef.current.set(breakpointDecos(monacoRef.current, termLocations, breakpoints));
  }, [ready, termText, termLocations, breakpoints]);

  // Debugger / finished / error line highlight + reveal, driven by currentTermId + state.
  useEffect(() => {
    if (!ready || !monacoRef.current || !editorRef.current || !hlDecoRef.current) return;
    const model = editorRef.current.getModel();
    const line = currentTermId !== undefined ? lineForTermId(termLocations, currentTermId) : undefined;
    // Slow playback (status 'running' + stepDelay) shows the moving debugger highlight too.
    const kind: HighlightKind | undefined =
      finalStatus === 'Done' ? 'finished' : finalStatus === 'Error' ? 'error'
        : (status === 'pause' || (status === 'running' && stepDelay > 0)) ? 'debugger' : undefined;
    // The trailing comment rides the inlay provider, so refresh it whichever way this goes.
    fireInlayChange();
    if (!model || line === undefined || line + 1 > model.getLineCount() || !kind) {
      hlDecoRef.current.clear();
      return;
    }
    hlDecoRef.current.set([highlightDeco(monacoRef.current, line, kind)]);
    // Reveal vertically AND horizontally (deep terms sit far right) — only if off-screen,
    // so single-stepping through nearby terms doesn't jitter the viewport.
    revealTermLine(monacoRef.current, editorRef.current, model, line, true);
  }, [ready, currentTermId, status, finalStatus, termLocations, stepDelay]);

  // Inlay UI toggles → ask Monaco to re-query the provider.
  useEffect(() => {
    if (!ready) return;
    fireInlayChange();
  }, [ready, inlayHintsEnabled]);

  // "Reveal in editor" request from an inspector tree row: scroll the term's line into view,
  // move the caret there, and flash a transient highlight (cleared after the flash). The nonce
  // in revealRequest lets a repeat click on the same term re-trigger this. Runs once ready, so a
  // request made while the Term tab was inactive still applies when the editor mounts.
  useEffect(() => {
    if (!ready || !revealRequest || !monacoRef.current || !editorRef.current || !locateDecoRef.current) return;
    const editor = editorRef.current;
    const model = editor.getModel();
    const line = lineForTermId(termLocations, revealRequest.termId);
    if (!model || line === undefined || line + 1 > model.getLineCount()) return;
    const ln = line + 1;
    // Explicit reveal → center the term both vertically and horizontally, then drop the caret
    // on the term's first character (not column 1) so it's where the eye lands.
    const col = revealTermLine(monacoRef.current, editor, model, line, false);
    editor.setPosition({ lineNumber: ln, column: col });
    locateDecoRef.current.set([
      { range: new monacoRef.current.Range(ln, 1, ln, 1), options: { isWholeLine: true, className: 'term-locate-line' } },
    ]);
    const t = setTimeout(() => locateDecoRef.current?.clear(), 1400);
    return () => clearTimeout(t);
  }, [ready, revealRequest, termLocations]);

  // Current debug term line (distinct from the caret Ln/Col) — shown in the status bar while
  // paused/finished/error so the readout doesn't contradict the highlighted line.
  const dbgLine = currentTermId !== undefined ? lineForTermId(termLocations, currentTermId) : undefined;
  const dbgState = finalStatus === 'Done' ? { label: 'finished', cls: 'sb-done' }
    : finalStatus === 'Error' ? { label: 'error', cls: 'sb-error' }
      : status === 'pause' ? { label: 'paused', cls: 'sb-paused' }
        : (status === 'running' && stepDelay > 0) ? { label: 'running', cls: 'sb-paused' }
          : undefined;

  return (
    <div className="term-pane">
      <div className="term-editor-wrap">
        <div ref={containerRef} className="term-editor" data-testid="term-editor" />
        {!termText && <div className="term-editor-empty">Select a redeemer to view the term</div>}
      </div>
      <div className="editor-statusbar">
        <span className="sb-hint">Click the gutter or press F9 to toggle a breakpoint · Ctrl/Cmd+Alt+H toggles inline hints</span>
        <span className="sb-spacer" />
        {dbgState && (
          // When execution ended on a real source term (dbgLine set), name it and re-reveal on
          // click. A run that reduced to a bare constant has no source position — still show the
          // finished/error pill (label only) so completion is never silent.
          dbgLine !== undefined ? (
            <button
              className={`sb-item sb-item-btn ${dbgState.cls}`}
              title={`Execution ${dbgState.label} on term ${currentTermId} (line ${dbgLine + 1}) — click to reveal`}
              onClick={() => currentTermId !== undefined && revealTermInEditor(currentTermId)}
            >
              ● {dbgState.label} · term {currentTermId} · Ln {dbgLine + 1}
            </button>
          ) : (
            <span className={`sb-item ${dbgState.cls}`} title={`Execution ${dbgState.label} (result has no source term)`}>
              ● {dbgState.label}
            </span>
          )
        )}
        <span className="sb-item">Ln {cursor.line}, Col {cursor.col}</span>
        <span className="sb-item">UTF-8</span>
      </div>
    </div>
  );
}
