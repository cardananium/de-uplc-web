// The profiler's surface inside the term editor: the cost lane, the overview-ruler marks, the cost
// hints at line ends, and the keys that walk the hot list. `TermEditor.tsx` owns the two decoration
// collections and the single effect that fills them; everything they need to decide WHAT to paint
// lives here, so the editor component stays a wiring file.
//
// Four rules this module exists to keep, all of them things Monaco does not enforce:
//
//  1. A heat decoration never carries a `className`. The line background and its left rail belong
//     to .dbg-line / .dbg-finished-line / .dbg-error-line / .term-locate-line, and the glyph margin
//     belongs to the breakpoints. Heat gets the `linesDecorations` column and nothing else — and
//     `zIndex` does not order that column (elements there sort BY CLASS NAME and fully overlap), so
//     heat must be the only lines-decoration on a line.
//  2. The lane and its hover are ONE decoration. `isWholeLine: true` short-circuits the column
//     check in the content-hover collector, so a zero-width range at column 1 still answers a hover
//     anywhere on the line — and `isWholeLine` without a `className` paints nothing, because the
//     background renderer filters on the class. The bar itself needs its own `linesDecorationsTooltip`:
//     content hover does not fire over the margin at all.
//  3. Ruler marks are merged into pixel slots by us. Monaco does not merge them — it re-renders
//     every group of the document each frame — so 41k marks would be 41k rects. Their colour is a
//     `ThemeColor` id, which Monaco re-resolves on a theme change, so the ruler repaints itself
//     with no React render (the app never reads the theme from JS).
//  4. Everything here is O(1) per line via `ProfileIndex`. The inlay provider is re-queried on
//     every scroll; one linear scan in it would make scrolling O(nodes).

import type * as MonacoT from 'monaco-editor';
import { toast } from 'sonner';
import type { MonacoNS } from './monaco';
import { useTabsStore } from './tabs-store';
import { useStore } from '../store';
import { useSettings, type ProfileScope } from '../platform/settings';
import { fmtInt, fmtPct } from '../profile/format';
import { RETURN_DOMINATED } from '../profile/derive';
import {
  HOT_BUCKET,
  NO_BUCKET,
  laneClass,
  laneHoverMarkdown,
  laneTooltip,
  mergeRulerSlots,
  rulerColorId,
  type HeatBucket,
  type LaneContext,
  type LaneStats,
} from '../profile/heat';
import type { ProfileIndex } from '../profile/profile-index';

/**
 * Ceiling on lane decorations: the 4 000 hottest lines after zero-suppression, the rest unpainted
 * and SAID SO in the status bar. Safe because the cost of a decoration is a one-off insert into the
 * interval tree plus rendering, and rendering is bounded by the viewport — the total never reaches
 * the frame path.
 */
export const LANE_CAP = 4000;
/** Design ceiling on ruler marks. Slots are 3 device-px, so an ~800px ruler yields ≤ ~270 at ANY
 *  document size; this is a guard against a geometry change, not a working limit. */
export const RULER_CAP = 400;

/** Status-bar note when the cap bites. The merge is named too: an overview mark stands for ~154
 *  lines on a 41k-line term, and a user comparing mark counts to line counts deserves to know. */
export const LANE_CAP_NOTE = `showing the ${fmtInt(LANE_CAP)} hottest lines · overview marks are merged`;

// ── Decorations ─────────────────────────────────────────────────────────────────────────────────

/**
 * The lane: one whole-line decoration per painted line, hottest 4 000 first, in document order.
 * `maxLine` is the model's line count — the index is built in the store from `termLocations`, so it
 * can outlive the text it was built against for one render.
 */
export function laneDecorations(
  monaco: MonacoNS,
  index: ProfileIndex,
  maxLine: number,
): MonacoT.editor.IModelDeltaDecoration[] {
  const ranked = index.ranked;
  const lines: number[] = [];
  for (let i = 0; i < ranked.length && lines.length < LANE_CAP; i++) {
    if (ranked[i] + 1 <= maxLine) lines.push(ranked[i]);
  }
  lines.sort((a, b) => a - b); // document order: cheaper interval-tree inserts, stable diffing
  const ret = lineReturnCost(index);
  const out: MonacoT.editor.IModelDeltaDecoration[] = [];
  for (const ln of lines) {
    const stats = index.laneStats(ln);
    if (!stats) continue;
    // `≈`: this line's cost is mostly Return-step cost, which v1 attribution charges to the last
    // node that executed rather than to the apply site it returns into. Same predicate and same
    // 0.5 threshold as the report table's marker, read on the line's aggregate — the lane is a
    // per-line surface, so its caveat has to be a per-line one.
    const approx = !!ret && stats.self > 0 && ret[ln] / stats.self >= RETURN_DOMINATED;
    out.push({
      range: new monaco.Range(ln + 1, 1, ln + 1, 1),
      options: laneOptions(monaco, index.lineBucket[ln] as HeatBucket, stats, index.context, approx),
    });
  }
  return out;
}

/**
 * Return-step cost per 0-based line, or `undefined` under `apply_site` attribution — where the
 * marker does not exist at all, so the whole pass is skipped.
 *
 * One O(rows) sweep per lane build (i.e. per `profileIndex` × `metric`, never per frame and never
 * per scroll); `ProfileIndex` keeps `ret` per ROW, and the marker is a statement about the LINE.
 */
function lineReturnCost(index: ProfileIndex): Float64Array | undefined {
  if (index.context.attribution !== 'last_term') return undefined;
  const ret = new Float64Array(index.lineCount);
  for (const row of index.rows) {
    if (row.line !== undefined && row.line < ret.length) ret[row.line] += row.ret;
  }
  return ret;
}

function laneOptions(
  monaco: MonacoNS,
  bucket: HeatBucket,
  stats: LaneStats,
  ctx: LaneContext,
  approx: boolean,
): MonacoT.editor.IModelDecorationOptions {
  return {
    // Whole-line so the hover card answers anywhere on the line; no className, so nothing is
    // painted behind the text (see the header).
    isWholeLine: true,
    linesDecorationsClassName: laneClass(bucket, approx),
    // Native `title` on the bar: plain text, one line, because markdown hovers never fire over the
    // margin. This is the ONLY thing the bar itself can say — so the `≈` the dimming stands for is
    // spelled out here and in the card, never carried by the transparency alone.
    linesDecorationsTooltip: laneTooltip(stats, ctx, approx),
    hoverMessage: { value: laneHoverMarkdown(stats, ctx, approx) },
    stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
  };
}

/**
 * The overview ruler: one mark per 3-device-px slot, coloured by the hottest line in it. `rulerPx`
 * comes from the live layout, `lineCount` from the MODEL (the marks map document lines to ruler
 * pixels, so the geometry has to be the document's, not the index's).
 */
export function rulerDecorations(
  monaco: MonacoNS,
  index: ProfileIndex,
  lineCount: number,
  rulerPx: number,
): MonacoT.editor.IModelDeltaDecoration[] {
  // `ranked` is hottest-first; the slot merge needs ascending lines (it walks them once).
  const ascending = Int32Array.from(index.ranked).sort();
  const slots = mergeRulerSlots(ascending, (ln) => index.bucketAt(ln), lineCount, rulerPx);
  const out: MonacoT.editor.IModelDeltaDecoration[] = [];
  for (const s of slots) {
    if (out.length >= RULER_CAP) break;
    out.push({
      range: new monaco.Range(s.firstLine + 1, 1, s.lastLine + 1, 1),
      options: {
        // A ThemeColor id, not a hex: Monaco resolves it through the editor theme and drops the
        // decoration-colour cache on a theme change, so light↔dark repaints the ruler by itself.
        overviewRuler: {
          color: { id: rulerColorId(s.bucket) },
          position: monaco.editor.OverviewRulerLane.Right,
        },
        // Ruler groups render in zIndex → colour order, so hot groups must draw last.
        zIndex: s.bucket,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    });
  }
  return out;
}

/**
 * Fill (or empty) both collections. `index === undefined` covers all three "no markup" cases —
 * no profile, `profileHeat: false`, and stale — and is the whole of their implementation: the
 * report, the outcome pill and the hot-list navigation stay exactly as they were.
 */
export function applyProfileHeat(
  monaco: MonacoNS,
  editor: MonacoT.editor.IStandaloneCodeEditor,
  lane: MonacoT.editor.IEditorDecorationsCollection,
  ruler: MonacoT.editor.IEditorDecorationsCollection,
  index: ProfileIndex | undefined,
): void {
  const model = editor.getModel();
  if (!index || !model) {
    lane.clear();
    ruler.clear();
    return;
  }
  const lineCount = model.getLineCount();
  const layout = editor.getLayoutInfo();
  // The fallback matters: a profile can land while the Script tab is hidden, and a zero-height
  // layout would merge every mark away. 800px is a normal ruler, and the slot size only decides
  // how coarse the merge is — the marks are line ranges, so they land correctly at any later size.
  const rulerPx = layout.overviewRuler.height || layout.height || 800;
  lane.set(laneDecorations(monaco, index, lineCount));
  ruler.set(rulerDecorations(monaco, index, lineCount, rulerPx));
}

// ── Cost hints at line ends ─────────────────────────────────────────────────────────────────────

/**
 * The profile block of the single global inlay provider. Hot lines only (bucket ≥ 3): a hint on
 * every painted line would bury the term text, and the lane already carries the cold ones.
 *
 * `statusLine` is the line that already took the slot for the debugger's trailing comment — it
 * WINS, because "the machine is here" outranks "this line was expensive" on the line the user is
 * stopped at. Suppressed entirely when the heat layer is off: Ctrl/Cmd+Alt+P means "stop marking up
 * the term", and a hint at a line end is markup.
 */
export function profileInlayHints(
  model: MonacoT.editor.ITextModel,
  range: MonacoT.IRange,
  statusLine: number | undefined,
  /** Characters of the line's inlay budget already spent by the term's own hints. */
  used?: ReadonlyMap<number, number>,
): MonacoT.languages.InlayHint[] {
  const st = useStore.getState();
  const index = st.profileIndex;
  if (!index || st.profileStale || !st.profileHeat || !useSettings.getState().profileInlay) return [];

  const hints: MonacoT.languages.InlayHint[] = [];
  const first = Math.max(0, range.startLineNumber - 1);
  const last = Math.min(range.endLineNumber - 1, model.getLineCount() - 1, index.lineCount - 1);
  for (let ln = first; ln <= last; ln++) {
    if (ln === statusLine) continue;
    const bucket = index.bucketAt(ln);
    if (bucket === NO_BUCKET || bucket < HOT_BUCKET) continue;
    const stats = index.laneStats(ln);
    if (!stats) continue;
    hints.push({
      position: { lineNumber: ln + 1, column: model.getLineMaxColumn(ln + 1) },
      label: inlayText(stats, index.context, st.profileScope, MAX_LINE_LABEL - (used?.get(ln) ?? 0)),
      paddingLeft: true,
    });
  }
  return hints;
}

/** Monaco caps the SUM of a line's inlay labels and truncates the overflow — see the budget the
 *  caller passes in. Mirrored from the editor's own `_MAX_LABEL_LEN`. */
const MAX_LINE_LABEL = 43;

/**
 * `// 8.44% self · 62.40% tree · 41,203×`, shortened to whatever the line has room for. The two
 * numbers are ALWAYS printed together so one cannot be read without the other — a big self with a
 * small subtree and a small self with a big subtree call for opposite fixes. `scope` puts the
 * active one first (and only here: the lane's tooltip and hover card are fixed self-then-subtree,
 * because that decoration is not rebuilt when the scope toggles and a scope-dependent order there
 * would go stale silently).
 *
 * The forms degrade in a fixed order rather than letting Monaco cut mid-word: it truncated
 * `… 7.61% tree · 39×` to `… 7.61% tree · …`, which spends characters on a word and then drops the
 * number it belonged to. Losing the labels first, then the hit count, keeps every character that
 * survives meaningful — and the hover card carries the full version regardless.
 */
function inlayText(s: LaneStats, ctx: LaneContext, scope: ProfileScope, budget: number): string {
  const a = fmtPct(scope === 'subtree' ? s.subtree : s.self, ctx.total);
  const b = fmtPct(scope === 'subtree' ? s.self : s.subtree, ctx.total);
  const wa = scope === 'subtree' ? 'tree' : 'self';
  const wb = scope === 'subtree' ? 'self' : 'tree';
  const hits = `${fmtInt(s.hits)}×`;
  for (const form of [
    `// ${a} ${wa} · ${b} ${wb} · ${hits}`,
    `// ${a} · ${b} · ${hits}`,
    `// ${a} · ${b}`,
    `// ${a}`,
  ]) {
    if (form.length <= budget) return form;
  }
  return `// ${a}`;
}

// ── The hot list ────────────────────────────────────────────────────────────────────────────────

/** Ascending-array counting search: entries before `v` (`orEqual` counts `v` itself as well). */
function countBefore(arr: Int32Array, v: number, orEqual: boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (orEqual ? arr[mid] <= v : arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface HotStatus {
  /** Hot lines in the document (bucket ≥ 3) — the same list F8 walks, so the status bar and the key
   *  can never disagree about the denominator. */
  count: number;
  /** `hot 17 / 31 · self 8.44%` — the caret's position in that list, in document order. */
  label: string;
  /** Hottest line of the whole document, 0-based: where a click on the item goes (rank 1). */
  topLine: number;
}

/** The status-bar item, or `undefined` when nothing reaches 1% of the run. */
export function hotStatus(index: ProfileIndex, caretLine0: number): HotStatus | undefined {
  const hot = index.hotLines;
  if (hot.length === 0 || index.ranked.length === 0) return undefined;
  const i = countBefore(hot, caretLine0, true);
  const at = i > 0 ? hot[i - 1] : undefined;
  const share = at !== undefined ? ` · self ${fmtPct(index.lineSelf[at], index.total)}` : '';
  return {
    count: hot.length,
    label: `hot ${fmtInt(i)} / ${fmtInt(hot.length)}${share}`,
    // `ranked` is ordered by line self-cost and buckets are monotone in it, so its head is a hot
    // line whenever `hotLines` is non-empty.
    topLine: index.ranked[0],
  };
}

/** The outcome mark for the editor's status bar: glyph + word + the sentence behind it. */
export interface OutcomeNote { text: string; title: string; error: boolean }

/**
 * The outcome pill, third copy (sidebar, report header, here): a partial profile with no outcome
 * mark on the surface you are reading reads as a complete one, which is the one way these numbers
 * can lie. `Done` is deliberately absent — the mock of this status bar shows a finished
 * profile with no pill, and "nothing wrong" is exactly what the other five say by contrast.
 */
export function profileOutcomeNote(
  outcome: 'Done' | 'Error' | 'Limit' | 'Cancelled' | undefined,
  status: 'idle' | 'running' | 'ready' | 'error',
  hasProfile: boolean,
  stale: boolean,
): OutcomeNote | undefined {
  if (status === 'error') {
    return { text: '✗ Failed', title: 'The profiler could not finish. The debug session is unaffected.', error: true };
  }
  if (!hasProfile) return undefined;
  if (stale) {
    return {
      text: '⚠ Stale',
      title: 'This profile was taken on a different term — node ids no longer map to lines. The numbers are still valid for the run that produced them.',
      error: false,
    };
  }
  switch (outcome) {
    case 'Cancelled':
      return { text: '⊘ Cancelled', title: 'Partial — cancelled before the run finished. Percentages are of what ran.', error: false };
    case 'Limit':
      return { text: '⚠ Limit', title: 'Stopped at the step cap — raise it in Settings ▸ Profiler.', error: false };
    case 'Error':
      return { text: '✗ Error', title: 'The script failed before finishing — these numbers cover the part that ran.', error: true };
    default:
      return undefined;
  }
}

/** Jump to a 0-based line: caret on the term's first character (not column 1 — deep UPLC terms sit
 *  far right), centred both ways because this is always an explicit navigation. */
export function gotoLine(editor: MonacoT.editor.ICodeEditor, line0: number): void {
  const model = editor.getModel();
  if (!model || line0 < 0 || line0 + 1 > model.getLineCount()) return;
  const lineNumber = line0 + 1;
  const column = model.getLineFirstNonWhitespaceColumn(lineNumber) || 1;
  editor.setPosition({ lineNumber, column });
  editor.revealPositionInCenter({ lineNumber, column });
  editor.focus();
}

/**
 * F8 / Shift+F8. Walks `hotLines` from the CARET (not from a remembered cursor into the list), so
 * scrolling and clicking never desync it from what the status bar says. Wrapping is announced —
 * a silent wrap reads as "the key stopped working".
 */
function gotoHot(editor: MonacoT.editor.ICodeEditor, dir: 1 | -1): void {
  const st = useStore.getState();
  const index = st.profileIndex;
  if (!index || st.profileStale) {
    toast.info('No profile for this term yet — run one from the Profile button');
    return;
  }
  const hot = index.hotLines;
  if (hot.length === 0) {
    toast.info('No node reaches 1% of the run');
    return;
  }
  const caret = (editor.getPosition()?.lineNumber ?? 1) - 1;
  let i = dir > 0 ? countBefore(hot, caret, true) : countBefore(hot, caret, false) - 1;
  let wrapped = false;
  if (i >= hot.length) { i = 0; wrapped = true; }
  if (i < 0) { i = hot.length - 1; wrapped = true; }
  gotoLine(editor, hot[i]);
  if (wrapped) toast.info(dir > 0 ? 'Wrapped to the first hot node' : 'Wrapped to the last hot node');
}

/**
 * "Show in profile" — from the context menu and from a click on the lane itself (the lane is
 * clickable only because folding is off; the chevron used to swallow anything right of x = 4).
 * Selects the hottest node STARTING on the line, which is the row the hover card headlines.
 *
 * The two gates are the lane's own preconditions, not extras. While STALE the term's node ids no
 * longer map to lines, so there is nothing to select — every other reveal affordance is `disabled`
 * there, and this one is reached by a click on a 16px strip. With the heat layer OFF
 * (Ctrl/Cmd+Alt+P) that strip is not painted at all, and an invisible hit-target that navigates is
 * worse than no hit-target. `hasNodeCtx` below computes the same predicate, so the menu item is
 * absent exactly when this would return.
 */
export function showInProfile(line0: number): void {
  const st = useStore.getState();
  if (st.profileStale || !st.profileHeat) return;
  const node = st.profileIndex?.laneStats(line0)?.nodes[0];
  if (!node) return;
  st.selectProfileNode(node.termId);
  // The report tab is a singleton (`PROFILE_TAB`), so this focuses the existing one rather than
  // stacking a second — "show in profile" from three different lines is one tab, three selections.
  useTabsStore.getState().openProfileTab();
}

// ── Keys and menu ───────────────────────────────────────────────────────────────────────────────

/**
 * Register the profiler's editor actions and return the context-key sync for `onMouseDown`.
 *
 * `addAction`, never `addCommand`: the standalone keybinding service is a singleton listening on
 * every editor's container, so an `addCommand` binding fires in EVERY Monaco on the page (the
 * Script Context `CodeView` included) and evicts the built-in from the table — F8 is
 * `Go to Next Problem` there. `addAction` wraps the `when` clause in `editorId == <this editor>`,
 * which scopes the key to this editor, leaves the built-ins alone elsewhere, and gives the context
 * menu item for free.
 */
export function registerProfileActions(
  monaco: MonacoNS,
  editor: MonacoT.editor.IStandaloneCodeEditor,
  clickedLine: () => number | undefined,
): (line: number | undefined) => void {
  // Gate for the menu item only — the keys below stay live so they can ANSWER (with a toast) when
  // there is no profile, instead of silently falling through to Monaco's marker navigation.
  const hasNodeCtx = editor.createContextKey<boolean>('uplcProfileNodeAtLine', false);

  editor.addAction({
    id: 'deuplc.profile.nextHot',
    label: 'Next hot node',
    keybindings: [monaco.KeyCode.F8],
    contextMenuGroupId: 'profile',
    contextMenuOrder: 1,
    run: (ed) => gotoHot(ed, +1),
  });
  editor.addAction({
    id: 'deuplc.profile.prevHot',
    label: 'Previous hot node',
    keybindings: [monaco.KeyMod.Shift | monaco.KeyCode.F8],
    contextMenuGroupId: 'profile',
    contextMenuOrder: 2,
    run: (ed) => gotoHot(ed, -1),
  });
  editor.addAction({
    id: 'deuplc.profile.showInProfile',
    label: 'Show in profile',
    contextMenuGroupId: 'profile',
    contextMenuOrder: 3,
    precondition: 'uplcProfileNodeAtLine',
    run: () => {
      const line = clickedLine();
      if (line !== undefined) showInProfile(line);
    },
  });
  // The heat toggle has no menu entry: it is a view switch, not an action on the clicked line, and
  // it already has a checkbox on the profile panel. The metric deliberately has NO key at all —
  // Ctrl+Alt+<letter> is AltGr on many Windows/Linux layouts and would type a character.
  editor.addAction({
    id: 'deuplc.profile.toggleHeat',
    label: 'Toggle the heat map',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyP],
    run: () => useStore.getState().toggleProfileHeat(),
  });
  // Ctrl/Cmd+Alt+U — the cost hints alone, next to Ctrl/Cmd+Alt+H for the term hints. Same column
  // of the screen, two different providers of it, so they get two keys rather than one that means
  // "some of the text at the end of lines".
  editor.addAction({
    id: 'deuplc.profile.toggleInlay',
    label: 'Toggle inline costs at line ends',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyU],
    run: () => {
      const s = useSettings.getState();
      s.set('profileInlay', !s.profileInlay);
    },
  });

  // mousedown fires before contextmenu, so the menu is built with the clicked line's key already
  // set — the same mechanism the breakpoint items use. The predicate is `showInProfile`'s own, to
  // the letter (`profileHeat` included): a menu entry that is offered and then does nothing is the
  // one outcome worse than a missing one.
  return (line) => {
    const st = useStore.getState();
    hasNodeCtx.set(
      line !== undefined && !!st.profileIndex && !st.profileStale && st.profileHeat
        && !!st.profileIndex.laneStats(line),
    );
  };
}
