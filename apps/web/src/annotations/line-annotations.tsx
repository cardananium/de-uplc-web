import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type * as MonacoT from 'monaco-editor';
import type { MonacoNS } from '../editor/monaco';
import { Codicon } from '../components/Codicon';
import { useSettings } from '../platform/settings';
import type { AnnotationSeverity } from './annotations';
import { useSpotlight } from './spotlight-scrim';
import { CardDrag, offsetTransform, startsDrag } from './card-drag';
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

export interface LineAnnotationsArgs {
  editor: MonacoT.editor.IStandaloneCodeEditor | undefined;
  monaco: MonacoNS | undefined;
  ready: boolean;
  marks: readonly LineMark[];
  /** Annotation index of the focused entry, if it resolved to a mark. */
  focusIndex: number | undefined;
  /** Changes on every focus move — puts a dragged hint card back under its target. */
  focusNonce: number;
  /** `2 / 5`-style position shown in the card header. */
  position: string;
  /** Bumped when the model text changes, so decorations are re-laid on the new text. */
  contentKey: unknown;
  /** The card's ✕: closes the annotations altogether (bands, glyphs, card, navigator, scrim). */
  onClose?: () => void;
  /**
   * The debugger moved (step, run, reset) since the last focus move: the spotlight scrim steps
   * aside, so the execution line is never in the dark. The next focus move brings it back.
   */
  spotlightQuiet?: boolean;
}

/**
 * Persistent annotation decorations (whole-line band + gutter glyph + overview-ruler mark, hover
 * with the hint), for the focused annotation a hint card anchored under its range as a Monaco
 * content widget sitting in a view zone of its own height, and, while the "Spotlight" setting is
 * on, the scrim that darkens the page around that annotation (`useSpotlight`). The card can be
 * dragged by its head to see what is under it (`CardDrag`); the view zone stays under the target.
 * Returns the card's and the scrim's portals, to be rendered by the caller.
 */
export function useLineAnnotations({
  editor, monaco, ready, marks, focusIndex, focusNonce, position, contentKey, onClose, spotlightQuiet = false,
}: LineAnnotationsArgs): ReactNode {
  const decoRef = useRef<MonacoT.editor.IEditorDecorationsCollection>();
  const spotlight = useSettings((s) => s.annSpotlight);
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

  // The card's drag offset, applied as a transform on the widget's DOM node on top of Monaco's
  // placement. Every focus move and every new text puts the card back under its target.
  const [drag] = useState(() => new CardDrag());
  useLayoutEffect(() => {
    if (drag.reset([focusNonce, focusIndex, contentKey])) host.style.transform = '';
    host.classList.remove('is-dragging');
  }, [drag, host, focusNonce, focusIndex, contentKey]);
  const dragHandlers = useMemo(() => {
    const end = (e: PointerEvent<HTMLElement>) => {
      if (!drag.dragging) return;
      drag.end();
      host.classList.remove('is-dragging');
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    };
    return {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        const card = host.querySelector('.ann-card');
        const dom = editor?.getDomNode();
        if (e.button !== 0 || !card || !dom || !editor || !startsDrag(e.target as Element)) return;
        e.preventDefault();
        const r = card.getBoundingClientRect();
        const box = dom.getBoundingClientRect();
        const layout = editor.getLayoutInfo();
        drag.start(
          { x: e.clientX, y: e.clientY },
          { x: r.left, y: r.top, w: r.width, h: r.height },
          // The editor's visible area, scrollbars excluded.
          {
            x: box.left,
            y: box.top,
            w: layout.width - layout.verticalScrollbarWidth,
            h: layout.height - layout.horizontalScrollbarHeight,
          },
        );
        e.currentTarget.setPointerCapture(e.pointerId);
        host.classList.add('is-dragging');
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        if (drag.dragging) host.style.transform = offsetTransform(drag.move({ x: e.clientX, y: e.clientY }));
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
    };
  }, [drag, host, editor]);

  // Decorations follow the marks, the focus and the text they were resolved against.
  useEffect(() => {
    if (!ready || !editor || !monaco) return;
    decoRef.current ??= editor.createDecorationsCollection();
    const lineCount = editor.getModel()?.getLineCount() ?? 0;
    decoRef.current.set(markDecorations(monaco, marks, focusIndex, lineCount));
  }, [ready, editor, monaco, marks, focusIndex, contentKey]);

  useEffect(() => () => decoRef.current?.clear(), []);

  const focused = marks.find((m) => m.index === focusIndex);
  const showCard = !!focused;

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

  const scrim = useSpotlight({
    editor,
    ready,
    enabled: spotlight,
    target: anchorLine === undefined ? undefined : focused,
    quiet: spotlightQuiet,
    card: host,
  });

  return (
    <>
      {showCard && focused && createPortal(
        <HintCard
          severity={focused.severity}
          title={focused.title}
          hint={focused.hint}
          position={position}
          onClose={onClose}
          drag={dragHandlers}
        />,
        host,
      )}
      {scrim}
    </>
  );
}

export interface HintCardDrag {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: (e: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
  onLostPointerCapture: (e: PointerEvent<HTMLElement>) => void;
}

export function HintCard({ severity, title, hint, position, onClose, note, drag }: {
  severity: AnnotationSeverity;
  title: string;
  hint?: string;
  position?: string;
  /** The ✕: closes the annotations altogether. */
  onClose?: () => void;
  /** Pointer handlers that make the head a drag handle. */
  drag?: HintCardDrag;
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
      <div className={`ann-card-head${drag ? ' is-draggable' : ''}`} {...drag}>
        <span className="ann-sev-icon"><Codicon name={SEVERITY_ICON[severity]} /></span>
        <span className="ann-card-title">{title}</span>
        {position && <span className="ann-card-pos">{position}</span>}
        {onClose && (
          <button type="button" className="ann-icon-btn" title="Close annotations" aria-label="Close annotations" onClick={onClose}>
            <Codicon name="close" />
          </button>
        )}
      </div>
      {note && <div className="ann-card-note">{note}</div>}
      {hint && <div className="ann-card-hint">{hint}</div>}
    </div>
  );
}
