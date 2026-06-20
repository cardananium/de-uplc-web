import { PlutusData, Type } from '../debugger-types';

// Tree node contract + the static (non-session) display nodes. The session-backed lazy
// nodes that used to live here (~8 *Lazy classes + LoadableLazyNode) are collapsed into the
// single `LazyRef` cursor in `lazy-ref.ts`; these leaves/recursive-statics are reused by it.

export interface NodeView {
    label: string;
    icon?: string;        // codicon id (the ThemeIcon name, used as-is)
    iconColor?: string;   // optional ThemeColor id, e.g. 'editorWarning.foreground'
    collapsible: boolean; // true if the original used Collapsed or Expanded
    expanded?: boolean;   // true if the original used Expanded
    contextValue?: string;
    tooltip?: string;
    description?: string;
    /** Allow this row's label/description to wrap (vs the tree's default single nowrap line) —
     *  set on long full-value nodes and truncation warnings so they stay readable. */
    wrap?: boolean;
}

export interface UplcNode {
    toViewModel(): NodeView;
    getChildren(): UplcNode[] | Promise<UplcNode[]>;
    /**
     * Lazy data nodes expose their lazy-load coordinates so the UI can fetch the FULL object
     * and open it in a data tab (the web equivalent of the extension's loadFullNodeData).
     * Absent on plain nodes (Simple/Truncation/…).
     */
    path?: string[];
    dataSource?: 'machineState' | 'context' | 'env';
    /** The lazy cursor kind (LazyRef nodes only) — lets a node-explorer tab re-root + re-resolve here. */
    lazyKind?: string;
    /**
     * The UPLC term id this node refers to (term boundaries: "Term to compute", a context frame's
     * term, a value's term body, …). Same id-space as the editor's `termLocations`, so the UI can
     * reveal + highlight the term's line. Absent on non-term nodes.
     */
    termId?: number;
}

/** A lazy placeholder that loads nothing further (e.g. a term-id edge). */
export class LazyNode implements UplcNode {
    constructor(private text: string) {}
    toViewModel(): NodeView {
        return {
            label: this.text,
            collapsible: false,
            icon: 'sync',
            contextValue: 'uplcLazyNode',
            tooltip: 'This data is not fully loaded.',
        };
    }
    getChildren(): UplcNode[] {
        return [];
    }
}

/** A plain label leaf. Optionally carries a `termId` so it can be revealed in the editor; `wrap`
 *  lets a long value's label wrap instead of extending as one nowrap line. */
export class SimpleNode implements UplcNode {
    constructor(private text: string, public readonly termId?: number, private wrap = false) {}
    toViewModel(): NodeView {
        return {
            label: this.text,
            collapsible: false,
            icon: 'symbol-property',
            contextValue: 'uplcNode',
            // Only emit `wrap` when set (it's an opt-in flag), so ordinary leaves stay unchanged.
            ...(this.wrap ? { wrap: true } : {}),
        };
    }
    getChildren(): UplcNode[] {
        return [];
    }
}

/** Shown when a collection was truncated by the engine. */
export class TruncationInfoNode implements UplcNode {
    constructor(
        private displayedCount: number,
        private totalCount: number,
        private message: string,
    ) {}
    toViewModel(): NodeView {
        return {
            label: `⚠️ Showing ${this.displayedCount} of ${this.totalCount} elements`,
            collapsible: false,
            description: this.message,
            tooltip: this.message,
            icon: 'warning',
            iconColor: 'editorWarning.foreground',
            contextValue: 'truncationInfo',
            wrap: true, // the truncation message is a sentence — let it wrap instead of one nowrap line
        };
    }
    getChildren(): UplcNode[] {
        return [];
    }
}

/** A UPLC constant type (recursive for List/Pair). */
export class TypeNode implements UplcNode {
    constructor(private type: Type, private label: string = 'Type') {}
    toViewModel(): NodeView {
        let iconName: string;
        switch (this.type.type) {
            case 'Bool': iconName = 'symbol-boolean'; break;
            case 'Integer': iconName = 'symbol-number'; break;
            case 'String': iconName = 'symbol-string'; break;
            case 'ByteString': iconName = 'symbol-array'; break;
            case 'Unit': iconName = 'symbol-misc'; break;
            case 'List': iconName = 'list-unordered'; break;
            case 'Pair': iconName = 'symbol-interface'; break;
            case 'Bls12_381G1Element':
            case 'Bls12_381G2Element':
            case 'Bls12_381MlResult': iconName = 'symbol-key'; break;
            case 'Data': iconName = 'symbol-json'; break;
            default: iconName = 'symbol-type';
        }
        return { label: `${this.label} (${this.type.type})`, collapsible: true, icon: iconName, contextValue: 'uplcNode' };
    }
    getChildren(): UplcNode[] {
        const t = this.type;
        switch (t.type) {
            case 'Bool': return [new SimpleNode('BoolType')];
            case 'Integer': return [new SimpleNode('IntegerType')];
            case 'String': return [new SimpleNode('StringType')];
            case 'ByteString': return [new SimpleNode('ByteStringType')];
            case 'Unit': return [new SimpleNode('UnitType')];
            case 'List': return [new SimpleNode('ListType'), new TypeNode(t.elementType, 'Element Type')];
            case 'Pair': return [new SimpleNode('PairType'), new TypeNode(t.first_type, 'First Type'), new TypeNode(t.second_type, 'Second Type')];
            case 'Bls12_381G1Element': return [new SimpleNode('BLS12-381 G1 Element')];
            case 'Bls12_381G2Element': return [new SimpleNode('BLS12-381 G2 Element')];
            case 'Bls12_381MlResult': return [new SimpleNode('BLS12-381 Miller Loop Result')];
            case 'Data': return [new SimpleNode('PlutusData')];
            default: return [new SimpleNode(`Unknown type: ${(t as { type: string }).type}`)];
        }
    }
}

/** A PlutusData Map entry (key + value). */
class PlutusDataMapEntryNode implements UplcNode {
    constructor(private key: PlutusData, private value: PlutusData, private index: number) {}
    toViewModel(): NodeView {
        return { label: `Entry ${this.index}`, collapsible: true, icon: 'symbol-key', contextValue: 'uplcNode' };
    }
    getChildren(): UplcNode[] {
        return [new PlutusDataNode(this.key), new PlutusDataNode(this.value)];
    }
}

// Long scalar values (hex bytes / big integers / strings) render as a short PREVIEW; the node then
// becomes EXPANDABLE and its single child carries the FULL value — capped at 16 MB, beyond which it
// is cut with an over-limit note. Short values (≤ PREVIEW_LEN) stay a plain leaf (no chevron).
export const PREVIEW_LEN = 128;
const MAX_FULL_VALUE = 16 * 1024 * 1024; // 16 MB

/** Preview label for a maybe-long value + whether the node should expand to reveal the full value. */
export function valuePreview(prefix: string, value: string): { label: string; collapsible: boolean } {
    if (value.length <= PREVIEW_LEN) return { label: `${prefix}${value}`, collapsible: false };
    return { label: `${prefix}${value.slice(0, PREVIEW_LEN)}… (${value.length.toLocaleString('en-US')} chars — expand for full)`, collapsible: true };
}
/**
 * Preview for a String constant: quote AFTER slicing so a long string keeps a BALANCED pair of
 * quotes around the elided text (`name: "abc…"`), instead of an opening quote with no close.
 */
export function stringPreview(prefix: string, raw: string): { label: string; collapsible: boolean } {
    if (raw.length <= PREVIEW_LEN) return { label: `${prefix}"${raw}"`, collapsible: false };
    return { label: `${prefix}"${raw.slice(0, PREVIEW_LEN)}…" (${raw.length.toLocaleString('en-US')} chars — expand for full)`, collapsible: true };
}
/** The single child of an expanded long value: the FULL value, capped at 16 MB (then cut + noted).
 *  Marked `wrap` so the editor renders it as wrapping/scrollable text, not one pathological nowrap line. */
export function fullValueNode(value: string): UplcNode {
    if (value.length <= MAX_FULL_VALUE) return new SimpleNode(value, undefined, true);
    return new SimpleNode(`${value.slice(0, MAX_FULL_VALUE)}… ⚠️ truncated (${value.length.toLocaleString('en-US')} chars, over the 16 MB display limit)`, undefined, true);
}

const intView = (kind: string, raw: string): NodeView => {
    const { label, collapsible } = valuePreview(`${kind}: `, String(raw));
    return { label, collapsible, icon: 'symbol-number', contextValue: 'uplcNode' };
};

/**
 * Fully-loaded PlutusData (recursive: Constr fields / Map entries / Array items). Typed against
 * the generated `PlutusData` union — the big-int variants (no `type` tag) are checked first, then
 * the tagged variants switch exhaustively (a new schema arm becomes a compile error).
 */
export class PlutusDataNode implements UplcNode {
    constructor(public data: PlutusData) {}

    toViewModel(): NodeView {
        const d = this.data;
        if ('Int' in d) return intView('Int', d.Int);
        if ('BigUInt' in d) return intView('BigUInt', d.BigUInt);
        if ('BigNInt' in d) return intView('BigNInt', d.BigNInt);
        switch (d.type) {
            case 'Constr':
                return { label: `Constr (tag: ${d.tag}, ${d.fields.length} fields)`, collapsible: d.fields.length > 0, icon: 'symbol-class', contextValue: 'uplcNode' };
            case 'Map':
                return { label: `Map (${d.key_value_pairs.length} entries)`, collapsible: d.key_value_pairs.length > 0, icon: 'symbol-interface', contextValue: 'uplcNode' };
            case 'Array':
                return { label: `Array (${d.values.length} items)`, collapsible: d.values.length > 0, icon: 'list-unordered', contextValue: 'uplcNode' };
            case 'BoundedBytes': {
                const { label, collapsible } = valuePreview('BoundedBytes: 0x', d.value || '');
                return { label, collapsible, icon: 'symbol-array', contextValue: 'uplcNode' };
            }
            default: { const _x: never = d; throw new Error(`Unhandled plutus data: ${JSON.stringify(_x)}`); }
        }
    }

    getChildren(): UplcNode[] {
        const d = this.data;
        // Long scalars expand to a single full-value child (see valuePreview/fullValueNode).
        if ('Int' in d) return String(d.Int).length > PREVIEW_LEN ? [fullValueNode(String(d.Int))] : [];
        if ('BigUInt' in d) return String(d.BigUInt).length > PREVIEW_LEN ? [fullValueNode(String(d.BigUInt))] : [];
        if ('BigNInt' in d) return String(d.BigNInt).length > PREVIEW_LEN ? [fullValueNode(String(d.BigNInt))] : [];
        switch (d.type) {
            case 'Constr': return d.fields.map((f) => new PlutusDataNode(f));
            case 'Map': return d.key_value_pairs.map((p, i) => new PlutusDataMapEntryNode(p.key, p.value, i));
            case 'Array': return d.values.map((v) => new PlutusDataNode(v));
            case 'BoundedBytes': return (d.value || '').length > PREVIEW_LEN ? [fullValueNode(`0x${d.value}`)] : [];
            default: { const _x: never = d; throw new Error(`Unhandled plutus data: ${JSON.stringify(_x)}`); }
        }
    }
}
