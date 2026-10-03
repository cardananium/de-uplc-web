// The annotation spotlight: while a launch link's annotations are shown, an editor dims every line
// that no resolved annotation covers, so the targets stand out. Line arithmetic only — the editors
// lay the spans down as whole-line decorations (`useLineAnnotations`).

/** A 1-based inclusive line span. */
export interface LineSpan {
  start: number;
  end: number;
}

/** A 1-based inclusive line range, as the editors' marks carry it. */
type LineRange = { readonly line: number; readonly endLine: number };

/**
 * The lines to dim in a text of `lineCount` lines around the lit ranges, as maximal spans in line
 * order. A range is clamped the way its band is drawn: one starting outside the text lights
 * nothing, one running past the last line stops there, and an `endLine` before `line` lights
 * `line` alone. Overlapping and adjacent ranges merge. Nothing is dimmed when no lit range lands in
 * the text: the spotlight needs at least one lit line. The `keep` ranges (the debugger's current
 * line) stay bright as well, clamped the same way, but never turn the spotlight on by themselves.
 */
export function dimmedSpans(
  lit: readonly LineRange[],
  lineCount: number,
  keep: readonly LineRange[] = [],
): LineSpan[] {
  const clamp = (rs: readonly LineRange[]) => rs
    .filter((r) => r.line >= 1 && r.line <= lineCount)
    .map((r) => ({ start: r.line, end: Math.min(Math.max(r.line, r.endLine), lineCount) }));
  const bright = clamp(lit);
  if (!bright.length) return [];
  bright.push(...clamp(keep));
  bright.sort((a, b) => a.start - b.start);
  const dim: LineSpan[] = [];
  let next = 1; // first line not yet covered by a bright range or a dimmed span
  for (const r of bright) {
    if (r.start > next) dim.push({ start: next, end: r.start - 1 });
    next = Math.max(next, r.end + 1);
  }
  if (next <= lineCount) dim.push({ start: next, end: lineCount });
  return dim;
}
