// The annotation spotlight: while a launch link's annotations are shown, a dark scrim covers the
// whole page except the focused annotation's target lines, its hint card and the navigator.
// Geometry and the visibility rule only — `useSpotlight` (spotlight-scrim.tsx) measures the editor
// and draws the scrim.

/** A rectangle in client (viewport) coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A 1-based inclusive line range, as the editors' marks carry it. */
export type LineRange = { readonly line: number; readonly endLine: number };

/** What the hole geometry needs from an editor; Monaco virtualises lines, so it is all editor API. */
export interface EditorView {
  /** The editor's box in client coordinates: the viewport its lines scroll in. */
  rect: Rect;
  lineCount: number;
  scrollTop: number;
  /** Top of a line from the top of the content (view zones above it included). */
  topOf: (line: number) => number;
  /** Bottom of a line from the top of the content (wrapped rows included, view zones after it not). */
  bottomOf: (line: number) => number;
  /** Width from the editor's left edge to the end of the text area: gutter + content, no scrollbar. */
  width: number;
}

/** Room left around the target lines inside their hole, and the holes' corner radius. */
export const HOLE_PAD = 4;
export const HOLE_RADIUS = 6;

function intersect(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const w = Math.min(a.x + a.w, b.x + b.w) - x;
  const h = Math.min(a.y + a.h, b.y + b.h) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

/**
 * The hole over a target range: its lines across the editor's gutter and text area, padded by
 * `HOLE_PAD`, clipped to the editor's viewport. The range is clamped the way its band is drawn:
 * one starting outside the text has no hole, one running past the last line stops there, and an
 * `endLine` before `line` covers `line` alone. Undefined when none of its lines is in the viewport
 * (the padding alone never makes a hole).
 */
export function targetHole(range: LineRange, view: EditorView): Rect | undefined {
  if (range.line < 1 || range.line > view.lineCount) return undefined;
  const end = Math.min(Math.max(range.line, range.endLine), view.lineCount);
  const top = view.rect.y + view.topOf(range.line) - view.scrollTop;
  const bottom = view.rect.y + view.bottomOf(end) - view.scrollTop;
  const lines = { x: view.rect.x, y: top, w: view.width, h: bottom - top };
  if (!intersect(lines, view.rect)) return undefined;
  const padded = { x: lines.x - HOLE_PAD, y: lines.y - HOLE_PAD, w: lines.w + 2 * HOLE_PAD, h: lines.h + 2 * HOLE_PAD };
  return intersect(padded, view.rect);
}

/**
 * Every hole of the scrim, the target's first; undefined when the target is not in the viewport,
 * so the scrim never darkens a page with nothing lit. The hint card lives in the editor and is
 * clipped to its viewport like the lines; the navigator floats over the editor and is not. Empty
 * rectangles (a closed card, a list that is not open) are dropped.
 */
export function spotlightHoles(
  target: LineRange,
  view: EditorView,
  card: Rect | undefined,
  overlays: readonly Rect[],
): Rect[] | undefined {
  const hole = targetHole(target, view);
  if (!hole) return undefined;
  const holes = [hole];
  const cardHole = card && intersect(card, view.rect);
  if (cardHole) holes.push(cardHole);
  for (const r of overlays) if (r.w > 0 && r.h > 0) holes.push(r);
  return holes;
}

/** Same holes, to the pixel: the scrim is redrawn only when one of them moved. */
export function sameHoles(a: readonly Rect[] | undefined, b: readonly Rect[] | undefined): boolean {
  if (!a || !b) return a === b;
  const px = (n: number) => Math.round(n);
  return a.length === b.length && a.every((r, i) => {
    const o = b[i]!;
    return px(r.x) === px(o.x) && px(r.y) === px(o.y) && px(r.w) === px(o.w) && px(r.h) === px(o.h);
  });
}

/** Whether the scrim may track the focused annotation at all, before any geometry. */
export interface SpotlightState {
  /** The "Spotlight" setting. */
  enabled: boolean;
  /** The focused annotation resolved to lines in this editor (not missing, not stale). */
  focused: boolean;
  /** The debugger moved (step, run, reset) since the last focus move. */
  quiet: boolean;
}

export function spotlightArmed(s: SpotlightState): boolean {
  return s.enabled && s.focused && !s.quiet;
}

/** The scrim shows while it is armed and the focused target has a hole in the editor's viewport. */
export function spotlightShown(s: SpotlightState, holes: readonly Rect[] | undefined): boolean {
  return spotlightArmed(s) && !!holes?.length;
}
