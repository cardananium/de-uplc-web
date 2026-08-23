import { useEffect, useRef, useState } from 'react';
import type * as MonacoT from 'monaco-editor';
import { termAtLineForBreakpoint, termIndexFor, type TermHintInfo, type TermLocation, type TermView } from '@de-uplc/core';
import { ensureMonaco, type MonacoNS } from './monaco';
import { currentThemeName } from './theme';
import { setTermFindHandler } from './editor-actions';
import { useTabsStore, TERM_TAB } from './tabs-store';
import {
  applyProfileHeat,
  gotoLine,
  hotStatus,
  profileInlayHints,
  profileOutcomeNote,
  registerProfileActions,
  showInProfile,
  LANE_CAP,
  LANE_CAP_NOTE,
} from './useProfileHeat';
import { Codicon } from '../components/Codicon';
import { EmptyState } from '../components/EmptyState';
import { useStore, revealTermInEditor, type Breakpoint } from '../store';
import { useSettings } from '../platform/settings';
import './term-editor.css';

// ── Inlay hints provider (registered once, reads live store state) ──────────────
// Monaco's InlayHintsProvider is global per language, so we register a single
// provider that reads the Zustand store and re-fires when the inlay UI state
// changes. Mirrors the extension's TermInlayHintsProvider (kind → VS Code kind).

let inlayChangeEmitter: MonacoT.Emitter<void> | undefined;
let inlayRegistered = false;

/**
 * `termHints` bucketed by line: `hints[start[ln] … start[ln + 1])` are the hints of 0-based line
 * `ln`. A counting sort, built once, so the provider can answer a viewport query in O(window).
 *
 * This is a PRECONDITION of the profiler's hint block, not an optimisation: Monaco re-queries
 * the provider on every scroll, the serializer pushes 1–3 hints per node, and this loop now shares
 * the call with `profileInlayHints` — a linear scan here would make every scroll frame O(hints).
 */
interface HintIndex {
  hints: readonly TermHintInfo[];
  /** Prefix sums, length `maxLine + 2`; `start[ln + 1] - start[ln]` is line `ln`'s hint count. */
  start: Int32Array;
  maxLine: number;
}

// Memoised on the ARRAY IDENTITY, exactly like `termIndexFor` for locations: the store replaces
// `termHints` in the same `set()` that replaces `termText`/`termLocations`, so identity changes
// precisely when the term is re-rendered and never otherwise.
const HINT_INDEX_CACHE = new WeakMap<readonly TermHintInfo[], HintIndex>();

function hintIndexFor(hints: readonly TermHintInfo[]): HintIndex {
  const cached = HINT_INDEX_CACHE.get(hints);
  if (cached) return cached;
  let maxLine = -1;
  for (const h of hints) if (h.line > maxLine) maxLine = h.line;
  const start = new Int32Array(maxLine + 2);
  for (const h of hints) start[h.line + 1]++;
  for (let i = 1; i < start.length; i++) start[i] += start[i - 1];
  // Stable bucketing: a line's hints keep their document order, which is the order the serializer
  // (and therefore the reading eye) puts them in on the line.
  const cursor = Int32Array.from(start);
  const sorted = new Array<TermHintInfo>(hints.length);
  for (const h of hints) sorted[cursor[h.line]++] = h;
  const index: HintIndex = { hints: sorted, start, maxLine };
  HINT_INDEX_CACHE.set(hints, index);
  return index;
}

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

      // Term inlay hints (toggleable, per-kind). Walked through the per-line index and only over
      // the queried range — the range is the viewport ± one screen (~150 lines), which is what
      // makes a 200k-node term free to scroll.
      // How many characters of Monaco's per-LINE inlay budget the term's own hints already spend.
      // The controller caps the SUM of a line's hint labels (`_MAX_LABEL_LEN`) and truncates the
      // overflow — and the cost hint, being appended last, is what gets cut. Measured on a hot
      // line: `term: ` + `id:15438` = 14 of 43, leaving 29; a `fn: UnConstrData` line leaves 13.
      const used = new Map<number, number>();
      if (st.inlayHintsEnabled && st.termHints.length > 0) {
        const idx = hintIndexFor(st.termHints);
        const first = Math.max(0, range.startLineNumber - 1);
        const last = Math.min(range.endLineNumber - 1, idx.maxLine);
        for (let ln = first; ln <= last; ln++) {
          for (let i = idx.start[ln]; i < idx.start[ln + 1]; i++) {
            const h = idx.hints[i];
            used.set(h.line, (used.get(h.line) ?? 0) + h.text.length);
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
      }

      // Debugger/finished/error trailing comment at the current term's line end
      // (always shown, independent of the inlay-hints toggle; -1 / missing guarded). During an
      // animated playback (status 'running') we show only the moving highlight, not a "paused"
      // comment, so the text isn't misleading while it auto-advances.
      const kind = debugHighlightKind(st);
      const line = kind && st.currentTermId !== undefined ? lineForTermId(st.termLocations, st.termView, st.currentTermId) : undefined;
      let statusLine: number | undefined;
      if (kind && st.status !== 'running' && line !== undefined && line + 1 >= range.startLineNumber && line + 1 <= range.endLineNumber && line + 1 <= model.getLineCount()) {
        const ln = line + 1;
        statusLine = line;
        hints.push({
          position: { lineNumber: ln, column: model.getLineMaxColumn(ln) },
          label: STATUS_COMMENT[kind],
          paddingLeft: true,
        });
      }

      // Per-line costs on hot lines. Last, and told which line the status comment just took: two
      // trailing comments on one line would be a wall of text exactly where the user is stopped.
      hints.push(...profileInlayHints(model, range, statusLine, used));

      return { hints, dispose() {} };
    },
  });
}

// Coalesced to ONE event per commit. Three effects ask for a refresh (the debug highlight, the
// profiler heat, the inlay toggles) and React runs them back to back, so a bare `.fire()` per call
// emitted a burst. Monaco's inlay controller debounces and cancels the in-flight request on each
// event, and a burst could leave the LAST render dropped until some unrelated trigger (a scroll)
// re-queried — the trailing comment then sat stale for many seconds. Measured: a normal refresh
// lands in 3–116 ms; the stall was >8 s in roughly one run in eight. One event per microtask
// removes the burst (and the redundant re-queries with it).
let inlayFirePending = false;
function fireInlayChange(): void {
  if (!inlayChangeEmitter || inlayFirePending) return;
  inlayFirePending = true;
  queueMicrotask(() => {
    inlayFirePending = false;
    inlayChangeEmitter?.fire();
  });
}

// ── Decoration helpers ──────────────────────────────────────────────────────────

/** 0-based start line of a term id, via the memoised index (a linear `.find` here is on the inlay
 *  provider's path, which Monaco re-queries on every scroll). */
function lineForTermId(locs: TermLocation[], view: TermView, termId: number): number | undefined {
  return termIndexFor(locs, view).lineOfTerm(termId);
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
  view: TermView,
  bps: Breakpoint[],
): MonacoT.editor.IModelDeltaDecoration[] {
  const activeLines = new Set<number>();
  const disabledLines = new Set<number>();
  for (const b of bps) {
    const ln = lineForTermId(locs, view, b.id);
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
  const hit = termAtLineForBreakpoint(line, st.termLocations, st.termView);
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
  // The profiler's two collections, kept apart from the three above so a CEK step never touches
  // them and a new profile never touches the debug highlights.
  const laneDecoRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  const rulerDecoRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  // 0-based line under the cursor at the last mousedown — drives the right-click
  // breakpoint action so it acts on the clicked line, not the caret.
  const ctxLineRef = useRef<number | undefined>(undefined);
  // Set once the editor exists: pushes the clicked line into the profile action's context key.
  const syncProfileCtxRef = useRef<(line: number | undefined) => void>();
  // Scroll + selection checkpoint, taken when the Script tab is hidden and restored when it returns
  // (see the visibility effect below).
  const viewState = useRef<MonacoT.editor.ICodeEditorViewState | null>(null);
  const [ready, setReady] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });

  // Is the Script tab the visible one? `EditorTabs` keeps this editor MOUNTED and hides it with
  // `display: none`, so the component has to learn about visibility itself — nothing re-renders it
  // on a tab switch otherwise.
  const active = useTabsStore((s) => s.activeTabId === TERM_TAB);
  const termText = useStore((s) => s.termText);
  const termLocations = useStore((s) => s.termLocations);
  // The view decides how a location's line range is read — the two renderers store `endLine`
  // differently — so every index lookup has to be told which rendering these locations came from.
  const termView = useStore((s) => s.termView);
  const breakpoints = useStore((s) => s.breakpoints);
  const currentTermId = useStore((s) => s.currentTermId);
  const status = useStore((s) => s.status);
  const finalStatus = useStore((s) => s.finalStatus);
  const inlayHintsEnabled = useStore((s) => s.inlayHintsEnabled);
  const revealRequest = useStore((s) => s.revealRequest);
  const stepDelay = useSettings((s) => s.stepDelay);
  // Profiler state, per field like everything else here: a whole-store subscription would re-run
  // this component on every inspector pull, and the heat effect below must not be woken by one.
  const profileIndex = useStore((s) => s.profileIndex);
  const profileMetric = useStore((s) => s.profileMetric);
  const profileScope = useStore((s) => s.profileScope);
  const profileHeat = useStore((s) => s.profileHeat);
  const profileStale = useStore((s) => s.profileStale);
  const profileStatus = useStore((s) => s.profileStatus);
  const profileOutcome = useStore((s) => s.profileOutcome);
  const profileInlay = useSettings((s) => s.profileInlay);

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
        // The `linesDecorations` column is the profiler's cost lane, and it is free only with
        // folding OFF: the folding chevron renders into the same column with a full-size box, adds
        // its own 16px and swallows every mousedown right of x = 4. Nothing to fold in a read-only
        // viewer anyway, and it saves the indent-range provider walking 41k indents.
        folding: false,
        // Off for the same reason, plus one of its own: its render is async, and a term swap that
        // lands mid-render leaves it asking the NEW model for a line of the old one —
        // `getBottomForLineNumber` then throws `Illegal value for lineNumber` out of a promise
        // nothing awaits. Measured: 8 unhandled rejections per profiler e2e run, none after this.
        // A read-only viewer with folding off has nothing to keep on screen anyway.
        stickyScroll: { enabled: false },
        // Fixed for the editor's whole life — never `updateOptions`ed when a profile arrives or is
        // cleared, so the program text does not shift sideways under the user.
        lineDecorationsWidth: 16,
        padding: { top: 8, bottom: 8 },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 12.5,
        lineHeight: 20,
      });
      editorRef.current = editor;
      bpDecoRef.current = editor.createDecorationsCollection();
      hlDecoRef.current = editor.createDecorationsCollection();
      locateDecoRef.current = editor.createDecorationsCollection();
      laneDecoRef.current = editor.createDecorationsCollection();
      rulerDecoRef.current = editor.createDecorationsCollection();
      syncProfileCtxRef.current = registerProfileActions(monaco, editor, () => ctxLineRef.current);

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
        syncProfileCtxRef.current?.(line);
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && line !== undefined) {
          useStore.getState().toggleBreakpointAtLine(line);
        }
        // A click on the cost lane is "Show in profile" — its own hit-target, distinct from the
        // glyph margin above, and reachable at all only because folding is off.
        if (e.target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS && line !== undefined) {
          showInProfile(line);
        }
      });
      // F9 → toggle breakpoint at cursor; Ctrl/Cmd+Alt+H → toggle inlay hints. `addAction`, not
      // `addCommand`: the standalone keybinding service is a page-wide singleton, so an
      // `addCommand` binding fires in every Monaco on the page — these two were reaching the
      // Script Context viewer, where F9 and Alt+H mean nothing.
      editor.addAction({
        id: 'uplc.toggleBreakpointAtCursor',
        label: 'Toggle Breakpoint',
        keybindings: [monaco.KeyCode.F9],
        run: (ed) => {
          const ln = ed.getPosition()?.lineNumber;
          if (ln) useStore.getState().toggleBreakpointAtLine(ln - 1);
        },
      });
      editor.addAction({
        id: 'uplc.toggleInlayHints',
        label: 'Toggle Inline Hints',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyH],
        run: () => useStore.getState().toggleInlayHints(),
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

  // Became visible / hidden. The Script tab is hidden with `display: none`, never unmounted, so
  // Monaco comes back with the layout it had when it was measured — which, coming out of
  // `display: none`, is a zero-height one for a frame: `automaticLayout`'s ResizeObserver fires on
  // the NEXT frame, and that frame is the flash. The explicit `layout()` removes it. The view state
  // is checkpointed on the way out and restored on the way back, because the model survives the
  // round trip but the scroll position is not part of the model.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (active) {
      ed.layout();
      if (viewState.current) ed.restoreViewState(viewState.current);
    } else {
      viewState.current = ed.saveViewState();
    }
  }, [active, ready]);

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
    bpDecoRef.current.set(breakpointDecos(monacoRef.current, termLocations, termView, breakpoints));
  }, [ready, termText, termLocations, breakpoints]);

  // Debugger / finished / error line highlight + reveal, driven by currentTermId + state.
  useEffect(() => {
    if (!ready || !monacoRef.current || !editorRef.current || !hlDecoRef.current) return;
    const model = editorRef.current.getModel();
    const line = currentTermId !== undefined ? lineForTermId(termLocations, termView, currentTermId) : undefined;
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

  // Profiler heat: the cost lane + the overview-ruler marks, in their OWN effect.
  //
  // The deps are the whole point. It must not be folded into the breakpoint or the highlight
  // effect above — those re-run on every CEK step, and this one sets up to 4 000 decorations. It reads
  // the DERIVED `profileIndex`, never `profile`, so a step, a scroll or a scope toggle cannot wake
  // it; `setTermView` writes `termText`, `termLocations` and `profileIndex` in one `set()`, so a
  // render can never see a new text against an old index. `profileScope` and the theme are absent
  // on purpose: the scope only reorders the inlay pair (below), and the ruler's colours are
  // `ThemeColor` ids that Monaco re-resolves itself.
  //
  // `profileHeat: false` and `profileStale` both land as `undefined` here, which clears BOTH
  // collections and (via the provider) the cost hints — and leaves the report, the outcome pill
  // and the hot-list navigation untouched.
  useEffect(() => {
    if (!ready || !monacoRef.current || !editorRef.current || !laneDecoRef.current || !rulerDecoRef.current) return;
    applyProfileHeat(
      monacoRef.current,
      editorRef.current,
      laneDecoRef.current,
      rulerDecoRef.current,
      profileHeat && !profileStale ? profileIndex : undefined,
    );
    fireInlayChange(); // the cost hints ride the provider, so they follow in the same beat
  }, [ready, termText, termLocations, profileIndex, profileMetric, profileHeat, profileStale]);

  // Inlay UI toggles → ask Monaco to re-query the provider. `profileScope` is here and not in the
  // heat effect: it flips the order of the pair in the cost hint and nothing else, so the lane
  // decorations must NOT be rebuilt for it.
  useEffect(() => {
    if (!ready) return;
    fireInlayChange();
  }, [ready, inlayHintsEnabled, profileInlay, profileScope]);

  // "Reveal in editor" request from an inspector tree row: scroll the term's line into view,
  // move the caret there, and flash a transient highlight (cleared after the flash). The nonce
  // in revealRequest lets a repeat click on the same term re-trigger this. Runs once ready, so a
  // request made while the Term tab was inactive still applies when the editor mounts.
  useEffect(() => {
    if (!ready || !revealRequest || !monacoRef.current || !editorRef.current || !locateDecoRef.current) return;
    const editor = editorRef.current;
    const model = editor.getModel();
    const line = lineForTermId(termLocations, termView, revealRequest.termId);
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
  const dbgLine = currentTermId !== undefined ? lineForTermId(termLocations, termView, currentTermId) : undefined;
  const dbgState = finalStatus === 'Done' ? { label: 'finished', cls: 'sb-done' }
    : finalStatus === 'Error' ? { label: 'error', cls: 'sb-error' }
      : status === 'pause' ? { label: 'paused', cls: 'sb-paused' }
        : (status === 'running' && stepDelay > 0) ? { label: 'running', cls: 'sb-paused' }
          : undefined;

  // Where the caret sits in the hot list. Counted on `hotLines` (bucket ≥ 3) — the very list F8
  // walks — so the key and the readout can never disagree about the denominator. It survives
  // `profileHeat: false`: the term's markup is off, the profile is not.
  const hot = profileIndex && !profileStale ? hotStatus(profileIndex, cursor.line - 1) : undefined;
  // A live profile for THIS term — what the status-bar hint announces the profiler keys on. Wider
  // than `hot`, which is empty when nothing reaches 1% while the keys still work.
  const hasProfile = !!profileIndex && !profileStale;
  // The lane cap is a fact about what is on screen, so it is stated on screen, not only in the plan.
  const capped = !!profileIndex && profileHeat && !profileStale && profileIndex.ranked.length > LANE_CAP;
  const outcome = profileOutcomeNote(profileOutcome, profileStatus, !!profileIndex, profileStale);

  return (
    <div className="term-pane">
      <div className="term-editor-wrap">
        <div ref={containerRef} className="term-editor" data-testid="term-editor" />
        {/* An OVERLAY, not a replacement: every load sets `termText: undefined` before the new term
            arrives, and swapping the editor out for a placeholder would dispose the editor, the
            model and all five decoration collections and pay a full `editor.create` plus a TextMate
            tokenisation of 41k lines on the way back. */}
        {!termText && (
          <div className="term-editor-empty">
            <EmptyState
              icon="symbol-structure"
              title="No term to show"
              hint="Load a transaction and select a redeemer, or open a plain UPLC program."
            />
          </div>
        )}
      </div>
      <div className="editor-statusbar">
        {/* The keys worth advertising inline; the rest live in the title and in
            the shortcuts toast (`?` in the title bar). The profiler half appears with a profile for
            THIS term — F8 and Ctrl/Cmd+Alt+P are live either way (they answer with a toast), but
            announcing them with nothing to navigate is noise. It is NOT gated on `hot`: a profile
            whose hottest line sits below 1% has an empty hot list and working keys. */}
        <span
          className="sb-hint"
          title={'F9 — toggle a breakpoint at the cursor · Ctrl/Cmd+F — find in the term · '
            + 'Ctrl/Cmd+Alt+H — inline term hints · Ctrl/Cmd+Alt+U — inline costs · '
            + 'F8 / Shift+F8 — next / previous hot node · Ctrl/Cmd+Alt+P — heat map'}
        >
          F9 breakpoint
          {hasProfile && ' · F8 next hot node · Ctrl/Cmd+Alt+P heat'}
        </span>
        <span className="sb-spacer" />
        {capped && (
          <span className="sb-item" title="The lane paints the hottest lines only; overview-ruler marks are merged into pixel slots, so one mark stands for many lines.">
            {LANE_CAP_NOTE}
          </span>
        )}
        {outcome && (
          // Third copy of the outcome, by design: the numbers behind the heat lane are partial
          // whenever this is here, and a surface that shows the heat without the caveat implies a
          // complete run.
          <span className={`sb-item ${outcome.error ? 'sb-error' : ''}`} title={outcome.title}>{outcome.text}</span>
        )}
        {hot && (
          <button
            className="sb-item sb-item-btn sb-hot"
            title={`Next hot node (F8) · Previous hot node (Shift+F8) — click to jump to the hottest of ${hot.count}`}
            onClick={() => editorRef.current && gotoLine(editorRef.current, hot.topLine)}
          >
            <Codicon name="flame" /> {hot.label}
          </button>
        )}
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
