// Lazy data cursor — one uniform node over the WASM-backed lazy machine-state graph,
// replacing the ~8 per-type *Lazy classes (MachineState/Context/Env/Value/Constant/
// BuiltinRuntime/Term) + LoadableLazyNode. Identity is the HANDLE (`source` + `path`,
// the server-provided `_path`); the duplicated lazy-loading boilerplate (placeholder
// detection, the load callback, the placeholder label) lives here ONCE, and the genuinely
// per-type bits are two pure functions: `viewFor` (presentation) and `childrenFor`
// (child enumeration). Static display nodes (Simple/Truncation/Type/PlutusData) are reused.
//
// Quirk fix vs the old model: a CONSTANT or BUILTIN-RUNTIME placeholder used to load through
// LoadableLazyNode.convertDataToNodes, whose shape inference missed those types and dumped raw
// object fields. Here every placeholder loads into its TYPED children via `childrenFor`.

import {
  MachineStateLazy, MachineContextLazy, EnvLazy, ValueLazy, ConstantLazy,
  BuiltinRuntimeLazy, TermLazy, Type, PlutusData,
  EitherTermOrIdLazy, LazyLoadableTermOrId,
} from '../debugger-types';
import { IDebuggerEngine } from '../debugger/debugger-engine.interface';
import {
  UplcNode, NodeView, SimpleNode, LazyNode, TruncationInfoNode, TypeNode, PlutusDataNode,
  valuePreview, stringPreview, fullValueNode, PREVIEW_LEN,
} from './nodes';

export type LazyKind = 'machineState' | 'context' | 'env' | 'value' | 'constant' | 'runtime' | 'term';
export type DataSource = 'machineState' | 'context' | 'env';

interface Placeholder { _type: string; _kind: string; _length?: number | null; _path?: string[] }
function isPlaceholder(v: unknown): v is Placeholder {
  return !!v && typeof v === 'object' && '_type' in v && '_kind' in v;
}

/** Exhaustiveness guard: a new schema variant becomes a compile error instead of a silent empty render. */
function assertNever(x: never, what: string): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(x)}`);
}
function placeholderLabel(base: string, p: Placeholder): string {
  if (p._type && p._kind) return `${base} (${p._type}: ${p._kind})`;
  if (p._kind) return `${base} (${p._kind})`;
  return base;
}
function lazyLabel(base: string, p: Placeholder): string {
  let label = `${base} [${p._type}]`;
  if (p._length !== null && p._length !== undefined) label += ` (${p._length} items)`;
  return label + ' 🔄';
}
// Long scalar constants (bytes/int/string/BLS) show a preview + expand to the full value — see
// valuePreview/fullValueNode in nodes.ts (shared with Plutus-Data scalars).

/**
 * A position in the lazy machine-state graph. `data` is the shallow-loaded payload (or a
 * placeholder); `path` is the absolute handle within `source`. `session` is optional —
 * term subtrees walk their already-loaded structure without one (matching today's behaviour).
 */
export class LazyRef implements UplcNode {
  constructor(
    private readonly kind: LazyKind,
    public readonly data: unknown,
    private readonly label: string,
    public readonly path: string[] = [],
    public readonly dataSource: DataSource = 'machineState',
    private readonly session?: IDebuggerEngine,
  ) {}

  /** Exposes the cursor kind so a node-explorer tab can re-root at this node's handle. */
  get lazyKind(): string { return this.kind; }

  /** A term node carries its UPLC term id (from the loaded term's `id`), so the UI can reveal it. */
  get termId(): number | undefined {
    if (this.kind !== 'term') return undefined;
    const id = (this.data as { id?: unknown } | undefined)?.id;
    return typeof id === 'number' ? id : undefined;
  }

  toViewModel(): NodeView {
    if (isPlaceholder(this.data)) return placeholderView(this.kind, this.data, this.label);
    return viewFor(this.kind, this.data, this.label);
  }

  getChildren(): UplcNode[] | Promise<UplcNode[]> {
    if (isPlaceholder(this.data)) {
      if (this.session && this.path.length > 0) {
        const handle = this.data._path ?? this.path;
        // Load by handle, then enumerate by the KNOWN kind — the engine now returns the node's
        // own typed shape at every path (a ProtoList item loads as a bare ConstantLazy, not a
        // synthetic Con value), so no shape inference / generic fallback is needed.
        return Promise.resolve(this.session.getLazy(this.dataSource, handle, false)).then((loaded) =>
          childrenFor(this.kind, loaded, this.label, handle, this.dataSource, this.session),
        );
      }
      return [new SimpleNode('Data not loaded')];
    }
    return childrenFor(this.kind, this.data, this.label, this.path, this.dataSource, this.session);
  }
}

/** A term-or-id edge (machine state / context / value boundaries). Mirrors the old createTermNodeLazy. */
function termOrIdRef(termOrId: EitherTermOrIdLazy | LazyLoadableTermOrId, label: string): UplcNode {
  if (isPlaceholder(termOrId)) return new LazyNode(lazyLabel(label, termOrId)); // dead-end placeholder (icon 'sync')
  const loaded = termOrId as EitherTermOrIdLazy;
  if (loaded.type === 'Term') return new LazyRef('term', loaded.term, label); // termId via the getter
  return new SimpleNode(`${label} (Term ID: ${loaded.id})`, loaded.id);
}

// ── presentation (placeholder) ──────────────────────────────────────────────────

const PLACEHOLDER_ICON: Record<Exclude<LazyKind, 'value'>, string> = {
  machineState: 'gear',
  context: 'symbol-namespace',
  env: 'symbol-field',
  constant: 'symbol-constant',
  runtime: 'symbol-method',
  term: 'symbol-misc',
};

function placeholderView(kind: LazyKind, p: Placeholder, label: string): NodeView {
  if (kind === 'value') {
    return { label: placeholderLabel(label, p), collapsible: true, icon: valuePlaceholderIcon(p), contextValue: 'uplcNode' };
  }
  const base = kind === 'machineState' ? label : kind === 'runtime' ? 'Builtin Runtime' : label;
  const displayLabel = kind === 'runtime'
    ? placeholderLabel('Builtin Runtime', p)
    : placeholderLabel(base, p);
  return { label: displayLabel, collapsible: true, icon: PLACEHOLDER_ICON[kind], contextValue: 'uplcNode' };
}

function valuePlaceholderIcon(p: Placeholder): string {
  switch (p._type) {
    case 'Con':
      switch (p._kind) {
        case 'Integer': return 'symbol-number';
        case 'ByteString': return 'symbol-array';
        case 'String': return 'symbol-string';
        case 'Bool': return 'symbol-boolean';
        case 'Unit': return 'symbol-misc';
        case 'ProtoList': return 'list-unordered';
        case 'ProtoPair': return 'symbol-interface';
        case 'Data': return 'symbol-object';
        default: return 'symbol-constant';
      }
    case 'Builtin': return 'symbol-module';
    case 'Lambda': return 'symbol-function';
    case 'Delay': return 'debug-pause';
    case 'Constr': return 'symbol-class';
    default: return 'symbol-field';
  }
}

// ── presentation (loaded) ───────────────────────────────────────────────────────

function valueIcon(t: string): string {
  switch (t) {
    case 'Con': return 'symbol-constant';
    case 'Delay': return 'debug-pause';
    case 'Lambda': return 'symbol-function';
    case 'Builtin': return 'symbol-module';
    case 'Constr': return 'symbol-class';
    default: return 'symbol-field';
  }
}

function constantView(c: ConstantLazy, base: string): NodeView {
  const icon =
    c.type === 'Integer' ? 'symbol-number' :
    c.type === 'ByteString' ? 'symbol-array' :
    c.type === 'String' ? 'symbol-string' :
    c.type === 'Bool' ? 'symbol-boolean' :
    c.type === 'ProtoList' ? 'list-unordered' :
    c.type === 'ProtoPair' ? 'symbol-interface' :
    c.type === 'Data' ? 'symbol-object' :
    c.type === 'Unit' ? 'symbol-misc' : 'symbol-constant';
  // Scalars (int/bytes/string/BLS) → preview + expand-if-long; structural (List/Pair/Data) collapse
  // by content; Bool/Unit are short leaves.
  let label: string;
  let collapsible: boolean;
  if (c.type === 'Integer') ({ label, collapsible } = valuePreview(`${base}: `, c.value));
  else if (c.type === 'String') ({ label, collapsible } = stringPreview(`${base}: `, c.value));
  else if (c.type === 'Bool') { label = `${base}: ${c.value}`; collapsible = false; }
  else if (c.type === 'ByteString') ({ label, collapsible } = valuePreview(`${base}: 0x`, c.value));
  else if (c.type === 'ProtoList') { label = `${base}: List[${c.elementType.type}] (${c.values.length} items)`; collapsible = true; }
  else if (c.type === 'ProtoPair') { label = `${base}: Pair<${c.first_type.type}, ${c.second_type.type}>`; collapsible = true; }
  else if (c.type === 'Bls12_381G1Element') ({ label, collapsible } = valuePreview(`${base}: BLS G1 0x`, c.serialized));
  else if (c.type === 'Bls12_381G2Element') ({ label, collapsible } = valuePreview(`${base}: BLS G2 0x`, c.serialized));
  else if (c.type === 'Bls12_381MlResult') ({ label, collapsible } = valuePreview(`${base}: BLS ML 0x`, c.bytes));
  else if (c.type === 'Data') { label = `${base} (Data)`; collapsible = true; }
  else if (c.type === 'Unit') { label = `${base} (Unit)`; collapsible = false; }
  else { label = `${base} (${(c as { type: string }).type})`; collapsible = false; }
  return { label, collapsible, icon, contextValue: 'uplcNode' };
}

function termLabel(t: TermLazy, base: string): string {
  switch (t.term_type) {
    case 'Var': return `${base}: ${t.name}`;
    case 'Lambda': return `${base} (λ ${t.parameterName})`;
    case 'Builtin': return `${base} (${t.fun})`;
    case 'Constr': return `${base} (Constr tag: ${t.constructorTag})`;
    // Surface the error term's uniq_id when it names a real source term; a crash's synthetic error
    // term carries the -1 "no specific term" sentinel, so show plain `(Error)` for that.
    case 'Error': return t.id >= 0 ? `${base} (Error · id ${t.id})` : `${base} (Error)`;
    default: return `${base} (${t.term_type})`;
  }
}
const TERM_ICON: Record<string, string> = {
  Var: 'symbol-variable', Lambda: 'symbol-function', Apply: 'activate-breakpoints',
  Constant: 'symbol-constant', Delay: 'debug-pause', Force: 'debug-continue',
  Builtin: 'symbol-module', Error: 'error', Constr: 'symbol-class', Case: 'symbol-enum',
};
function termHasChildren(tt: string): boolean {
  return tt === 'Lambda' || tt === 'Apply' || tt === 'Delay' || tt === 'Force' || tt === 'Constr' || tt === 'Case' || tt === 'Constant';
}

function viewFor(kind: LazyKind, data: unknown, label: string): NodeView {
  switch (kind) {
    case 'machineState': {
      const s = data as MachineStateLazy;
      return { label: `${s.machine_state_type}`, collapsible: true, icon: 'gear', contextValue: 'uplcNode' };
    }
    case 'context': {
      const c = data as MachineContextLazy;
      const l = c.context_type === 'FrameConstr' ? `${c.context_type}: tag=${c.tag}` : `${c.context_type}`;
      return { label: l, collapsible: true, icon: 'layers', contextValue: 'uplcNode' };
    }
    case 'env': {
      const e = data as EnvLazy;
      return { label: `${label} (${e.values.length} values)`, collapsible: e.values.length > 0, icon: 'symbol-field', contextValue: 'uplcNode' };
    }
    case 'value': {
      const v = data as ValueLazy;
      let l = `${label} (${v.value_type})`;
      if (v.value_type === 'Lambda' && 'parameterName' in v) l = `${label} (${v.value_type}: ${v.parameterName})`;
      else if (v.value_type === 'Constr' && 'tag' in v) l = `${label} (${v.value_type}: tag=${v.tag})`;
      else if (v.value_type === 'Builtin' && 'fun' in v) l = `${label} (${v.value_type}: ${v.fun})`;
      return { label: l, collapsible: true, icon: valueIcon(v.value_type), contextValue: 'uplcNode' };
    }
    case 'constant':
      return constantView(data as ConstantLazy, label);
    case 'runtime': {
      const r = data as BuiltinRuntimeLazy;
      return { label: `Builtin Runtime (${r.args.length} args)`, collapsible: true, icon: 'symbol-method', contextValue: 'uplcNode' };
    }
    case 'term': {
      const t = data as TermLazy;
      return { label: termLabel(t, label), collapsible: termHasChildren(t.term_type), icon: TERM_ICON[t.term_type] ?? 'symbol-misc', contextValue: 'uplcNode' };
    }
  }
}

// ── child enumeration (loaded) ──────────────────────────────────────────────────

function childrenFor(
  kind: LazyKind, data: unknown, label: string, path: string[], source: DataSource, session?: IDebuggerEngine,
): UplcNode[] {
  const value = (d: unknown, lbl: string, p: string[]) => new LazyRef('value', d, lbl, p, source, session);
  const env = (d: unknown, lbl: string, p: string[]) => new LazyRef('env', d, lbl, p, source, session);
  const context = (d: unknown, lbl: string, p: string[]) => new LazyRef('context', d, lbl, p, source, session);
  const constant = (d: unknown, lbl: string, p: string[]) => new LazyRef('constant', d, lbl, p, source, session);

  switch (kind) {
    case 'machineState': {
      const s = data as MachineStateLazy;
      switch (s.machine_state_type) {
        case 'Return': return [value(s.value, 'Return value', [...path, 'value']), context(s.context, 'Context', [...path, 'context'])];
        case 'Compute': return [context(s.context, 'Context', [...path, 'context']), env(s.env, 'Environment', [...path, 'env']), termOrIdRef(s.term, 'Term to compute')];
        case 'Done': return [termOrIdRef(s.term, 'Computed term')];
        default: return assertNever(s, 'machine_state_type');
      }
    }
    case 'context': {
      const c = data as MachineContextLazy;
      switch (c.context_type) {
        case 'FrameAwaitArg': return [value(c.value, 'Await Arg Value', [...path, 'value'])];
        case 'FrameAwaitFunTerm': return [env(c.env, 'Environment', [...path, 'env']), termOrIdRef(c.term, 'Await Fun Term')];
        case 'FrameAwaitFunValue': return [value(c.value, 'Await Fun Value', [...path, 'value'])];
        case 'FrameForce': return [];
        case 'FrameConstr': return [
          env(c.env, 'Environment', [...path, 'env']),
          new SimpleNode(`Constructor tag: ${c.tag}`),
          ...c.terms.map((t, i) => termOrIdRef(t, `Remaining term ${i}`)),
          ...c.values.map((v, i) => value(v, `Evaluated value ${i}`, [...path, 'values', String(i)])),
        ];
        case 'FrameCases': return [
          env(c.env, 'Environment', [...path, 'env']),
          ...c.terms.map((t, i) => termOrIdRef(t, `Branch ${i}`)),
        ];
        case 'NoFrame': return [];
        default: return assertNever(c, 'context_type');
      }
    }
    case 'env': {
      const e = data as EnvLazy;
      const nodes: UplcNode[] = e.values.map((v, i) => value(v, `Value ${i}`, [...path, 'values', String(i)]));
      const d = data as { truncation_message?: string; displayed_count?: number; total_count?: number };
      if (d.truncation_message && d.displayed_count !== undefined && d.total_count !== undefined) {
        nodes.push(new TruncationInfoNode(d.displayed_count, d.total_count, d.truncation_message));
      }
      return nodes;
    }
    case 'value': {
      const v = data as ValueLazy;
      switch (v.value_type) {
        case 'Con': return 'constant' in v ? [constant(v.constant, 'Constant', [...path, 'constant'])] : [];
        case 'Delay': return 'body' in v && 'env' in v ? [termOrIdRef(v.body, 'Delayed Term'), env(v.env, 'Environment', [...path, 'env'])] : [];
        case 'Lambda': return 'parameterName' in v && 'body' in v && 'env' in v ? [
          new SimpleNode(`Parameter: ${v.parameterName}`), termOrIdRef(v.body, 'Body'), env(v.env, 'Environment', [...path, 'env']),
        ] : [];
        case 'Builtin': return 'fun' in v && 'runtime' in v ? [
          new SimpleNode(`Function: ${v.fun}`),
          ...(v.runtime ? [new LazyRef('runtime', v.runtime, 'Builtin Runtime', [...path, 'runtime'], source, session)] : []),
        ] : [];
        case 'Constr': return 'tag' in v && 'fields' in v ? [
          new SimpleNode(`Constructor tag: ${v.tag}`),
          ...v.fields.map((f, i) => value(f, `Field ${i}`, [...path, 'fields', String(i)])),
        ] : [];
        default: return assertNever(v, 'value_type');
      }
    }
    case 'constant': {
      const c = data as ConstantLazy;
      switch (c.type) {
        case 'ProtoList': return [
          new TypeNode(c.elementType as Type, 'Element Type'),
          ...c.values.map((val, i) => constant(val, `List item ${i}`, [...path, 'values', String(i)])),
        ];
        case 'ProtoPair': return [
          new TypeNode(c.first_type as Type, 'First Type'),
          new TypeNode(c.second_type as Type, 'Second Type'),
          constant(c.first_element, 'First Value', [...path, 'first_element']),
          constant(c.second_element, 'Second Value', [...path, 'second_element']),
        ];
        case 'Data': {
          const d = (c as { data?: unknown }).data;
          if (d && typeof d === 'object') {
            if (isPlaceholder(d)) return [new SimpleNode(`Plutus Data (${(d as Placeholder)._kind || 'not loaded'})`)];
            return [new PlutusDataNode(d as PlutusData)];
          }
          return [new SimpleNode('Plutus Data (empty)')];
        }
        // Long scalars expand to a single full-value child (matches constantView's `collapsible`).
        case 'Integer': return c.value.length > PREVIEW_LEN ? [fullValueNode(c.value)] : [];
        case 'String': return `"${c.value}"`.length > PREVIEW_LEN ? [fullValueNode(`"${c.value}"`)] : [];
        case 'ByteString': return c.value.length > PREVIEW_LEN ? [fullValueNode(`0x${c.value}`)] : [];
        case 'Bls12_381G1Element': return c.serialized.length > PREVIEW_LEN ? [fullValueNode(`0x${c.serialized}`)] : [];
        case 'Bls12_381G2Element': return c.serialized.length > PREVIEW_LEN ? [fullValueNode(`0x${c.serialized}`)] : [];
        case 'Bls12_381MlResult': return c.bytes.length > PREVIEW_LEN ? [fullValueNode(`0x${c.bytes}`)] : [];
        default: return [];
      }
    }
    case 'runtime': {
      const r = data as BuiltinRuntimeLazy;
      return [
        new SimpleNode(`Function: ${r.fun}`),
        new SimpleNode(`Forces: ${r.forces}`),
        new SimpleNode(`Arity: ${r.arity}`),
        ...r.args.map((arg, i) => value(arg, `Arg ${i}`, [...path, 'args', String(i)])),
      ];
    }
    case 'term': {
      // Terms walk their already-loaded structure (no session — matches today's behaviour).
      const t = data as TermLazy;
      switch (t.term_type) {
        case 'Var': return [];
        case 'Delay': return [new LazyRef('term', t.term, 'Delayed term')];
        case 'Lambda': return [new SimpleNode(`Parameter: ${t.parameterName}`), new LazyRef('term', t.body, 'Body')];
        case 'Apply': return [new LazyRef('term', t.function, 'Function'), new LazyRef('term', t.argument, 'Argument')];
        case 'Constant': return [new LazyRef('constant', t.constant, 'Constant')];
        case 'Force': return [new LazyRef('term', t.term, 'Forced term')];
        case 'Error': return [];
        case 'Builtin': return [new SimpleNode(`Builtin: ${t.fun}`)];
        case 'Constr': return [new SimpleNode(`Constructor tag: ${t.constructorTag}`), ...t.fields.map((f, i) => new LazyRef('term', f, `Field ${i}`))];
        case 'Case': return [new LazyRef('term', t.constr, 'Constr to match'), ...t.branches.map((b, i) => new LazyRef('term', b, `Branch ${i}`))];
        default: return assertNever(t, 'term_type');
      }
    }
  }
}

// ── root builders (mirror roots.ts, producing LazyRefs) ─────────────────────────

export function buildLazyMachineStateRoots(state: MachineStateLazy | undefined, session: IDebuggerEngine): UplcNode[] {
  return state ? [new LazyRef('machineState', state, 'Machine State', [], 'machineState', session)] : [];
}
export function buildLazyContextRoots(contexts: MachineContextLazy[], session: IDebuggerEngine): UplcNode[] {
  return contexts.map((c, i) => new LazyRef('context', c, `Context ${i}`, [String(i)], 'context', session));
}
export function buildLazyEnvRoots(env: EnvLazy | undefined, session: IDebuggerEngine): UplcNode[] {
  return env ? [new LazyRef('env', env, 'Environment', [], 'env', session)] : [];
}

/**
 * Lazy-explorer roots for an ARBITRARY node: load the node's shallow shape at `path`, then
 * enumerate its children (each a LazyRef that expands on demand). The lazy alternative to
 * fetching the whole subtree as one (potentially huge) JSON blob. Re-call on session/step.
 */
export async function buildNodeChildren(
  source: DataSource, path: string[], kind: LazyKind, label: string, session: IDebuggerEngine,
): Promise<UplcNode[]> {
  const data = await session.getLazy(source, path, false);
  return childrenFor(kind, data, label, path, source, session);
}
