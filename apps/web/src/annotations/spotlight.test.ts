import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeTerm, termIndexFor, type DebuggerTypes } from '@cardananium/de-uplc-core';
import { resolveDebuggerAnnotations, resolvePseudoRange, type DeUplcTarget } from './annotations';
import { useAnnotations, quietDebuggerSpotlight } from './annotation-store';
import {
  HOLE_PAD, sameHoles, spotlightArmed, spotlightHoles, spotlightShown, targetHole,
  type EditorView, type Rect, type SpotlightState,
} from './spotlight';

const LH = 19;
const range = (line: number, endLine = line) => ({ line, endLine });

/**
 * An editor at (100, 50), 600×190 px: ten 19 px lines in view, a 580 px gutter + text area, and
 * optional view zones (`afterLine` → height) pushing the lines below them down.
 */
function view(opts: { lineCount?: number; scrollTop?: number; zones?: Record<number, number> } = {}): EditorView {
  const zones = opts.zones ?? {};
  const above = (line: number) => Object.entries(zones)
    .reduce((n, [after, h]) => (Number(after) < line ? n + h : n), 0);
  return {
    rect: { x: 100, y: 50, w: 600, h: 190 },
    lineCount: opts.lineCount ?? 100,
    scrollTop: opts.scrollTop ?? 0,
    topOf: (l) => (l - 1) * LH + above(l),
    bottomOf: (l) => l * LH + above(l),
    width: 580,
  };
}

describe('spotlight hole: the focused target in the editor viewport', () => {
  it('covers a single line across the gutter and text area, padded and kept inside the editor', () => {
    expect(targetHole(range(3), view())).toEqual({ x: 100, y: 50 + 2 * LH - HOLE_PAD, w: 580 + HOLE_PAD, h: LH + 2 * HOLE_PAD });
  });

  it('covers every line of a multi-line range', () => {
    expect(targetHole(range(5, 8), view())).toEqual({ x: 100, y: 50 + 4 * LH - HOLE_PAD, w: 584, h: 4 * LH + 2 * HOLE_PAD });
  });

  it('stops at the last line of the text, covers the first line alone when the range ends before it starts', () => {
    expect(targetHole(range(18, 40), view({ lineCount: 20, scrollTop: 10 * LH })))
      .toEqual(targetHole(range(18, 20), view({ lineCount: 20, scrollTop: 10 * LH })));
    expect(targetHole(range(5, 2), view())).toEqual(targetHole(range(5), view()));
  });

  it('has no hole for a target outside the text', () => {
    expect(targetHole(range(0), view())).toBeUndefined();
    expect(targetHole(range(21, 22), view({ lineCount: 20 }))).toBeUndefined();
  });

  it('follows the scroll and the view zones above the target, not the one under it', () => {
    expect(targetHole(range(13), view({ scrollTop: 5 * LH }))).toEqual(targetHole(range(8), view()));
    const zoned = targetHole(range(8), view({ zones: { 2: 40, 8: 60 }, scrollTop: 3 * LH }))!;
    expect(zoned.y).toBe(50 + 4 * LH + 40 - HOLE_PAD);
    expect(zoned.h).toBe(LH + 2 * HOLE_PAD);
  });

  it('is clipped to the viewport when the range is partly scrolled out, at either edge', () => {
    // Lines 1-3 with 2 lines scrolled away: line 3 shows at the top edge.
    expect(targetHole(range(1, 3), view({ scrollTop: 2 * LH }))).toEqual({ x: 100, y: 50, w: 584, h: LH + HOLE_PAD });
    // Lines 10-12 with 10 lines in view: line 10 shows at the bottom edge.
    expect(targetHole(range(10, 12), view())).toEqual({ x: 100, y: 50 + 9 * LH - HOLE_PAD, w: 584, h: LH + HOLE_PAD });
  });

  it('is gone once every line of the range is scrolled out, whatever the padding would reach', () => {
    expect(targetHole(range(1, 2), view({ scrollTop: 2 * LH }))).toBeUndefined();
    expect(targetHole(range(1, 2), view({ scrollTop: 2 * LH + 1 }))).toBeUndefined();
    expect(targetHole(range(11), view())).toBeUndefined();
    expect(targetHole(range(40, 45), view())).toBeUndefined();
  });
});

describe('spotlight holes: the target, the hint card and the navigator', () => {
  const card: Rect = { x: 120, y: 200, w: 300, h: 80 }; // runs 40 px past the editor's bottom
  const bar: Rect = { x: 500, y: 58, w: 180, h: 28 };
  const closed: Rect = { x: 0, y: 0, w: 0, h: 0 };

  it('clips the card to the editor viewport and keeps the navigator whole, dropping empty boxes', () => {
    const holes = spotlightHoles(range(3), view(), card, [bar, closed])!;
    expect(holes).toHaveLength(3);
    expect(holes[0]).toEqual(targetHole(range(3), view()));
    expect(holes[1]).toEqual({ x: 120, y: 200, w: 300, h: 40 });
    expect(holes[2]).toEqual(bar);
  });

  it('leaves out a card scrolled out of the editor', () => {
    expect(spotlightHoles(range(3), view(), { ...card, y: 260 }, [bar])).toHaveLength(2);
  });

  it('is nothing at all when the target is out of the viewport, even with the card and navigator in view', () => {
    expect(spotlightHoles(range(40), view(), card, [bar])).toBeUndefined();
  });

  it('counts as moved only when a hole moved by a pixel', () => {
    const a = spotlightHoles(range(3), view(), card, [bar]);
    expect(sameHoles(a, spotlightHoles(range(3), view(), { ...card, x: 120.3 }, [bar]))).toBe(true);
    expect(sameHoles(a, spotlightHoles(range(3), view({ scrollTop: 2 }), card, [bar]))).toBe(false);
    expect(sameHoles(a, spotlightHoles(range(3), view(), undefined, [bar]))).toBe(false);
    expect(sameHoles(undefined, undefined)).toBe(true);
    expect(sameHoles(a, undefined)).toBe(false);
  });
});

describe('spotlight visibility', () => {
  const on: SpotlightState = { enabled: true, focused: true, quiet: false };
  const holes = spotlightHoles(range(3), view(), undefined, []);

  it('shows for a resolved, focused target in view with the setting on', () => {
    expect(spotlightShown(on, holes)).toBe(true);
  });

  it('hides with the setting off, after the debugger moved, or with the target out of view', () => {
    expect(spotlightShown({ ...on, enabled: false }, holes)).toBe(false);
    expect(spotlightShown({ ...on, quiet: true }, holes)).toBe(false);
    expect(spotlightShown(on, spotlightHoles(range(40), view(), undefined, []))).toBe(false);
    expect(spotlightArmed({ ...on, quiet: true })).toBe(false);
  });

  it('hides for a focused annotation that is not drawn: a decompiler target past the end, a stale set', () => {
    const lineCount = 10;
    const focusedOf = (t: DeUplcTarget, stale = false) => {
      if (stale) return false; // a stale set draws no marks at all
      const r = resolvePseudoRange(t, lineCount);
      return r.start !== undefined && r.end !== undefined;
    };
    expect(spotlightShown({ ...on, focused: focusedOf({ kind: 'pseudo_line', line: 40 }) }, holes)).toBe(false);
    expect(spotlightShown({ ...on, focused: focusedOf({ kind: 'pseudo_line', line: 5, end_line: 8 }, true) }, holes)).toBe(false);
    expect(spotlightShown({ ...on, focused: focusedOf({ kind: 'pseudo_line', line: 5, end_line: 8 }) }, holes)).toBe(true);
  });

  it('hides for a debugger term that is not in the program', () => {
    // [ (lam x x) (con integer 42) ], one term per line in the tree view.
    const term: DebuggerTypes.Term = {
      term_type: 'Apply', id: 7,
      function: { term_type: 'Lambda', id: 8, parameterName: 'x', body: { term_type: 'Var', id: 9, name: 'x' } },
      argument: { term_type: 'Constant', id: 10, constant: { type: 'Integer', value: '42' } },
    };
    const { locations } = serializeTerm(term);
    const index = termIndexFor(locations, 'tree');
    const focusedOf = (term_id: number) => {
      const [a] = resolveDebuggerAnnotations([{ target: { kind: 'term', term_id } }], locations, undefined);
      return a?.termId !== undefined && index.lineOfTerm(a.termId) !== undefined;
    };
    expect(spotlightShown({ ...on, focused: focusedOf(99) }, holes)).toBe(false);
    expect(spotlightShown({ ...on, focused: focusedOf(3) }, holes)).toBe(true);
  });
});

describe('spotlight after a debugger step', () => {
  const items = [0, 1, 2].map((termId) => ({ ann: { target: { kind: 'term' as const, term_id: termId } }, termId }));
  const holes = spotlightHoles(range(3), view(), undefined, []);
  const shown = () => spotlightShown(
    { enabled: true, focused: true, quiet: useAnnotations.getState().debugger?.quiet ?? true },
    holes,
  );
  afterEach(() => { useAnnotations.getState().clearDebugger(); });

  it('shows on launch, steps aside when the debugger moves, and is back with the next focus move', () => {
    useAnnotations.getState().setDebugger(items, 0);
    expect(shown()).toBe(true);
    quietDebuggerSpotlight();
    expect(shown()).toBe(false);
    expect(useAnnotations.getState().debugger?.focus).toBe(0); // the annotations themselves stay
    quietDebuggerSpotlight(); // further steps change nothing
    expect(shown()).toBe(false);
    useAnnotations.getState().focusDebugger(1);
    expect(shown()).toBe(true);
    quietDebuggerSpotlight();
    useAnnotations.getState().focusDebugger(1); // the same entry again from the list
    expect(shown()).toBe(true);
  });

  it('does nothing without annotations', () => {
    quietDebuggerSpotlight();
    expect(useAnnotations.getState().debugger).toBeUndefined();
  });
});

describe('Spotlight setting', () => {
  const KEY = 'deuplc.annotations.spotlight';
  let stored: Map<string, string>;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => { stored.set(k, String(v)); },
      removeItem: (k: string) => { stored.delete(k); },
    });
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  // The settings store reads localStorage once, when its module loads: a fresh import is a fresh visit.
  const visit = async () => {
    vi.resetModules();
    return (await import('../platform/settings')).useSettings;
  };

  it('is on by default', async () => {
    expect((await visit()).getState().annSpotlight).toBe(true);
  });

  it('is remembered across visits, off and back on', async () => {
    (await visit()).getState().set('annSpotlight', false);
    expect(stored.get(KEY)).toBe('false');
    const second = await visit();
    expect(second.getState().annSpotlight).toBe(false);
    second.getState().set('annSpotlight', true);
    expect((await visit()).getState().annSpotlight).toBe(true);
  });

  it('returns to on with a settings reset', async () => {
    stored.set(KEY, 'false');
    const settings = await visit();
    expect(settings.getState().annSpotlight).toBe(false);
    settings.getState().reset();
    expect(settings.getState().annSpotlight).toBe(true);
    expect(stored.get(KEY)).toBe('true');
  });
});
