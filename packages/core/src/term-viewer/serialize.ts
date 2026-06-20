// Pure term serializer — ported verbatim from the VS Code extension's
// `term-viewer.ts` (`processTermWithLocations` + formatters + hint builders +
// `findTermAtLine`/`findNearestTerm`). This is platform-agnostic string/range
// math: it turns a `Term` into the exact text the editor renders, plus the
// per-term line ranges (`TermLocation[]`, the line↔termId mapping that powers
// breakpoints and the debugger-line highlight) and inlay hints (`TermHintInfo[]`).
//
// The original used `json-bigint` with `storeAsString: true`. In this data model
// every large integer already arrives as a string (`Constant.Integer.value: string`,
// `PlutusData.Int: { Int: string }`, etc.) and no JS `bigint`/BigNumber instances
// are ever produced, so plain `JSON.stringify` is byte-identical here and keeps
// core dependency-free (matching `uplc-tree/nodes.ts`).

import type { Constant, Term, Type } from '../debugger-types';

export interface TermLocation {
  startLine: number;
  endLine: number;
  termId: number;
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

type StructuredConstantData = ProtoListData | ProtoPairData;

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
  const result = s.processTermWithLocations(term, 0, new Set(), 0, true, '');
  return { text: result.text, locations: s.locations, hints: s.hints };
}

/** Most-nested location (smallest line span) among `locs` — the tie-break findTermAtLine uses. */
function mostNested(locs: TermLocation[]): TermLocation {
  return locs.reduce((best, cur) =>
    cur.endLine - cur.startLine < best.endLine - best.startLine ? cur : best);
}

/** Append a child's rendered text, re-indenting its continuation lines by `cont` (`'\n' + spaces`);
 *  the first line stays inline after the caller's `field: ` prefix. */
function appendChild(text: string, cont: string): string {
  const lines = text.split('\n');
  return lines.length > 1 ? lines[0] + lines.slice(1).map((l) => cont + l).join('') : text;
}

/**
 * Map an editor line (0-based) to the most specific term that owns it.
 * First prefers terms starting exactly on the line (most nested wins), then
 * falls back to the most nested containing term. Ported from `term-viewer.ts`.
 */
export function findTermAtLine(line: number, termLocations: TermLocation[]): TermLocation | undefined {
  // First, try to find terms that start exactly at this line
  const termsStartingAtLine = termLocations.filter((loc) => loc.startLine === line);

  if (termsStartingAtLine.length > 0) {
    // If multiple terms start at the same line, prefer the most nested one (smallest range)
    return mostNested(termsStartingAtLine);
  }

  // If no terms start at this line, find all terms that contain the given line
  const containingTerms = termLocations.filter((loc) => line >= loc.startLine && line <= loc.endLine);

  if (containingTerms.length === 0) {
    return undefined;
  }

  // Return the most nested term (smallest range)
  return mostNested(containingTerms);
}

/** Find the term whose start line is closest to `line`. Ported from `term-viewer.ts`. */
export function findNearestTerm(line: number, termLocations: TermLocation[]): TermLocation | undefined {
  if (termLocations.length === 0) {
    return undefined;
  }

  // Find the term with startLine closest to the current line
  return termLocations.reduce((nearest, current) => {
    const currentDistance = Math.abs(current.startLine - line);
    const nearestDistance = Math.abs(nearest.startLine - line);
    return currentDistance < nearestDistance ? current : nearest;
  });
}

/**
 * Resolve a line to a term id the way the gutter does: the term at the line if
 * any, otherwise the nearest term. Returns the breakpoint line (term start) and
 * its term id, or undefined if there are no terms.
 */
export function termAtLineForBreakpoint(
  line: number,
  termLocations: TermLocation[],
): { line: number; termId: number } | undefined {
  let termLocation = findTermAtLine(line, termLocations);
  if (!termLocation) {
    termLocation = findNearestTerm(line, termLocations);
    if (!termLocation) {
      return undefined;
    }
  }
  return { line: termLocation.startLine, termId: termLocation.termId };
}

class TermSerializer {
  readonly locations: TermLocation[] = [];
  readonly hints: TermHintInfo[] = [];

  private createTermHints(line: number, termType: string, termId: number, prefixLength: number, termText: string = ''): void {
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

    // "id:" hint - calculate position based on term text
    // Find position before opening brace or at end of line
    let idPos = prefixLength + termText.length;
    const braceIndex = termText.indexOf(' {');
    if (braceIndex !== -1) {
      idPos = prefixLength + braceIndex;
    } else if (termText.endsWith(',')) {
      idPos = prefixLength + termText.length - 1;
    }

    hints.push({
      line: line,
      character: idPos,
      text: ` id:${termId}`,
      kind: 'name',
    });
  }

  private createBuiltinHints(line: number, termType: string, termId: number, functionName: string, prefixLength: number): void {
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

    // "fn:" hint after the term type
    const shortTermType = this.getShortTermType(termType);
    const fnHintPos = startPos + shortTermType.length + 1; // +1 for space after term type
    hints.push({
      line: line,
      character: fnHintPos,
      text: `fn:`,
      kind: 'builtin_function',
    });

    // "id:" hint at the end of line
    const fullText = `${shortTermType} ${functionName}`;
    hints.push({
      line: line,
      character: prefixLength + fullText.length,
      text: ` id:${termId}`,
      kind: 'name',
    });
  }

  private createConstantHints(line: number, termType: string, termId: number, constantType: string, prefixLength: number, termText: string = ''): void {
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

    // "type:" hint after "Const "
    const shortTermType = this.getShortTermType(termType);
    const typeHintPos = startPos + shortTermType.length + 1; // +1 for space after "Const"
    hints.push({
      line: line,
      character: typeHintPos,
      text: `type:`,
      kind: 'constant_type',
    });

    // "id:" hint - calculate position based on term text
    // Find position before opening brace or at end of line
    let idPos = prefixLength + termText.length;
    const braceIndex = termText.indexOf(' {');
    if (braceIndex !== -1) {
      idPos = prefixLength + braceIndex;
    } else if (termText.endsWith(',')) {
      idPos = prefixLength + termText.length - 1;
    }

    hints.push({
      line: line,
      character: idPos,
      text: ` id:${termId}`,
      kind: 'name',
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
    // Note: 'List' is the same as 'ProtoList', 'Pair' is the same as 'ProtoPair'
    const multilineTypes = ['Data', 'Bls12_381G1Element', 'Bls12_381G2Element', 'Bls12_381MlResult', 'ProtoList', 'ProtoPair', 'List', 'Pair'];

    // If explicitly marked as multiline, use multiline format
    if (multilineTypes.includes(type)) {
      return false;
    }

    // Otherwise use inline format for simple types
    return inlineTypes.includes(type);
  }

  private formatConstantValue(value: ConstantData['value']): string {
    if (typeof value === 'string') {
      return `"${value}"`;
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

  private renderNestedConstant(type: string, value: Constant, currentLine: number, indentLevel: number): { text: string; endLine: number } {
    let output = '';
    let line = currentLine;

    // Parse the constant data first to get consistent type and value
    const constantData = this.parseConstantData(value);
    const actualType = constantData.type;
    const actualValue = constantData.value;

    // Handle structured types (ProtoList, ProtoPair and their aliases)
    if (actualType === 'ProtoList' || actualType === 'List' || actualType === 'ProtoPair' || actualType === 'Pair') {
      const standardType = actualType === 'List' ? 'ProtoList' : actualType === 'Pair' ? 'ProtoPair' : actualType;
      return this.renderStructuredType(standardType, actualValue, line, indentLevel, true);
    }

    // Handle Data type with special formatting
    if (actualType === 'Data') {
      const dataJson = JSON.stringify(actualValue, null, 2);
      const jsonLines = dataJson.split('\n');

      if (jsonLines.length > 2 && jsonLines[0] === '{' && jsonLines[jsonLines.length - 1] === '}') {
        // Remove outer braces and adjust indentation
        const contentLines = jsonLines.slice(1, -1).map((line) => (line.startsWith('  ') ? line.slice(2) : line));
        output = [`${actualType} {`, contentLines.map((line) => `  ${line}`).join('\n'), '}'].join('\n');
        line += 1 + contentLines.length + 1; // +1 for the closing brace
      } else {
        output = `${actualType} ${dataJson}`;
        line += 1;
      }
      return { text: output, endLine: line };
    }

    // Handle other complex types with JSON representation
    const constantJson = JSON.stringify(actualValue, null, 2);
    const jsonLines = constantJson.split('\n');

    if (jsonLines.length > 2 && jsonLines[0] === '{' && jsonLines[jsonLines.length - 1] === '}') {
      // Remove outer braces and adjust indentation
      const contentLines = jsonLines.slice(1, -1).map((line) => (line.startsWith('  ') ? line.slice(2) : line));
      output = [`${actualType} {`, contentLines.map((line) => `  ${line}`).join('\n'), '}'].join('\n');
      line += 1 + contentLines.length + 1; // +1 for the closing brace
    } else {
      output = `${actualType} ${constantJson}`;
      line += 1;
    }

    return { text: output, endLine: line };
  }

  private renderStructuredType(type: string, value: StructuredConstantData, currentLine: number, indentLevel: number, nestedConsts: boolean = false): { text: string; endLine: number } {
    let output = '';
    let line = currentLine;

    if (type === 'ProtoList') {
      const protoListValue = value as ProtoListData;

      // ProtoList structure: elementType + values array
      if (nestedConsts) {
        output = `${type} {`;
      } else {
        output = `${this.getShortTermType('Constant')} ${type} {`;
      }
      line += 1; // Account for the header line

      // elementType field
      output += '\n  elementType: ';
      line += 1;
      const elementTypeStr = this.formatType(protoListValue.elementType);

      output += elementTypeStr;
      output += ',';

      // values array
      output += '\n  values: [';
      line += 1;

      if (protoListValue.values && Array.isArray(protoListValue.values)) {
        for (let i = 0; i < protoListValue.values.length; i++) {
          output += '\n    ';
          line += 1;

          // Check if element should be formatted inline or as complex type
          if (this.shouldUseInlineFormat(elementTypeStr)) {
            const valueData = this.parseConstantData(protoListValue.values[i]);
            output += this.formatConstantValue(valueData.value);
          } else {
            // Recursively process complex constants
            const nestedResult = this.renderNestedConstant(elementTypeStr, protoListValue.values[i], line, indentLevel + 2);
            // For multiline nested constants, we need to indent properly
            const nestedLines = nestedResult.text.split('\n');
            if (nestedLines.length > 1) {
              output += nestedLines[0];
              output += nestedLines.slice(1).map((line) => '\n    ' + line).join('');
            } else {
              output += nestedResult.text;
            }
            // The last line is at nestedResult.endLine - 1
            line = nestedResult.endLine - 1;
          }

          if (i < protoListValue.values.length - 1) {
            output += ',';
          }
        }
      }

      output += '\n  ]';
      line += 1;
      output += '\n}';
      line += 1;
    } else if (type === 'ProtoPair') {
      const protoPairValue = value as ProtoPairData;

      // ProtoPair structure: first_type + second_type + first_element + second_element
      if (nestedConsts) {
        output = `${type} {`;
      } else {
        output = `${this.getShortTermType('Constant')} ${type} {`;
      }
      line += 1; // Account for the header line

      // first_type field
      output += '\n  first_type: ';
      line += 1;
      const firstTypeStr = this.formatType(protoPairValue.first_type);

      output += firstTypeStr;
      output += ',';

      // second_type field
      output += '\n  second_type: ';
      line += 1;
      const secondTypeStr = this.formatType(protoPairValue.second_type);

      output += secondTypeStr;
      output += ',';

      // first_element field
      output += '\n  first_element: ';
      line += 1;

      if (this.shouldUseInlineFormat(firstTypeStr)) {
        const firstElementData = this.parseConstantData(protoPairValue.first_element);
        output += this.formatConstantValue(firstElementData.value);
      } else {
        // Recursively process complex constants
        const nestedResult = this.renderNestedConstant(firstTypeStr, protoPairValue.first_element, line, indentLevel + 1);
        // For multiline nested constants, we need to indent properly
        const nestedLines = nestedResult.text.split('\n');
        if (nestedLines.length > 1) {
          output += nestedLines[0];
          output += nestedLines.slice(1).map((line) => '\n  ' + line).join('');
        } else {
          output += nestedResult.text;
        }
        // The last line is at nestedResult.endLine - 1
        line = nestedResult.endLine - 1;
      }
      output += ',';

      // second_element field
      output += '\n  second_element: ';
      line += 1;

      if (this.shouldUseInlineFormat(secondTypeStr)) {
        const secondElementData = this.parseConstantData(protoPairValue.second_element);
        output += this.formatConstantValue(secondElementData.value);
      } else {
        // Recursively process complex constants
        const nestedResult = this.renderNestedConstant(secondTypeStr, protoPairValue.second_element, line, indentLevel + 1);
        // For multiline nested constants, we need to indent properly
        const nestedLines = nestedResult.text.split('\n');
        if (nestedLines.length > 1) {
          output += nestedLines[0];
          output += nestedLines.slice(1).map((line) => '\n  ' + line).join('');
        } else {
          output += nestedResult.text;
        }
        // The last line is at nestedResult.endLine - 1
        line = nestedResult.endLine - 1;
      }

      output += '\n}';
      line += 1;
    }

    return { text: output, endLine: line };
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

  processTermWithLocations(
    term: Term,
    startLine: number,
    visited: Set<string | number> = new Set(),
    indentLevel: number = 0,
    shouldCreateHints: boolean = true,
    prefix: string = '',
  ): { text: string; endLine: number } {
    // Check for circular references
    if (visited.has(term.id)) {
      return {
        text: `[Circular reference to term ${term.id}]`,
        endLine: startLine,
      };
    }

    visited.add(term.id);
    let currentLine = startLine;

    const termLocations = this.locations;

    // Temporarily create termLocation that will be updated later
    const termLocationIndex = termLocations.length;
    termLocations.push({
      startLine: currentLine,
      endLine: currentLine, // Will be updated later
      termId: term.id,
    });

    let output = '';
    switch (term.term_type) {
      case 'Var':
        output = `${this.getShortTermType(term.term_type)} ${term.name}`;
        if (shouldCreateHints) {
          // For root terms use indentLevel, for nested terms use prefix length
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        currentLine += 1;
        break;

      case 'Apply': {
        output = `${this.getShortTermType(term.term_type)} {`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        currentLine += 1; // Apply { line

        output += '\n  fun: ';
        const funcStartLine = currentLine;
        currentLine += 1; // fun: line - this is where the nested term starts
        const funcPrefix = '  '.repeat(indentLevel + 1) + 'fun: ';
        const funcResult = this.processTermWithLocations(term.function, funcStartLine, visited, indentLevel + 1, true, funcPrefix);
        output += appendChild(funcResult.text, '\n  ');
        currentLine = funcResult.endLine;
        output += ',';

        output += '\n  arg: ';
        const argStartLine = currentLine;
        currentLine += 1; // arg: line - this is where the nested term starts
        const argPrefix = '  '.repeat(indentLevel + 1) + 'arg: ';
        const argResult = this.processTermWithLocations(term.argument, argStartLine, visited, indentLevel + 1, true, argPrefix);
        output += appendChild(argResult.text, '\n  ');
        currentLine = argResult.endLine;
        output += '\n}';
        currentLine += 1; // closing } line
        break;
      }

      case 'Delay': {
        output = `${this.getShortTermType(term.term_type)} {`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        currentLine += 1; // Account for the header line

        output += '\n  term: ';
        const delayStartLine = currentLine;
        currentLine += 1; // term: line - this is where the nested term starts
        const delayPrefix = '  '.repeat(indentLevel + 1) + 'term: ';
        const delayTermResult = this.processTermWithLocations(term.term, delayStartLine, visited, indentLevel + 1, true, delayPrefix);
        output += appendChild(delayTermResult.text, '\n  ');
        currentLine = delayTermResult.endLine;
        output += '\n}';
        currentLine += 1; // closing } line
        break;
      }

      case 'Lambda': {
        output = `${this.getShortTermType(term.term_type)} ${term.parameterName} {`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        currentLine += 1; // Lambda line

        output += '\n  body: ';
        const bodyStartLine = currentLine;
        currentLine += 1; // body: line - this is where the nested term starts
        const bodyPrefix = '  '.repeat(indentLevel + 1) + 'body: ';
        const bodyResult = this.processTermWithLocations(term.body, bodyStartLine, visited, indentLevel + 1, true, bodyPrefix);
        output += appendChild(bodyResult.text, '\n  ');
        currentLine = bodyResult.endLine;
        output += '\n}';
        currentLine += 1; // closing } line
        break;
      }

      case 'Force': {
        output = `${this.getShortTermType(term.term_type)} {`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        currentLine += 1; // Account for the header line

        output += '\n  term: ';
        const forceStartLine = currentLine;
        currentLine += 1; // term: line - this is where the nested term starts
        const forcePrefix = '  '.repeat(indentLevel + 1) + 'term: ';
        const forceTermResult = this.processTermWithLocations(term.term, forceStartLine, visited, indentLevel + 1, true, forcePrefix);
        output += appendChild(forceTermResult.text, '\n  ');
        currentLine = forceTermResult.endLine;
        output += '\n}';
        currentLine += 1; // closing } line
        break;
      }

      case 'Constant': {
        // Parse the constant data to extract type and value
        const constantData = this.parseConstantData(term.constant);

        if (this.shouldUseInlineFormat(constantData.type)) {
          // Use inline format for simple types
          output = `${this.getShortTermType(term.term_type)} ${constantData.type}: ${this.formatConstantValue(constantData.value)}`;
          if (shouldCreateHints) {
            const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
            this.createConstantHints(currentLine, term.term_type, term.id, constantData.type, prefixLength, output);
          }
          currentLine += 1;
        } else {
          // Use multiline format for complex types (Data, Bls12_381 types, etc.)
          if (constantData.type === 'ProtoList' || constantData.type === 'ProtoPair') {
            // Use structured rendering for ProtoList and ProtoPair
            const firstLineOutput = `${this.getShortTermType(term.term_type)} ${constantData.type} {`;
            if (shouldCreateHints) {
              const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
              this.createConstantHints(currentLine, term.term_type, term.id, constantData.type, prefixLength, firstLineOutput);
            }

            const structuredResult = this.renderStructuredType(constantData.type, constantData.value, currentLine, indentLevel, false);
            output = structuredResult.text;
            currentLine = structuredResult.endLine;
          } else {
            // Use standard JSON format for other complex types
            const firstLineOutput = `${this.getShortTermType(term.term_type)} ${constantData.type} {`;
            if (shouldCreateHints) {
              const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
              this.createConstantHints(currentLine, term.term_type, term.id, constantData.type, prefixLength, firstLineOutput);
            }

            // Use the parsed value from constantData, which already has type removed
            const constantJson = JSON.stringify(constantData.value, null, 2);

            // Remove outer braces if the JSON is an object
            const jsonLines = constantJson.split('\n');
            let contentLines: string[];
            if (jsonLines.length > 2 && jsonLines[0] === '{' && jsonLines[jsonLines.length - 1] === '}') {
              // Remove first and last lines (outer braces) and reduce indentation
              contentLines = jsonLines.slice(1, -1).map((line) => (line.startsWith('  ') ? line.slice(2) : line));
            } else {
              // Keep as is for non-objects
              contentLines = jsonLines;
            }

            // Include the type in the header: Const <type> <name> {
            output = [firstLineOutput, contentLines.map((line) => `  ${line}`).join('\n'), '}'].join('\n');
            // Calculate number of lines (header + content + closing brace)
            currentLine += 1 + contentLines.length + 1;
          }
        }
        break;
      }

      case 'Error':
        output = `${this.getShortTermType(term.term_type)}`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        currentLine += 1;
        break;

      case 'Builtin':
        output = `${this.getShortTermType(term.term_type)} ${term.fun}`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createBuiltinHints(currentLine, term.term_type, term.id, term.fun, prefixLength);
        }
        currentLine += 1;
        break;

      case 'Constr': {
        output = `${this.getShortTermType(term.term_type)} {`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        const constrHeader = [output, `  tag: ${term.constructorTag},`, '  fields: ['].join('\n');
        output = constrHeader;
        currentLine += 2;

        for (let i = 0; i < term.fields.length; i++) {
          output += '\n    ';
          const fieldStartLine = currentLine;
          currentLine += 1; // field line - this is where the nested term starts
          const fieldPrefix = '  '.repeat(indentLevel + 2);
          const fieldResult = this.processTermWithLocations(term.fields[i], fieldStartLine, visited, indentLevel + 2, true, fieldPrefix);
          output += appendChild(fieldResult.text, '\n    ');
          currentLine = fieldResult.endLine;
          if (i < term.fields.length - 1) {
            output += ',';
          }
        }
        output += '\n  ]';
        currentLine += 1; // ] line
        output += '\n}';
        currentLine += 1;
        break;
      }

      case 'Case': {
        output = `${this.getShortTermType(term.term_type)} {`;
        if (shouldCreateHints) {
          const prefixLength = prefix === '' ? indentLevel * 2 : prefix.length;
          this.createTermHints(currentLine, term.term_type, term.id, prefixLength, output);
        }
        currentLine += 1; // Account for the header line

        output += '\n  constr: ';
        const constrStartLine = currentLine;
        currentLine += 1; // constr: line - this is where the nested term starts
        const constrPrefix = '  '.repeat(indentLevel + 1) + 'constr: ';
        const constrResult = this.processTermWithLocations(term.constr, constrStartLine, visited, indentLevel + 1, true, constrPrefix);
        output += appendChild(constrResult.text, '\n  ');
        currentLine = constrResult.endLine;
        output += ',';

        output += '\n  branches: [';
        currentLine += 1; // branches: [ line
        for (let i = 0; i < term.branches.length; i++) {
          output += '\n    ';
          const branchStartLine = currentLine;
          currentLine += 1; // branch line - this is where the nested term starts
          const branchPrefix = '  '.repeat(indentLevel + 2);
          const branchResult = this.processTermWithLocations(term.branches[i], branchStartLine, visited, indentLevel + 2, true, branchPrefix);
          output += appendChild(branchResult.text, '\n    ');
          currentLine = branchResult.endLine;
          if (i < term.branches.length - 1) {
            output += ',';
          }
        }
        output += '\n  ]';
        currentLine += 1;
        output += '\n}';
        currentLine += 1; // closing } line
        break;
      }

      default: {
        // Exhaustive check - all types should be handled above
        const _exhaustiveCheck: never = term;
        throw new Error(`Unhandled term type: ${JSON.stringify(_exhaustiveCheck)}`);
      }
    }

    // Update endLine for termLocation
    termLocations[termLocationIndex].endLine = currentLine;

    // Remove from visited set to allow same term to be processed in different branches
    visited.delete(term.id);

    return {
      text: output,
      endLine: currentLine,
    };
  }
}
