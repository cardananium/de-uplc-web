// Pure term serializer — ported verbatim from the VS Code extension's
// `term-viewer.ts` (`processTermWithLocations` + formatters + hint builders +
// `findTermAtLine`/`findNearestTerm`, the last two since moved onto `TermIndex`).
// This is platform-agnostic string/range math: it turns a `Term` into the exact
// text the editor renders, plus the per-term line ranges (`TermLocation[]`, the
// line↔termId mapping that powers breakpoints, the debugger-line highlight and
// the profiler) and inlay hints (`TermHintInfo[]`).
//
// The original used `json-bigint` with `storeAsString: true`. In this data model
// every large integer already arrives as a string (`Constant.Integer.value: string`,
// `PlutusData.Int: { Int: string }`, etc.) and no JS `bigint`/BigNumber instances
// are ever produced, so plain `JSON.stringify` is byte-identical here and keeps
// core dependency-free (matching `uplc-tree/nodes.ts`).
//
// A program nests as deep as its size allows (a 17 KB script, some 35 000 levels), so the term,
// its structured constants and the JSON of the others are all laid out line by line from an
// explicit stack, and no line is indented past `MAX_INDENT` columns: a deeper term still starts
// its own line, so locations and hints hold, but the text grows with the depth, not its square.

import type { Constant, Term, Type } from '../debugger-types';
import { termLabel } from './builtin-name';
import { termIndexFor, type TermView } from './term-index';
import { MAX_INDENT, spaces } from './indent';
import { jsonLines } from './json-text';

export interface TermLocation {
  startLine: number;
  /** EXCLUSIVE here (one past the node's last line) — `uplc-pretty.ts` stores it INCLUSIVE.
   *  Nobody compares these raw: `TermIndex` normalises both to inclusive and owns the ranges. */
  endLine: number;
  termId: number;
  /** The node's shape. Filled here because the profiler's `Node` column has nowhere else to get
   *  it from — the two renderings print the same node differently, so reading it back out of the
   *  rendered line would make the column change with the Term view. */
  kind: Term['term_type'];
  /** Builtin name / variable name / lambda parameter, when the shape has one (`termLabel`). */
  label?: string;
}

interface ConstantData {
  type: string;
  value: any;
}

// Specific types for structured constants
interface ProtoListData {
  elementType: Type;
  values: Constant[];
}

interface ProtoPairData {
  first_type: Type;
  second_type: Type;
  first_element: Constant;
  second_element: Constant;
}


export type HintKind =
  | 'term' //             term type indicators (Apply, Lambda, etc.)
  | 'name' //             term names
  | 'constant_type' //    constant type indicators (Integer, String, etc.)
  | 'builtin_function'; // builtin function names

export interface TermHintInfo {
  line: number;
  character: number;
  text: string;
  kind: HintKind;
}

export interface SerializedTerm {
  text: string;
  locations: TermLocation[];
  hints: TermHintInfo[];
}

/**
 * Serialize a term into the editor's textual form together with its term
 * locations (line↔termId) and inlay hints. Stateless from the caller's side —
 * each call gets a fresh accumulator.
 */
export function serializeTerm(term: Term): SerializedTerm {
  const s = new TermSerializer();
  s.walk(term);
  return { text: s.lines.join('\n'), locations: s.locations, hints: s.hints };
}

// The three line→term lookups below live on `TermIndex` now (linear scans before; the index also
// fixes the tree view's one-line overlap). They stay exported in this shape because the editor and
// the store hold `termLocations`, not an index — `termIndexFor` memoises on the array's identity,
// so the array is walked once per rendering, not once per call. `view` decides how `endLine` is
// read; it defaults to the app's default view, and a caller rendering canonical UPLC MUST pass
// `'uplc'` or a closing paren resolves to the wrong node. Callers that already hold a `TermIndex`
// should call its methods directly.

/**
 * Map an editor line (0-based) to the most specific term that owns it: a term starting exactly
 * there wins (most nested first), otherwise the most nested term spanning it.
 */
export function findTermAtLine(
  line: number,
  termLocations: TermLocation[],
  view: TermView = 'tree',
): TermLocation | undefined {
  return termIndexFor(termLocations, view).findTermAtLine(line);
}

/** Find the term whose start line is closest to `line`. */
export function findNearestTerm(
  line: number,
  termLocations: TermLocation[],
  view: TermView = 'tree',
): TermLocation | undefined {
  return termIndexFor(termLocations, view).findNearestTerm(line);
}

/**
 * Resolve a line to a term id the way the gutter does: the term at the line if
 * any, otherwise the nearest term. Returns the breakpoint line (term start) and
 * its term id, or undefined if there are no terms.
 */
export function termAtLineForBreakpoint(
  line: number,
  termLocations: TermLocation[],
  view: TermView = 'tree',
): { line: number; termId: number } | undefined {
  return termIndexFor(termLocations, view).termAtLineForBreakpoint(line);
}

/** What is left to lay out: a term, a constant, a line, a comma, the end of a term's lines. */
type Task =
  | { k: 'term'; term: Term; column: number; lead: string; base: number }
  | { k: 'constant'; constant: Constant; column: number; lead: string; base: number; top: boolean }
  | { k: 'line'; column: number; text: string }
  | { k: 'comma' }
  | { k: 'end'; loc: TermLocation }
  | { k: 'leave'; id: number };

class TermSerializer {
  readonly lines: string[] = [];
  readonly locations: TermLocation[] = [];
  readonly hints: TermHintInfo[] = [];

  private createTermHints(line: number, termType: string, termId: number, prefixLength: number): void {
    const hints = this.hints;

    // Calculate exact position based on actual line content
    let startPos = prefixLength;
    if (startPos < 0) {
      startPos = 0;
    }

    // "term:" hint at the beginning of the term type
    hints.push({
      line: line,
      character: startPos,
      text: `term:`,
      kind: 'term',
    });

    // "id:" hint right AFTER the term-type token (`Var id:5 y`, `λ id:2 x {`) — not at
    // end of line, where a long value (string constants especially) would push it
    // off-screen and it would trail content it doesn't label.
    hints.push({
      line: line,
      character: startPos + this.getShortTermType(termType).length,
      text: ` id:${termId}`,
      kind: 'name',
    });
  }

  private createBuiltinHints(line: number, termType: string, termId: number, prefixLength: number): void {
    const hints = this.hints;

    // Calculate exact position based on actual line content
    const startPos = prefixLength;

    // "term:" hint at the beginning
    hints.push({
      line: line,
      character: startPos,
      text: `term:`,
      kind: 'term',
    });

    // "id:" hint right after the term type, then "fn:" before the function name:
    // `Built-in id:8 fn: addInteger` (see createTermHints for the placement rationale).
    const shortTermType = this.getShortTermType(termType);
    hints.push({
      line: line,
      character: startPos + shortTermType.length,
      text: ` id:${termId}`,
      kind: 'name',
    });
    hints.push({
      line: line,
      character: startPos + shortTermType.length + 1, // +1 for space after term type
      text: `fn:`,
      kind: 'builtin_function',
    });
  }

  private createConstantHints(line: number, termType: string, termId: number, prefixLength: number): void {
    const hints = this.hints;

    // Calculate exact position based on actual line content
    const startPos = prefixLength;

    // "term:" hint at the beginning
    hints.push({
      line: line,
      character: startPos,
      text: `term:`,
      kind: 'term',
    });

    // "id:" right after "Const", then "type:" before the constant type:
    // `Const id:2 type: Integer: 42` (see createTermHints for the placement rationale).
    const shortTermType = this.getShortTermType(termType);
    hints.push({
      line: line,
      character: startPos + shortTermType.length,
      text: ` id:${termId}`,
      kind: 'name',
    });
    hints.push({
      line: line,
      character: startPos + shortTermType.length + 1, // +1 for space after "Const"
      text: `type:`,
      kind: 'constant_type',
    });
  }

  private parseConstantData(constant: Constant): ConstantData {
    switch (constant.type) {
      case 'Integer':
      case 'ByteString':
      case 'String':
      case 'Bool':
        return {
          type: constant.type,
          value: constant.value,
        };

      case 'Unit':
        return {
          type: constant.type,
          value: undefined,
        };

      case 'ProtoList':
      case 'ProtoArray':
        return {
          type: constant.type,
          value: {
            elementType: constant.elementType,
            values: constant.values,
          },
        };

      case 'ProtoPair':
        return {
          type: constant.type,
          value: {
            first_type: constant.first_type,
            second_type: constant.second_type,
            first_element: constant.first_element,
            second_element: constant.second_element,
          },
        };

      case 'Data':
        return {
          type: constant.type,
          value: constant.data,
        };

      case 'Bls12_381G1Element':
      case 'Bls12_381G2Element':
        return {
          type: constant.type,
          value: constant.serialized,
        };

      case 'Bls12_381MlResult':
        return {
          type: constant.type,
          value: constant.bytes,
        };

      case 'Value':
        return {
          type: constant.type,
          value: constant.entries,
        };

      default: {
        // This should never happen with proper typing
        const _exhaustiveCheck: never = constant;
        throw new Error(`Unknown constant type: ${JSON.stringify(_exhaustiveCheck)}`);
      }
    }
  }

  private shouldUseInlineFormat(type: string): boolean {
    // Types that should use inline format (simple types)
    const inlineTypes = ['Bool', 'Integer', 'String', 'ByteString', 'Unit'];

    // Types that should use multiline format (complex types)
    // Note: 'List' is the same as 'ProtoList', 'Array' as 'ProtoArray', 'Pair' as 'ProtoPair'
    const multilineTypes = ['Data', 'Bls12_381G1Element', 'Bls12_381G2Element', 'Bls12_381MlResult', 'Value', 'ProtoList', 'ProtoArray', 'ProtoPair', 'List', 'Array', 'Pair'];

    // If explicitly marked as multiline, use multiline format
    if (multilineTypes.includes(type)) {
      return false;
    }

    // Otherwise use inline format for simple types
    return inlineTypes.includes(type);
  }

  private formatConstantValue(value: ConstantData['value']): string {
    if (typeof value === 'string') {
      // JSON-escape: a raw newline in a String constant would add physical lines
      // the line counters never see, shifting every location/hint below it.
      return JSON.stringify(value);
    } else if (typeof value === 'number') {
      return String(value);
    } else if (typeof value === 'boolean') {
      return String(value);
    } else if (typeof value === 'bigint') {
      return String(value);
    } else if (value === null) {
      return 'null';
    } else if (value === undefined) {
      return 'undefined';
    } else if (Array.isArray(value)) {
      // For arrays, format as JSON array
      const formattedItems = value.map((item) => this.formatConstantValue(item));
      return `[${formattedItems.join(', ')}]`;
    } else if (typeof value === 'object') {
      // For complex objects, check if it's a simple key-value object
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === 'value') {
        // Simple wrapper object, unwrap it
        return this.formatConstantValue(value.value);
      } else if (keys.length <= 3) {
        // For small objects, format inline
        const pairs = keys.map((key) => `${key}: ${this.formatConstantValue(value[key])}`);
        return `{${pairs.join(', ')}}`;
      } else {
        // For complex objects, use JSON representation
        try {
          return JSON.stringify(value);
        } catch (e) {
          return String(value);
        }
      }
    }
    return String(value);
  }

  private formatType(type: Type | string): string {
    if (typeof type === 'string') {
      return type;
    } else if (typeof type === 'object' && type !== null) {
      if (type.type) {
        return type.type;
      } else {
        return JSON.stringify(type);
      }
    }
    return String(type);
  }

  private getShortTermType(termType: string): string {
    switch (termType) {
      case 'Lambda':
        return 'λ';
      case 'Constant':
        return 'Const';
      case 'Builtin':
        return 'Built-in';
      case 'Error':
        return '⚠️ Error';
      default:
        return termType;
    }
  }

  /**
   * Lay `root` out line by line. Each term starts on a line of its own — the field it is the value
   * of (`fun: `) in front of it, or nothing in a list — and its own lines indent from its base
   * column, two more for each level, as far as `MAX_INDENT`.
   */
  walk(root: Term): void {
    const tasks: Task[] = [{ k: 'term', term: root, column: 0, lead: '', base: 0 }];
    // The ids of the terms the current one is inside, so a term inside itself is not walked forever.
    const open = new Map<number, number>();
    const line = (column: number, text: string): Task => ({ k: 'line', column, text });

    while (tasks.length > 0) {
      const task = tasks.pop()!;
      switch (task.k) {
        case 'line':
          this.lines.push(spaces(task.column) + task.text);
          break;
        case 'comma':
          this.lines[this.lines.length - 1] += ',';
          break;
        case 'end':
          task.loc.endLine = this.lines.length;
          break;
        case 'leave': {
          const count = open.get(task.id) ?? 0;
          if (count <= 1) open.delete(task.id);
          else open.set(task.id, count - 1);
          break;
        }
        case 'constant':
          this.constant(task, tasks);
          break;
        case 'term': {
          const { term, column, lead, base } = task;
          const first = spaces(column) + lead;
          if (open.has(term.id)) {
            this.lines.push(`${first}[Circular reference to term ${term.id}]`);
            break;
          }

          const startLine = this.lines.length;
          const loc: TermLocation = {
            startLine,
            endLine: startLine + 1, // EXCLUSIVE; moved past the term's last line when it has several
            termId: term.id,
            kind: term.term_type,
            label: termLabel(term),
          };
          this.locations.push(loc);
          // Where the term's own text starts: hints are placed from there.
          const prefixLength = Math.min(column, MAX_INDENT) + lead.length;
          const child = (term: Term, lead: string): Task => ({ k: 'term', term, column: base + 2, lead, base: base + 2 });
          const item = (term: Term): Task => ({ k: 'term', term, column: base + 4, lead: '', base: base + 4 });
          // Tasks come off the stack last pushed first: `push` takes them in the order they print.
          const push = (...inOrder: Task[]) => {
            open.set(term.id, (open.get(term.id) ?? 0) + 1);
            tasks.push({ k: 'leave', id: term.id }, { k: 'end', loc });
            for (let i = inOrder.length - 1; i >= 0; i--) tasks.push(inOrder[i]);
          };
          const separated = (items: Task[]): Task[] => items.flatMap((t, i) => (i < items.length - 1 ? [t, { k: 'comma' } as Task] : [t]));

          switch (term.term_type) {
            case 'Var':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)} ${term.name}`);
              this.createTermHints(startLine, term.term_type, term.id, prefixLength);
              break;
            case 'Error':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)}`);
              this.createTermHints(startLine, term.term_type, term.id, prefixLength);
              break;
            case 'Builtin':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)} ${term.fun}`);
              this.createBuiltinHints(startLine, term.term_type, term.id, prefixLength);
              break;
            case 'Apply':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)} {`);
              this.createTermHints(startLine, term.term_type, term.id, prefixLength);
              push(child(term.function, 'fun: '), { k: 'comma' }, child(term.argument, 'arg: '), line(base, '}'));
              break;
            case 'Delay':
            case 'Force':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)} {`);
              this.createTermHints(startLine, term.term_type, term.id, prefixLength);
              push(child(term.term, 'term: '), line(base, '}'));
              break;
            case 'Lambda':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)} ${term.parameterName} {`);
              this.createTermHints(startLine, term.term_type, term.id, prefixLength);
              push(child(term.body, 'body: '), line(base, '}'));
              break;
            case 'Constr':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)} {`);
              this.createTermHints(startLine, term.term_type, term.id, prefixLength);
              this.lines.push(`${spaces(base + 2)}tag: ${term.constructorTag},`, `${spaces(base + 2)}fields: [`);
              push(...separated(term.fields.map(item)), line(base + 2, ']'), line(base, '}'));
              break;
            case 'Case':
              this.lines.push(`${first}${this.getShortTermType(term.term_type)} {`);
              this.createTermHints(startLine, term.term_type, term.id, prefixLength);
              push(
                child(term.constr, 'constr: '),
                { k: 'comma' },
                line(base + 2, 'branches: ['),
                ...separated(term.branches.map(item)),
                line(base + 2, ']'),
                line(base, '}'),
              );
              break;
            case 'Constant': {
              const constantData = this.parseConstantData(term.constant);
              this.createConstantHints(startLine, term.term_type, term.id, prefixLength);
              if (this.shouldUseInlineFormat(constantData.type)) {
                // Inline format for simple types
                this.lines.push(`${first}${this.getShortTermType(term.term_type)} ${constantData.type}: ${this.formatConstantValue(constantData.value)}`);
              } else {
                tasks.push({ k: 'end', loc });
                this.constant({ k: 'constant', constant: term.constant, column, lead, base, top: true }, tasks);
              }
              break;
            }
            default: {
              // Exhaustive check - all types should be handled above
              const _exhaustiveCheck: never = term;
              throw new Error(`Unhandled term type: ${JSON.stringify(_exhaustiveCheck)}`);
            }
          }
          break;
        }
      }
    }
  }

  /**
   * A constant that takes several lines, its first one `lead` at `column`: a list, an array or a
   * pair laid out field by field (its elements in turn), anything else as the JSON of its value.
   * `top` for the constant of a `Constant` term, whose first line says so (`Const ProtoList {`).
   */
  private constant(task: Extract<Task, { k: 'constant' }>, tasks: Task[]): void {
    const { constant, column, lead, base, top } = task;
    const first = spaces(column) + lead;
    const { type, value } = this.parseConstantData(constant);
    const line = (column: number, text: string): Task => ({ k: 'line', column, text });
    // An element: inline when its type is a simple one, a constant of its own otherwise.
    const element = (elementType: string, element: Constant, column: number, lead: string, base: number): Task =>
      this.shouldUseInlineFormat(elementType)
        ? line(column, lead + this.formatConstantValue(this.parseConstantData(element).value))
        : { k: 'constant', constant: element, column, lead, base, top: false };
    const inOrder = (...items: Task[]) => {
      for (let i = items.length - 1; i >= 0; i--) tasks.push(items[i]);
    };
    const header = `${top ? `${this.getShortTermType('Constant')} ` : ''}${type} {`;

    if (type === 'ProtoList' || type === 'ProtoArray') {
      // ProtoList (and ProtoArray) structure: elementType + values array
      const list = value as ProtoListData;
      const elementType = this.formatType(list.elementType);
      this.lines.push(first + header);
      const values = (list.values ?? []).map((v) => element(elementType, v, base + 4, '', base + 4));
      inOrder(
        line(base + 2, `elementType: ${elementType},`),
        line(base + 2, 'values: ['),
        ...values.flatMap((t, i) => (i < values.length - 1 ? [t, { k: 'comma' } as Task] : [t])),
        line(base + 2, ']'),
        line(base, '}'),
      );
    } else if (type === 'ProtoPair') {
      // ProtoPair structure: first_type + second_type + first_element + second_element
      const pair = value as ProtoPairData;
      const firstType = this.formatType(pair.first_type);
      const secondType = this.formatType(pair.second_type);
      this.lines.push(first + header);
      inOrder(
        line(base + 2, `first_type: ${firstType},`),
        line(base + 2, `second_type: ${secondType},`),
        element(firstType, pair.first_element, base + 2, 'first_element: ', base + 2),
        { k: 'comma' },
        element(secondType, pair.second_element, base + 2, 'second_element: ', base + 2),
        line(base, '}'),
      );
    } else {
      // Anything else (Data, BLS, Value) as the JSON of its value: an object's fields inside the
      // constant's own braces, any other value's lines as they come.
      const json = jsonLines(value);
      const object = json.length > 2 && json[0].text === '{' && json[json.length - 1].text === '}';
      if (object) {
        this.lines.push(first + header);
        for (const l of json.slice(1, -1)) this.lines.push(spaces(base + l.indent) + l.text);
        this.lines.push(spaces(base) + '}');
      } else if (top) {
        this.lines.push(first + header);
        for (const l of json) this.lines.push(spaces(base + 2 + l.indent) + l.text);
        this.lines.push(spaces(base) + '}');
      } else {
        this.lines.push(`${first}${type} ${json[0].text}`);
        for (const l of json.slice(1)) this.lines.push(spaces(base + l.indent) + l.text);
      }
    }
  }

}
