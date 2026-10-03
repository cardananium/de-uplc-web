import { TermIndex, type TermLocation } from '@cardananium/de-uplc-core';

// UI annotations carried by a `#d=` launch link: targets to highlight until dismissed, each with
// an optional hint. The wire shape is shared with the link producers (the cardano-debug MCP and
// cquisitor), so the field names below are a contract:
//   { …launch fields, ann: Annotation[], ann_focus?: number, options?: {…decompiler options} }
// Unknown target kinds and malformed entries are skipped, never fatal — a link from a newer
// producer still opens.

export type AnnotationSeverity = 'error' | 'warning' | 'info';

export type DeUplcTarget =
  /** Normalised term id: `uniq_id - base`, base = the smallest term id of the loaded program. */
  | { kind: 'term'; term_id: number }
  /** 1-based line of the canonical one-term-per-line UPLC listing (`serializeTermUplc`). */
  | { kind: 'uplc_line'; line: number }
  /** 1-based line range of the decompiled output produced with the link's decompiler options. */
  | { kind: 'pseudo_line'; line: number; end_line?: number };

export interface Annotation {
  target: DeUplcTarget;
  label?: string;
  hint?: string;
  /** Rendered as `info` when absent. */
  severity?: AnnotationSeverity;
}

/** The validated annotations of a launch link and the one to focus first. */
export interface LaunchAnnotations {
  items: Annotation[];
  /** Index into `items`. */
  focus: number;
}

export const MAX_ANNOTATIONS = 64;
export const MAX_LABEL = 80;
export const MAX_HINT = 2000;

const SEVERITIES: ReadonlySet<string> = new Set<AnnotationSeverity>(['error', 'warning', 'info']);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isLine = (v: unknown): v is number => isIndex(v) && v >= 1;

/** The target with the kind's own fields only, or undefined when a field is missing or mistyped. */
function parseTarget(raw: unknown): DeUplcTarget | undefined {
  if (!isRecord(raw)) return undefined;
  switch (raw.kind) {
    case 'term':
      return isIndex(raw.term_id) ? { kind: 'term', term_id: raw.term_id } : undefined;
    case 'uplc_line':
      return isLine(raw.line) ? { kind: 'uplc_line', line: raw.line } : undefined;
    case 'pseudo_line':
      if (!isLine(raw.line)) return undefined;
      if (raw.end_line === undefined) return { kind: 'pseudo_line', line: raw.line };
      return isLine(raw.end_line) && raw.end_line >= raw.line
        ? { kind: 'pseudo_line', line: raw.line, end_line: raw.end_line }
        : undefined;
    default:
      return undefined;
  }
}

/** At most `max` UTF-16 code units, never splitting a surrogate pair. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function parseOne(raw: unknown): Annotation | undefined {
  if (!isRecord(raw)) return undefined;
  const target = parseTarget(raw.target);
  if (!target) return undefined;
  if (raw.label !== undefined && typeof raw.label !== 'string') return undefined;
  if (raw.hint !== undefined && typeof raw.hint !== 'string') return undefined;
  if (raw.severity !== undefined && !(typeof raw.severity === 'string' && SEVERITIES.has(raw.severity))) return undefined;
  const out: Annotation = { target };
  if (raw.label) out.label = truncate(raw.label, MAX_LABEL);
  if (raw.hint) out.hint = truncate(raw.hint, MAX_HINT);
  if (raw.severity !== undefined) out.severity = raw.severity as AnnotationSeverity;
  return out;
}

/**
 * Validate the `ann` / `ann_focus` fields of a decoded `#d=` payload, by the same rules as the
 * link producers. Only the first `MAX_ANNOTATIONS` raw entries are read. An entry is dropped when
 * it is not an object, its target is of an unknown kind or has a mistyped field (ids and lines are
 * non-negative safe integers, lines >= 1, `end_line >= line`), `label` / `hint` is not a string,
 * or `severity` is not error | warning | info. Kept targets carry their kind's fields only;
 * label / hint are truncated to their caps (never splitting a surrogate pair) and empty ones are
 * omitted; an absent severity stays absent.
 *
 * `ann_focus` indexes the raw array: a dropped focused entry moves focus to the next kept one (or
 * the last kept one); a focus that is not a non-negative integer is 0; past the end it clamps to
 * the last entry. Undefined when no entry survives.
 */
export function parseLaunchAnnotations(ann: unknown, annFocus: unknown): LaunchAnnotations | undefined {
  if (!Array.isArray(ann)) return undefined;
  const want = isIndex(annFocus) ? annFocus : 0;
  const items: Annotation[] = [];
  let focus = -1;
  const limit = Math.min(ann.length, MAX_ANNOTATIONS);
  for (let i = 0; i < limit; i++) {
    const entry = parseOne(ann[i]);
    if (!entry) continue;
    if (focus < 0 && i >= want) focus = items.length;
    items.push(entry);
  }
  if (!items.length) return undefined;
  return { items, focus: focus < 0 ? items.length - 1 : focus };
}

/** Rendered severity: `info` when the link gave none. */
export const severityOf = (a: Annotation): AnnotationSeverity => a.severity ?? 'info';

/** The wire form of `LaunchAnnotations`, for a share link. */
export function annotationsToWire(a: LaunchAnnotations): { ann: Annotation[]; ann_focus?: number } {
  return { ann: a.items, ...(a.focus ? { ann_focus: a.focus } : {}) };
}

/** Short human name of a target, used when an annotation has no label. */
export function targetName(t: DeUplcTarget): string {
  switch (t.kind) {
    case 'term': return `term ${t.term_id}`;
    case 'uplc_line': return `UPLC line ${t.line}`;
    case 'pseudo_line': return t.end_line && t.end_line !== t.line ? `lines ${t.line}–${t.end_line}` : `line ${t.line}`;
  }
}

export const annotationTitle = (a: Annotation): string => a.label ?? targetName(a.target);

// ── debugger targets ───────────────────────────────────────────────────────────────────────────

/** An annotation resolved against the loaded program: an absolute term id, or why not. */
export interface DebuggerAnnotation {
  ann: Annotation;
  termId?: number;
  missing?: string;
}

/** Smallest term id of a rendering — the base the normalised `term_id` is relative to. */
export function termIdBase(locs: readonly TermLocation[]): number | undefined {
  let min: number | undefined;
  for (const l of locs) if (min === undefined || l.termId < min) min = l.termId;
  return min;
}

/**
 * Resolve debugger annotations against the loaded program. `locs` are the active rendering's
 * locations (any view: term ids are the same in both); `canonicalLocs` are the
 * `serializeTermUplc` locations, needed only by `uplc_line` targets. A target that does not land
 * on a term of this program is kept with a `missing` reason.
 */
export function resolveDebuggerAnnotations(
  items: readonly Annotation[],
  locs: readonly TermLocation[],
  canonicalLocs: readonly TermLocation[] | undefined,
): DebuggerAnnotation[] {
  const base = termIdBase(locs);
  const ids = new Set(locs.map((l) => l.termId));
  let canon: TermIndex | undefined;
  return items.map((ann): DebuggerAnnotation => {
    const t = ann.target;
    if (base === undefined) return { ann, missing: 'no program term is loaded' };
    if (t.kind === 'term') {
      const termId = base + t.term_id;
      return ids.has(termId) ? { ann, termId } : { ann, missing: `term ${t.term_id} is not in this program` };
    }
    if (t.kind === 'uplc_line') {
      if (!canonicalLocs?.length) return { ann, missing: 'the canonical UPLC listing is not available' };
      canon ??= new TermIndex(canonicalLocs, 'uplc');
      // The outermost term starting on that line (document order puts it first).
      const rank = canon.byLine.get(t.line - 1)?.[0];
      return rank === undefined
        ? { ann, missing: `no term starts on UPLC line ${t.line}` }
        : { ann, termId: canon.locations[rank].termId };
    }
    return { ann, missing: 'a decompiler target (open the Decompiler tab link)' };
  });
}

// ── decompiler targets ─────────────────────────────────────────────────────────────────────────

/** A 1-based inclusive line range in the decompiled output, or why the target has none. */
export interface PseudoRange {
  start?: number;
  end?: number;
  missing?: string;
}

/**
 * Clamp a `pseudo_line` target to an output of `lineCount` lines: a range starting past the end
 * is not found, one running past it is cut at the last line.
 */
export function resolvePseudoRange(t: DeUplcTarget, lineCount: number): PseudoRange {
  if (t.kind !== 'pseudo_line') return { missing: 'a debugger target (open the Debugger link)' };
  if (lineCount <= 0) return { missing: 'no decompiled output' };
  if (t.line > lineCount) return { missing: `line ${t.line} is past the end of the output (${lineCount} lines)` };
  return { start: t.line, end: Math.min(t.end_line ?? t.line, lineCount) };
}
