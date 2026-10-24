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
// A program nests as deep as its size allows (a 17 KB script, some 35 000 levels), so terms,
// constants, types and Plutus data are walked with an explicit stack, and the indentation stops
// growing at `MAX_INDENT` columns: a deeper term still starts its own line, so the line↔term
// mapping holds, but the text grows with the depth instead of with its square.
//
// Produces the same `SerializedTerm` shape as `serialize.ts` (text + line↔termId
// locations); it emits no inlay hints — the canonical syntax is self-describing.

import type { Constant, PlutusData, Term, Type, ValueAsset } from '../debugger-types';
import { builtinName, termLabel } from './builtin-name';
import { indentation } from './indent';
import type { SerializedTerm, TermLocation } from './serialize';

/** Serialize a term into canonical UPLC text + its line↔termId locations. */
export function serializeTermUplc(term: Term): SerializedTerm {
  const p = new UplcPretty();
  p.walk(term);
  return { text: p.lines.join('\n'), locations: p.locations, hints: [] };
}

/** A term still to print at a depth, or the line that closes a term already opened. */
type Task = { term: Term; depth: number } | { close: string; depth: number; loc: TermLocation };

class UplcPretty {
  readonly lines: string[] = [];
  readonly locations: TermLocation[] = [];

  /** Emit `root` and its subterms, a term per line, recording each one's line↔termId range. */
  walk(root: Term): void {
    const tasks: Task[] = [{ term: root, depth: 0 }];
    while (tasks.length > 0) {
      const task = tasks.pop()!;
      if ('close' in task) {
        this.lines.push(`${indentation(task.depth)}${task.close}`);
        task.loc.endLine = this.lines.length - 1;
        continue;
      }

      const { term, depth } = task;
      const indent = indentation(depth);
      const startLine = this.lines.length;
      // `kind`/`label` come from the shared helpers, not from the line we are about to print —
      // the profiler's `Node` column must read the same for a node in either rendering.
      const loc: TermLocation = {
        startLine,
        endLine: startLine, // INCLUSIVE here (the last line emitted), unlike serialize.ts
        termId: term.id,
        kind: term.term_type,
        label: termLabel(term),
      };
      this.locations.push(loc);
      // The opening line now; the children come off the stack in order, then the closing line.
      const open = (head: string, children: Term[], close: string) => {
        this.lines.push(`${indent}${head}`);
        tasks.push({ close, depth, loc });
        for (let i = children.length - 1; i >= 0; i--) tasks.push({ term: children[i], depth: depth + 1 });
      };

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
          open('(delay', [term.term], ')');
          break;
        case 'Force':
          open('(force', [term.term], ')');
          break;
        case 'Lambda':
          open(`(lam ${term.parameterName}`, [term.body], ')');
          break;
        case 'Apply':
          open('[', [term.function, term.argument], ']');
          break;
        case 'Constr':
          open(`(constr ${term.constructorTag}`, term.fields, ')');
          break;
        case 'Case':
          open('(case', [term.constr, ...term.branches], ')');
          break;
        default: {
          const _exhaustive: never = term;
          throw new Error(`Unhandled term type: ${JSON.stringify(_exhaustive)}`);
        }
      }
    }
  }
}

// ── Constants (mirrors uplc crate `Constant::to_doc`) ──────────────────────────────
//
// A constant takes one line, built by expanding nodes into parts on an explicit stack: text as is,
// or a type, a list/pair element or a Plutus Data node still to expand.

type Part = string | { type: Type } | { item: Constant } | { data: PlutusData };

function render(parts: Part[]): string {
  const out: string[] = [];
  const stack: Part[] = [...parts].reverse();
  while (stack.length > 0) {
    const part = stack.pop()!;
    if (typeof part === 'string') {
      out.push(part);
      continue;
    }
    const expanded = 'type' in part ? typeParts(part.type) : 'item' in part ? itemParts(part.item) : dataParts(part.data);
    for (let i = expanded.length - 1; i >= 0; i--) stack.push(expanded[i]);
  }
  return out.join('');
}

/** `open`, then `items` separated by `, `, then `close`. */
function listParts(open: string, items: Part[], close: string): Part[] {
  const parts: Part[] = [open];
  items.forEach((item, i) => {
    if (i > 0) parts.push(', ');
    parts.push(item);
  });
  parts.push(close);
  return parts;
}

/** The `<type> <value>` body that goes inside `(con …)`. */
function constant(c: Constant): string {
  switch (c.type) {
    case 'Integer': return `integer ${c.value}`;
    case 'ByteString': return `bytestring #${c.value}`;
    case 'String': return `string "${escapeStr(c.value)}"`;
    case 'Bool': return `bool ${c.value ? 'True' : 'False'}`;
    case 'Unit': return 'unit ()';
    case 'ProtoList': return render(['(list ', { type: c.elementType }, ') ', { item: c }]);
    case 'ProtoArray': return render(['(array ', { type: c.elementType }, ') ', { item: c }]);
    case 'ProtoPair': return render(['(pair ', { type: c.first_type }, ' ', { type: c.second_type }, ') ', { item: c }]);
    case 'Data': return render(['data (', { data: c.data }, ')']);
    case 'Bls12_381G1Element': return `bls12_381_G1_element 0x${c.serialized}`;
    case 'Bls12_381G2Element': return `bls12_381_G2_element 0x${c.serialized}`;
    case 'Bls12_381MlResult': return 'bls12_381_mlresult <opaque>';
    case 'Value': return `value ${valueItem(c.entries)}`;
    default: {
      const _exhaustive: never = c;
      throw new Error(`Unknown constant: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Bare element form used inside list/pair literals (uplc crate `to_doc_list`). */
function itemParts(c: Constant): Part[] {
  switch (c.type) {
    case 'Integer': return [c.value];
    case 'ByteString': return [`#${c.value}`];
    case 'String': return [`"${escapeStr(c.value)}"`];
    case 'Bool': return [c.value ? 'True' : 'False'];
    case 'Unit': return ['()'];
    case 'ProtoList': return listParts('[', c.values.map((item) => ({ item })), ']');
    case 'ProtoArray': return listParts('[', c.values.map((item) => ({ item })), ']');
    case 'ProtoPair': return ['(', { item: c.first_element }, ', ', { item: c.second_element }, ')'];
    case 'Data': return [{ data: c.data }];
    case 'Bls12_381G1Element': return [`0x${c.serialized}`];
    case 'Bls12_381G2Element': return [`0x${c.serialized}`];
    case 'Bls12_381MlResult': return ['<opaque>'];
    case 'Value': return [valueItem(c.entries)];
    default: {
      const _exhaustive: never = c;
      throw new Error(`Unknown constant: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Value literal (uplc crate `to_doc_value`): `[(#currency, [(#token, quantity), …]), …]`. */
function valueItem(entries: ValueAsset[]): string {
  const assets = entries.map(
    (a) => `(#${a.currency}, [${a.tokens.map((t) => `(#${t.name}, ${t.quantity})`).join(', ')}])`,
  );
  return `[${assets.join(', ')}]`;
}

/** Type name (uplc crate `Type::to_doc`). */
function typeParts(t: Type): Part[] {
  switch (t.type) {
    case 'Bool': return ['bool'];
    case 'Integer': return ['integer'];
    case 'String': return ['string'];
    case 'ByteString': return ['bytestring'];
    case 'Unit': return ['unit'];
    case 'List': return ['(list ', { type: t.elementType }, ')'];
    case 'Array': return ['(array ', { type: t.elementType }, ')'];
    case 'Pair': return ['(pair ', { type: t.first_type }, ' ', { type: t.second_type }, ')'];
    case 'Data': return ['data'];
    case 'Bls12_381G1Element': return ['bls12_381_G1_element'];
    case 'Bls12_381G2Element': return ['bls12_381_G2_element'];
    case 'Bls12_381MlResult': return ['bls12_381_mlresult'];
    case 'Value': return ['value'];
    default: {
      const _exhaustive: never = t;
      throw new Error(`Unknown type: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** Plutus data (uplc crate `to_doc_list_plutus_data`): `Constr n [..]`, `Map [..]`, `I n`, `B #hex`, `List [..]`. */
function dataParts(d: PlutusData): Part[] {
  // Big-int variants carry the value under Int/BigUInt/BigNInt (and, at runtime, a
  // `type: 'BigInt'` tag too) — check these before the tagged switch below.
  if ('Int' in d) return [`I ${d.Int}`];
  if ('BigUInt' in d) return [`I ${d.BigUInt}`];
  if ('BigNInt' in d) return [`I -${d.BigNInt}`];
  switch (d.type) {
    case 'Constr':
      return listParts(`Constr ${constrIndex(d.tag, d.any_constructor)} [`, d.fields.map((data) => ({ data })), ']');
    case 'Map': {
      const parts: Part[] = ['Map ['];
      d.key_value_pairs.forEach((kv, i) => {
        if (i > 0) parts.push(', ');
        parts.push('(', { data: kv.key }, ', ', { data: kv.value }, ')');
      });
      parts.push(']');
      return parts;
    }
    case 'BoundedBytes':
      return [`B #${d.value}`];
    case 'Array':
      return listParts('List [', d.values.map((data) => ({ data })), ']');
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
