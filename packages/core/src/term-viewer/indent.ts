// How far the term renderings and the JSON views indent. A program, and the data it holds, nests
// as deep as its size allows: a 17 KB script, some 35 000 levels. Indented two spaces a level all
// the way down, its listing would grow with the square of its depth — 2.4 GB at that depth; with
// cquisitor's cap of 1 024 columns, 71 MB.

/**
 * Indentation stops growing at this many columns. Deeper lines all start here, so every term
 * still starts its own line (line↔term mappings, breakpoints and line annotations hold), and the
 * deepest listing a 17 KB script can have stays under 5 MB.
 */
export const MAX_INDENT = 64;

const SPACES: string[] = [];

/** `columns` spaces, as far as `MAX_INDENT`. */
export function spaces(columns: number): string {
  const n = Math.min(columns, MAX_INDENT);
  let text = SPACES[n];
  if (text === undefined) {
    text = ' '.repeat(n);
    SPACES[n] = text;
  }
  return text;
}

/** The indentation of a line `depth` levels deep: two spaces a level, as far as `MAX_INDENT`. */
export function indentation(depth: number): string {
  return spaces(2 * depth);
}
