import { describe, it, expect } from 'vitest';
import { valuePreview, stringPreview, stringNeedsFull, fullValueNode, PlutusDataNode, PREVIEW_LEN } from '../src/uplc-tree/nodes';
import { LazyRef } from '../src/uplc-tree/lazy-ref';

// Long scalar values (bytes / big ints / strings) are shown as a short PREVIEW; the node becomes
// expandable and its one child carries the FULL value, capped at 16 MB with an over-limit note.

describe('valuePreview / fullValueNode', () => {
  it('short value → plain leaf (no preview, not collapsible)', () => {
    const short = 'ab'.repeat(20); // 40 chars < PREVIEW_LEN
    expect(valuePreview('B: ', short)).toEqual({ label: `B: ${short}`, collapsible: false });
  });
  it('long value → truncated preview + collapsible + size hint', () => {
    const long = 'a'.repeat(PREVIEW_LEN + 500);
    const { label, collapsible } = valuePreview('B: ', long);
    expect(collapsible).toBe(true);
    expect(label.startsWith(`B: ${'a'.repeat(PREVIEW_LEN)}`)).toBe(true);
    expect(label).toContain(`${(PREVIEW_LEN + 500).toLocaleString('en-US')} chars`);
    expect(label.length).toBeLessThan(long.length); // a preview, not the full value
  });
  it('fullValueNode → full value under 16 MB', () => {
    const v = 'x'.repeat(5000);
    expect(fullValueNode(v).toViewModel().label).toBe(v);
  });
  it('fullValueNode → cut at 16 MB + over-limit note above 16 MB', () => {
    const v = 'y'.repeat(16 * 1024 * 1024 + 10);
    const label = fullValueNode(v).toViewModel().label;
    expect(label.indexOf('…')).toBe(16 * 1024 * 1024); // the value is cut exactly at 16 MB
    expect(label).toContain('over the 16 MB display limit');
  });
});

describe('stringPreview — multiline String constants', () => {
  it('plain short string → leaf with quoted value', () => {
    expect(stringPreview('S: ', 'hello')).toEqual({ label: 'S: "hello"', collapsible: false });
    expect(stringNeedsFull('hello')).toBe(false);
  });
  it('short string WITH a line break → escaped one-line preview + collapsible', () => {
    const { label, collapsible } = stringPreview('S: ', 'line1\nline2');
    expect(collapsible).toBe(true);
    expect(label).toBe('S: "line1\\nline2" (has line breaks — expand for full)');
    expect(stringNeedsFull('line1\nline2')).toBe(true);
  });
  it('long string → truncated escaped preview + size hint (as before)', () => {
    const long = 'a'.repeat(PREVIEW_LEN + 500);
    const { label, collapsible } = stringPreview('S: ', long);
    expect(collapsible).toBe(true);
    expect(label).toContain(`${(PREVIEW_LEN + 500).toLocaleString('en-US')} chars`);
  });
  it('multiline String constant via LazyRef → full-value child keeps the REAL line breaks', () => {
    const node = new LazyRef('constant', { type: 'String', value: 'line1\nline2' } as never, 'Constant');
    const view = node.toViewModel();
    expect(view.collapsible).toBe(true); // short but multiline → still expandable
    const kids = node.getChildren() as { toViewModel(): { label: string; wrap?: boolean } }[];
    expect(kids).toHaveLength(1);
    expect(kids[0].toViewModel().label).toBe('"line1\nline2"'); // raw newline, not \\n
    expect(kids[0].toViewModel().wrap).toBe(true); // rendered pre-wrap so the break is visible
  });
});

describe('PlutusData BoundedBytes unfold', () => {
  it('short bytes → leaf, no child', () => {
    const node = new PlutusDataNode({ type: 'BoundedBytes', value: 'ab'.repeat(20) } as never);
    expect(node.toViewModel().collapsible).toBe(false);
    expect(node.getChildren()).toHaveLength(0);
  });
  it('long bytes → preview node that expands to the full 0x-value', () => {
    const longBytes = 'cd'.repeat(PREVIEW_LEN); // 2*PREVIEW_LEN chars
    const node = new PlutusDataNode({ type: 'BoundedBytes', value: longBytes } as never);
    const view = node.toViewModel();
    expect(view.collapsible).toBe(true);
    expect(view.label).toContain('chars');
    const kids = node.getChildren();
    expect(kids).toHaveLength(1);
    expect(kids[0].toViewModel().label).toBe(`0x${longBytes}`); // FULL value
  });
});

describe('constant ByteString unfold (via LazyRef)', () => {
  it('long ByteString constant → preview + full-value child', () => {
    const longHex = 'ef'.repeat(PREVIEW_LEN);
    const node = new LazyRef('constant', { type: 'ByteString', value: longHex } as never, 'Constant');
    const view = node.toViewModel();
    expect(view.collapsible).toBe(true);
    expect(view.label.startsWith('Constant: 0x')).toBe(true);
    expect(view.label).toContain('chars');
    const kids = node.getChildren() as ReturnType<typeof node.getChildren>;
    expect(Array.isArray(kids)).toBe(true);
    const arr = kids as { toViewModel(): { label: string } }[];
    expect(arr).toHaveLength(1);
    expect(arr[0].toViewModel().label).toBe(`0x${longHex}`); // FULL value
  });
  it('short ByteString constant → leaf', () => {
    const node = new LazyRef('constant', { type: 'ByteString', value: 'ab'.repeat(10) } as never, 'Constant');
    expect(node.toViewModel().collapsible).toBe(false);
    expect(node.getChildren()).toHaveLength(0);
  });
});
