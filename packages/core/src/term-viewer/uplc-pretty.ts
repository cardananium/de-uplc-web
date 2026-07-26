// Canonical UPLC pretty-printer — the second editor rendering, matching the textual
// syntax produced by Aiken's `uplc` crate (crates/uplc/src/pretty.rs): parenthesized
// S-expressions `(lam x …)`, application `[f a]`, `(con integer 42)`, `(builtin …)`,
// `(delay …)`, `(force …)`, `(error)`, `(constr tag …)`, `(case …)`.
//
// Unlike the crate's `pretty`-crate layout (which collapses sub-terms onto one line
// when they fit in 80 cols), this always expands one term per line, because the line
// is the unit the debugger maps to: every term keeps its own start line, so the
// breakpoint gutter, current-term highlight and step still work in this view. For
// real (non-trivial) programs the crate also fully breaks, so the result matches.
//
// Produces the same `SerializedTerm` shape as `serialize.ts` (text + line↔termId
// locations); it emits no inlay hints — the canonical syntax is self-describing.

import type { Constant, PlutusData, Term, Type } from '../debugger-types';
import { builtinName, termLabel } from './builtin-name';
import type { SerializedTerm, TermLocation } from './serialize';

/** Serialize a term into canonical UPLC text + its line↔termId locations. */
export function serializeTermUplc(term: Term): SerializedTerm {
  const p = new UplcPretty();
  p.walk(term, '');
  return { text: p.lines.join('\n'), locations: p.locations, hints: [] };
}

class UplcPretty {
  readonly lines: string[] = [];
  readonly locations: TermLocation[] = [];

  /** Emit `term` (each line prefixed by `indent`) and record its line↔termId range. */
  walk(term: Term, indent: string): void {
    const startLine = this.lines.length;
    // `kind`/`label` come from the shared helpers, not from the line we are about to print —
    // the profiler's `Node` column must read the same for a node in either rendering.
    const loc: TermLocation = {
      startLine,
      endLine: startLine, // INCLUSIVE here (the last line emitted below), unlike serialize.ts
      termId: term.id,
      kind: term.term_type,
      label: termLabel(term),
    };
    this.locations.push(loc);
    const child = indent + '  ';

    switch (term.term_type) {
      case 'Var':
        this.lines.push(`${indent}${term.name}`);
        break;
      case 'Builtin':
        this.lines.push(`${indent}(builtin ${builtinName(term.fun)})`);
        break;
      case 'Error':
        this.lines.push(`${indent}(error)`);
        break;
      case 'Constant':
        this.lines.push(`${indent}(con ${constant(term.constant)})`);
        break;
      case 'Delay':
        this.lines.push(`${indent}(delay`);
        this.walk(term.term, child);
        this.lines.push(`${indent})`);
        break;
      case 'Force':
        this.lines.push(`${indent}(force`);
        this.walk(term.term, child);
        this.lines.push(`${indent})`);
        break;
      case 'Lambda':
        this.lines.push(`${indent}(lam ${term.parameterName}`);
        this.walk(term.body, child);
        this.lines.push(`${indent})`);
        break;
      case 'Apply':
        this.lines.push(`${indent}[`);
        this.walk(term.function, child);
        this.walk(term.argument, child);
        this.lines.push(`${indent}]`);
        break;
      case 'Constr':
        this.lines.push(`${indent}(constr ${term.constructorTag}`);
        for (const f of term.fields) this.walk(f, child);
        this.lines.push(`${indent})`);
        break;
      case 'Case':
        this.lines.push(`${indent}(case`);
        this.walk(term.constr, child);
        for (const b of term.branches) this.walk(b, child);
        this.lines.push(`${indent})`);
        break;
      default: {
        const _exhaustive: never = term;
        throw new Error(`Unhandled term type: ${JSON.stringify(_exhaustive)}`);
      }
    }
    loc.endLine = this.lines.length - 1;
  }
}

// ── Constants (mirrors uplc crate `Constant::to_doc`) ──────────────────────────────

/** The `<type> <value>` body that goes inside `(con …)`. */
function constant(c: Constant): string {
  switch (c.type) {
    case 'Integer': return `integer ${c.value}`;
    case 'ByteString': return `bytestring #${c.value}`;
    case 'String': return `string "${escapeStr(c.value)}"`;
    case 'Bool': return `bool ${c.value ? 'True' : 'False'}`;
    case 'Unit': return 'unit ()';
    case 'ProtoList':
      return `(list ${typeStr(c.elementType)}) [${c.values.map(constItem).join(', ')}]`;
    case 'ProtoPair':
      return `(pair ${typeStr(c.first_type)} ${typeStr(c.second_type)}) (${constItem(c.first_element)}, ${constItem(c.second_element)})`;
    case 'Data': return `data (${plutusData(c.data)})`;
    case 'Bls12_381G1Element': return `bls12_381_G1_element 0x${c.serialized}`;
    case 'Bls12_381G2Element': return `bls12_381_G2_element 0x${c.serialized}`;
    case 'Bls12_381MlResult': return 'bls12_381_mlresult <opaque>';
    default: {
      const _exhaustive: never = c;
      throw new Error(`Unknown constant: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Bare element form used inside list/pair literals (uplc crate `to_doc_list`). */
function constItem(c: Constant): string {
  switch (c.type) {
    case 'Integer': return c.value;
    case 'ByteString': return `#${c.value}`;
    case 'String': return `"${escapeStr(c.value)}"`;
    case 'Bool': return c.value ? 'True' : 'False';
    case 'Unit': return '()';
    case 'ProtoList': return `[${c.values.map(constItem).join(', ')}]`;
    case 'ProtoPair': return `(${constItem(c.first_element)}, ${constItem(c.second_element)})`;
    case 'Data': return plutusData(c.data);
    case 'Bls12_381G1Element': return `0x${c.serialized}`;
    case 'Bls12_381G2Element': return `0x${c.serialized}`;
    case 'Bls12_381MlResult': return '<opaque>';
    default: {
      const _exhaustive: never = c;
      throw new Error(`Unknown constant: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Type name (uplc crate `Type::to_doc`). */
function typeStr(t: Type): string {
  switch (t.type) {
    case 'Bool': return 'bool';
    case 'Integer': return 'integer';
    case 'String': return 'string';
    case 'ByteString': return 'bytestring';
    case 'Unit': return 'unit';
    case 'List': return `(list ${typeStr(t.elementType)})`;
    case 'Pair': return `(pair ${typeStr(t.first_type)} ${typeStr(t.second_type)})`;
    case 'Data': return 'data';
    case 'Bls12_381G1Element': return 'bls12_381_G1_element';
    case 'Bls12_381G2Element': return 'bls12_381_G2_element';
    case 'Bls12_381MlResult': return 'bls12_381_mlresult';
    default: {
      const _exhaustive: never = t;
      throw new Error(`Unknown type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Plutus data (uplc crate `to_doc_list_plutus_data`): `Constr n [..]`, `Map [..]`, `I n`, `B #hex`, `List [..]`. */
function plutusData(d: PlutusData): string {
  // Big-int variants carry the value under Int/BigUInt/BigNInt (and, at runtime, a
  // `type: 'BigInt'` tag too) — check these before the tagged switch below.
  if ('Int' in d) return `I ${d.Int}`;
  if ('BigUInt' in d) return `I ${d.BigUInt}`;
  if ('BigNInt' in d) return `I -${d.BigNInt}`;
  switch (d.type) {
    case 'Constr':
      return `Constr ${constrIndex(d.tag, d.any_constructor)} [${d.fields.map(plutusData).join(', ')}]`;
    case 'Map':
      return `Map [${d.key_value_pairs.map((kv) => `(${plutusData(kv.key)}, ${plutusData(kv.value)})`).join(', ')}]`;
    case 'BoundedBytes':
      return `B #${d.value}`;
    case 'Array':
      return `List [${d.values.map(plutusData).join(', ')}]`;
    default: {
      const _exhaustive: never = d;
      throw new Error(`Unknown plutus data: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** CBOR constructor tag → constructor index (uplc crate `convert_tag_to_constr`). */
function constrIndex(tag: number, anyConstructor?: number | null): number {
  if (tag >= 121 && tag <= 127) return tag - 121;
  if (tag >= 1280 && tag <= 1400) return tag - 1280 + 7;
  return anyConstructor ?? tag;
}

function escapeStr(s: string): string {
  return s.replace(/[\\"\n\r\t]/g, (c) => ESCAPES[c] ?? c);
}
const ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
