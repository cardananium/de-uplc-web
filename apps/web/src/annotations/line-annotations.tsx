import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type * as MonacoT from 'monaco-editor';
import type { MonacoNS } from '../editor/monaco';
import { Codicon } from '../components/Codicon';
import { useSettings } from '../platform/settings';
import type { AnnotationSeverity } from './annotations';
import { dimmedSpans } from './spotlight';
import './annotations.css';

/** One annotation as an editor sees it: a 1-based inclusive line range and what to show there. */
export interface LineMark {
  /** Index of the annotation in its set (stable across re-resolution). */
  index: number;
  line: number;
  endLine: number;
  severity: AnnotationSeverity;
  title: string;
  hint?: string;
}

export const SEVERITY_ICON: Record<AnnotationSeverity, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
};

// Overview-ruler marks take a colour string, not a CSS variable; these sit between the light and
// dark values of the severity tokens so they read on both rulers.
const RULER_COLOR: Record<AnnotationSeverity, string> = {
  error: '#e5484d',
  warning: '#d4a017',
  info: '#3b82f6',
};

/** Markdown-escape plain text for a Monaco hover; single newlines become hard breaks. */
function hoverText(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&').replace(/\n/g, '  \n');
}

function markDecorations(
  monaco: MonacoNS,
  marks: readonly LineMark[],
  focusIndex: number | undefined,
  lineCount: number,
): MonacoT.editor.IModelDeltaDecoration[] {
  const decos: MonacoT.editor.IModelDeltaDecoration[] = [];
  for (const m of marks) {
    if (m.line < 1 || m.line > lineCount) continue;
    const end = Math.min(Math.max(m.line, m.endLine), lineCount);
    const focused = m.index === focusIndex;
    const hover = { value: `**${hoverText(m.title)}**${m.hint ? `\n\n${hoverText(m.hint)}` : ''}` };
    decos.push({
      range: new monaco.Range(m.line, 1, end, 1),
      options: {
        isWholeLine: true,
        className: `ann-line ann-${m.severity}${focused ? ' ann-line-focus' : ''}`,
        hoverMessage: hover,
        overviewRuler: { color: RULER_COLOR[m.severity], position: monaco.editor.OverviewRulerLane.Full },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
    decos.push({
      range: new monaco.Range(m.line, 1, m.line, 1),
      options: {
        glyphMarginClassName: `ann-glyph ann-${m.severity}`,
        glyphMarginHoverMessage: hover,
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Right },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
  }
  return decos;
}

/**
 * The spotlight's decorations: one per run of lines outside every mark and the kept line.
 * Whole-line, so the inline class also covers inlay text at either end of a line. They carry no
 * look of their own — the opacity applies under the container's `data-ann-spotlight`
 * (annotations.css).
 */
function dimDecorations(
  monaco: MonacoNS,
  model: MonacoT.editor.ITextModel,
  marks: readonly LineMark[],
  keepBright: number | undefined,
): MonacoT.editor.IModelDeltaDecoration[] {
  const keep = keepBright === undefined ? [] : [{ line: keepBright, endLine: keepBright }];
  return dimmedSpans(marks, model.getLineCount(), keep).map((s) => ({
    range: new monaco.Range(s.start, 1, s.end, model.getLineMaxColumn(s.end)),
    options: {
      isWholeLine: true,
      inlineClassName: 'ann-dimmed',
      lineNumberClassName: 'ann-dimmed-ln',
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));
}

export interface LineAnnotationsArgs {
  editor: MonacoT.editor.IStandaloneCodeEditor | undefined;
  monaco: MonacoNS | undefined;
  ready: boolean;
  marks: readonly LineMark[];
  /** Annotation index of the focused entry, if it resolved to a mark. */
  focusIndex: number | undefined;
  /** Changes on every focus move — re-opens a closed hint card. */
  focusNonce: number;
  /** `2 / 5`-style position shown in the card header. */
  position: string;
  /** Bumped when the model text changes, so decorations are re-laid on the new text. */
  contentKey: unknown;
  /**
   * A 1-based line the spotlight keeps bright besides the marks: the debugger's current line,
   * which moves with every step. It never turns the spotlight on by itself.
   */
  keepBright?: number;
}

/**
 * Persistent annotation decorations (whole-line band + gutter glyph + overview-ruler mark, hover
 * with the hint), the spotlight that dims every line outside the marks and the kept line while the
 * "dim the rest" setting is on, and, for the focused annotation, a hint card anchored under its
 * range as a Monaco content widget sitting in a view zone of its own height. Returns the card's
 * portal, to be rendered by the caller.
 */
export function useLineAnnotations({
  editor, monaco, ready, marks, focusIndex, focusNonce, position, contentKey, keepBright,
}: LineAnnotationsArgs): ReactNode {
  const decoRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  const dimRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  const [dimmed, setDimmed] = useState(false);
  const spotlight = useSettings((s) => s.annSpotlight);
  const [cardOpen, setCardOpen] = useState(true);
  const host = useMemo(() => {
    const el = document.createElement('div');
    el.className = 'ann-card-host';
    return el;
  }, []);
  const widgetPos = useRef<MonacoT.IPosition | null>(null);
  const widget = useMemo<MonacoT.editor.IContentWidget>(() => ({
    getId: () => 'de-uplc.annotation-card',
    getDomNode: () => host,
    getPosition: () => (widgetPos.current && monaco
      ? {
          position: widgetPos.current,
          // BELOW only: the card always lands in the view zone reserved under the target.
          preference: [monaco.editor.ContentWidgetPositionPreference.BELOW],
        }
      : null),
  }), [host, monaco]);

  useEffect(() => { setCardOpen(true); }, [focusNonce]);

  // Decorations follow the marks, the focus and the text they were resolved against.
  useEffect(() => {
    if (!ready || !editor || !monaco) return;
    decoRef.current ??= editor.createDecorationsCollection();
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    decoRef.current.set(markDecorations(monaco, marks, focusIndex, lineCount));
  }, [ready, editor, monaco, marks, focusIndex, contentKey]);

  // The spotlight's lines follow the marks, the text and the kept line, and are laid down whether
  // or not the setting is on: the setting only flips the container attribute below, so turning it
  // on or off fades the lines already on screen instead of re-rendering them. A debugger step that
  // moves the kept line costs one pass over the marks and a swap of these few ranges.
  useEffect(() => {
    if (!ready || !editor || !monaco) return;
    const model = editor.getModel();
    const decos = model ? dimDecorations(monaco, model, marks, keepBright) : [];
    dimRef.current ??= editor.createDecorationsCollection();
    dimRef.current.set(decos);
    setDimmed(decos.length > 0);
  }, [ready, editor, monaco, marks, contentKey, keepBright]);

  useEffect(() => {
    const el = ready ? editor?.getContainerDomNode() : undefined;
    if (!el || !spotlight || !dimmed) return;
    el.setAttribute('data-ann-spotlight', '');
    return () => el.removeAttribute('data-ann-spotlight');
  }, [ready, editor, spotlight, dimmed]);

  useEffect(() => () => {
    decoRef.current?.clear();
    dimRef.current?.clear();
  }, []);

  const focused = marks.find((m) => m.index === focusIndex);
  const showCard = !!focused && cardOpen;

  const model = ready ? editor?.getModel() : undefined;
  const lineCount = model?.getLineCount() ?? 0;
  // Under the LAST line of the range, so the card never covers the lines it describes.
  const anchorLine = focused && focused.line <= lineCount
    ? Math.min(Math.max(focused.line, focused.endLine), lineCount)
    : undefined;

  // The card's rendered height, measured live (hint length, wrapping, theme fonts).
  const [cardHeight, setCardHeight] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(() => setCardHeight(Math.ceil(host.getBoundingClientRect().height)));
    ro.observe(host);
    return () => ro.disconnect();
  }, [host]);

  // The card widget: added while there is a focused, resolved annotation; moved with the focus.
  useEffect(() => {
    if (!ready || !editor || !monaco) return;
    const m = editor.getModel();
    if (!showCard || anchorLine === undefined || !m || !focused) {
      widgetPos.current = null;
      editor.removeContentWidget(widget);
      return;
    }
    const indent = m.getLineFirstNonWhitespaceColumn(focused.line) || 1;
    widgetPos.current = { lineNumber: anchorLine, column: Math.min(indent, m.getLineMaxColumn(anchorLine)) };
    editor.addContentWidget(widget);
    editor.layoutContentWidget(widget);
  }, [ready, editor, monaco, widget, showCard, anchorLine, focused?.line, focused?.index, contentKey]);

  // A view zone of the card's height after the anchor line: the following lines move down to
  // make room, so the card never hides code. Rebuilt on every anchor / height / text change and
  // removed whenever the card is not shown.
  const zoneRef = useRef<string>();
  useEffect(() => {
    if (!ready || !editor) return;
    editor.changeViewZones((acc) => {
      if (zoneRef.current) acc.removeZone(zoneRef.current);
      zoneRef.current = undefined;
      if (!showCard || anchorLine === undefined || cardHeight <= 0) return;
      zoneRef.current = acc.addZone({
        afterLineNumber: anchorLine,
        heightInPx: cardHeight + 4,
        domNode: document.createElement('div'),
        suppressMouseDown: true,
      });
    });
    editor.layoutContentWidget(widget);
  }, [ready, editor, widget, showCard, anchorLine, cardHeight, contentKey]);

  useEffect(() => () => {
    editor?.removeContentWidget(widget);
    const id = zoneRef.current;
    if (id) editor?.changeViewZones((acc) => acc.removeZone(id));
    zoneRef.current = undefined;
  }, [editor, widget]);

  if (!showCard || !focused) return null;
  return createPortal(
    <HintCard
      severity={focused.severity}
      title={focused.title}
      hint={focused.hint}
      position={position}
      onClose={() => setCardOpen(false)}
    />,
    host,
  );
}

export function HintCard({ severity, title, hint, position, onClose, note }: {
  severity: AnnotationSeverity;
  title: string;
  hint?: string;
  position?: string;
  onClose?: () => void;
  /** A status line under the title, e.g. "not found — …". */
  note?: string;
}) {
  return (
    <div
      className={`ann-card ann-${severity}`}
      role="note"
      // Keep the editor from treating a click or a scroll in the card as its own.
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="ann-card-head">
        <span className="ann-sev-icon"><Codicon name={SEVERITY_ICON[severity]} /></span>
        <span className="ann-card-title">{title}</span>
        {position && <span className="ann-card-pos">{position}</span>}
        {onClose && (
          <button type="button" className="ann-icon-btn" title="Hide this hint (the highlight stays)" aria-label="Hide hint" onClick={onClose}>
            <Codicon name="close" />
          </button>
        )}
      </div>
      {note && <div className="ann-card-note">{note}</div>}
      {hint && <div className="ann-card-hint">{hint}</div>}
    </div>
  );
}
