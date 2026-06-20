import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildMachineStateRoots, buildContextRoots, buildEnvRoots, type UplcNode } from '../src/index';
import type { IDebuggerEngine } from '../src/debugger/debugger-engine.interface';

// Regression lock for the LazyRef tree model. `lazy-fixture.json` is a real deep capture
// (3 roots + a recording of every getLazy call made during an 8-level walk + the resulting
// NodeView tree, captured from the ORIGINAL ~20-class node model). A mock session replays the
// call map, so we re-run the current model with zero engine/WASM and assert the produced tree
// is byte-identical — i.e. the LazyRef rewrite is behaviour-neutral and stays that way.

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./lazy-fixture.json', import.meta.url)), 'utf8'),
) as {
  roots: { machineState: unknown; contexts: unknown[]; env: unknown };
  calls: Record<string, unknown>;
  tree: Record<string, unknown[]>;
};

const DEPTH = 6; // must match the capture depth in lazy-fixture.json

function mockSession(): IDebuggerEngine {
  const get = (source: string, p: string, full: boolean) => {
    const key = `${source}|${p}|${full}`;
    if (!(key in fixture.calls)) throw new Error(`mock session: no recorded response for ${key}`);
    return Promise.resolve(fixture.calls[key]);
  };
  return {
    getMachineStateLazy: (p = '', full = false) => get('machineState', p, full),
    getMachineContextLazy: (p = '', full = false) => get('context', p, full),
    getCurrentEnvLazy: (p = '', full = false) => get('env', p, full),
    getLazy: (source: string, pathArr: string[] = [], full = false) => get(source, JSON.stringify(pathArr), full),
  } as unknown as IDebuggerEngine;
}

async function walk(node: UplcNode, depth: number): Promise<unknown> {
  const view = node.toViewModel();
  const children: unknown[] = [];
  if (depth > 0 && view.collapsible) {
    let kids: UplcNode[] | Promise<UplcNode[]> = node.getChildren();
    if (kids && typeof (kids as Promise<UplcNode[]>).then === 'function') kids = await kids;
    for (const k of (kids as UplcNode[]) || []) children.push(await walk(k, depth - 1));
  }
  return { view, children };
}

describe('lazy tree model (LazyRef) — fixture replay', () => {
  it('reproduces the captured NodeView tree byte-for-byte (behaviour-neutral)', async () => {
    const session = mockSession();
    const out: Record<string, unknown[]> = { machineState: [], context: [], env: [] };
    for (const n of buildMachineStateRoots(fixture.roots.machineState as never, session)) out.machineState.push(await walk(n, DEPTH));
    for (const n of buildContextRoots(fixture.roots.contexts as never, session)) out.context.push(await walk(n, DEPTH));
    for (const n of buildEnvRoots(fixture.roots.env as never, session)) out.env.push(await walk(n, DEPTH));
    expect(out).toEqual(fixture.tree);
  });
});
