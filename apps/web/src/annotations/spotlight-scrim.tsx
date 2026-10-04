import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type * as MonacoT from 'monaco-editor';
import { HOLE_RADIUS, sameHoles, spotlightArmed, spotlightHoles, type LineRange, type Rect } from './spotlight';

/** The scrim's fade, as annotations.css runs it. */
const FADE_MS = 150;

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

export interface SpotlightArgs {
  editor: MonacoT.editor.IStandaloneCodeEditor | undefined;
  ready: boolean;
  /** The "Spotlight" setting. */
  enabled: boolean;
  /** The focused annotation's lines, if it resolved in this editor. */
  target: LineRange | undefined;
  /** The debugger moved since the last focus move: the scrim steps aside until the next one. */
  quiet: boolean;
  /** Host of the focused annotation's hint card (a content widget of the editor). */
  card: HTMLElement;
}

/**
 * The spotlight scrim: one dark full-page layer over the whole app, with holes for the focused
 * annotation's lines, its hint card and the navigator floating over the editor (the children of
 * `.ann-nav` next to the editor: bar, card, list). While it can show, editor scroll / layout /
 * content-size events and a requestAnimationFrame loop re-measure the holes, and the mask is
 * redrawn only when one moved; the loop stops while the target is out of the viewport and the
 * events wake it again. Returns the portal, to be rendered by the caller.
 */
export function useSpotlight({ editor, ready, enabled, target, quiet, card }: SpotlightArgs): ReactNode {
  const armed = ready && !!editor && spotlightArmed({ enabled, focused: !!target, quiet });
  // The last holes stay while the scrim fades out, so it fades as it was.
  const [scrim, setScrim] = useState<{ holes: Rect[]; shown: boolean }>({ holes: [], shown: false });
  const holesRef = useRef<Rect[] | undefined>();
  const line = target?.line;
  const endLine = target?.endLine;

  useEffect(() => {
    if (!armed || !editor || line === undefined || endLine === undefined) {
      holesRef.current = undefined;
      setScrim((s) => (s.shown ? { ...s, shown: false } : s));
      return;
    }
    const measure = (): Rect[] | undefined => {
      const dom = editor.getDomNode();
      const model = editor.getModel();
      if (!dom || !model) return undefined;
      const rect = rectOf(dom);
      if (rect.w <= 0 || rect.h <= 0) return undefined; // a hidden tab
      const layout = editor.getLayoutInfo();
      const cardEl = card.isConnected ? card.querySelector('.ann-card') : null;
      const nav = editor.getContainerDomNode().parentElement?.querySelectorAll('.ann-nav > *') ?? [];
      return spotlightHoles(
        { line, endLine },
        {
          rect,
          lineCount: model.getLineCount(),
          scrollTop: editor.getScrollTop(),
          topOf: (l) => editor.getTopForLineNumber(l),
          bottomOf: (l) => editor.getBottomForLineNumber(l),
          width: layout.contentLeft + layout.contentWidth,
        },
        cardEl ? rectOf(cardEl) : undefined,
        Array.from(nav, rectOf),
      );
    };
    let frame = 0;
    const tick = () => {
      frame = 0;
      const holes = measure();
      if (!sameHoles(holes, holesRef.current)) {
        holesRef.current = holes;
        setScrim((s) => (holes ? { holes, shown: true } : { ...s, shown: false }));
      }
      if (holes) frame = requestAnimationFrame(tick);
    };
    const wake = () => { if (!frame) frame = requestAnimationFrame(tick); };
    const subs = [
      editor.onDidScrollChange(wake),
      editor.onDidLayoutChange(wake),
      editor.onDidContentSizeChange(wake),
    ];
    window.addEventListener('resize', wake);
    wake();
    return () => {
      cancelAnimationFrame(frame);
      subs.forEach((d) => d.dispose());
      window.removeEventListener('resize', wake);
    };
  }, [armed, editor, line, endLine, card]);

  // A hidden scrim drops its holes once it has faded out; with none left and nothing to track it
  // leaves the page.
  useEffect(() => {
    if (scrim.shown || !scrim.holes.length) return;
    const t = setTimeout(() => setScrim((s) => (s.shown ? s : { holes: [], shown: false })), FADE_MS + 50);
    return () => clearTimeout(t);
  }, [scrim]);

  // `useId` ids carry colons, which a `url(#…)` reference does not take.
  const maskId = `ann-scrim-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (!armed && !scrim.holes.length) return null;
  return createPortal(
    <svg className={`ann-scrim${scrim.shown ? ' is-shown' : ''}`} aria-hidden="true">
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
          <rect width="100%" height="100%" fill="white" />
          {scrim.holes.map((h, i) => (
            <rect key={i} x={h.x} y={h.y} width={h.w} height={h.h} rx={HOLE_RADIUS} fill="black" />
          ))}
        </mask>
      </defs>
      <rect className="ann-scrim-fill" width="100%" height="100%" mask={`url(#${maskId})`} />
    </svg>,
    document.body,
  );
}
