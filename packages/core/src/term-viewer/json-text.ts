// JSON text for values that nest as deep as a script's data can: `JSON.stringify` recurses once
// per level (a few thousand levels in, the call stack runs out) and, pretty-printed, indents
// every level two more spaces, which grows the text with the square of the depth. These walk
// with an explicit stack, and the pretty form stops indenting at `MAX_INDENT` columns.
//
// They take the values a term, a value or a script context holds, as `JSON.parse` returns them:
// no `undefined` (an object property holding one is left out, as `JSON.stringify` leaves it out),
// no `toJSON`, no cycles.

import { spaces } from './indent';

/** A line of `JSON.stringify(value, null, 2)`, its indentation apart. */
export interface JsonLine {
  indent: number;
  text: string;
}

/** `JSON.stringify(value, null, 2)`, line by line. */
export function jsonLines(value: unknown): JsonLine[] {
  type Item =
    | { value: unknown; indent: number; before: string; after: string }
    | { close: string; indent: number; after: string };
  const lines: JsonLine[] = [];
  const stack: Item[] = [{ value, indent: 0, before: '', after: '' }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if ('close' in item) {
      lines.push({ indent: item.indent, text: item.close + item.after });
      continue;
    }
    const { indent, before, after } = item;
    const entries = entriesOf(item.value);
    if (entries === undefined) {
      lines.push({ indent, text: before + JSON.stringify(item.value) + after });
      continue;
    }
    const [open, close] = Array.isArray(item.value) ? ['[', ']'] : ['{', '}'];
    if (entries.length === 0) {
      lines.push({ indent, text: before + open + close + after });
      continue;
    }
    lines.push({ indent, text: before + open });
    stack.push({ close, indent, after });
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, x] = entries[i];
      stack.push({
        value: x,
        indent: indent + 2,
        before: key === undefined ? '' : `${JSON.stringify(key)}: `,
        after: i < entries.length - 1 ? ',' : '',
      });
    }
  }
  return lines;
}

/** `JSON.stringify(value, null, 2)`, indented as far as `MAX_INDENT`. */
export function prettyJson(value: unknown): string {
  return jsonLines(value)
    .map((line) => spaces(line.indent) + line.text)
    .join('\n');
}

/** `JSON.stringify(value)`. */
export function compactJson(value: unknown): string {
  type Item = { value: unknown; before: string } | string;
  const out: string[] = [];
  const stack: Item[] = [{ value, before: '' }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    out.push(item.before);
    const entries = entriesOf(item.value);
    if (entries === undefined) {
      out.push(JSON.stringify(item.value));
      continue;
    }
    const [open, close] = Array.isArray(item.value) ? ['[', ']'] : ['{', '}'];
    out.push(open);
    stack.push(close);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, x] = entries[i];
      const separator = i > 0 ? ',' : '';
      stack.push({ value: x, before: separator + (key === undefined ? '' : `${JSON.stringify(key)}:`) });
    }
  }
  return out.join('');
}

/** An array's items or an object's properties, as `JSON.stringify` would write them; `undefined`
 *  for anything that is neither. */
function entriesOf(value: unknown): [string | undefined, unknown][] | undefined {
  if (Array.isArray(value)) return value.map((x): [undefined, unknown] => [undefined, x === undefined ? null : x]);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).filter(([, x]) => x !== undefined);
  }
  return undefined;
}
