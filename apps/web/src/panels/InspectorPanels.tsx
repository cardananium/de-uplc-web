import { useMemo } from 'react';
import { buildMachineStateRoots, buildContextRoots, buildEnvRoots, type UplcNode } from '@de-uplc/core';
import { useStore, getSession } from '../store';
import { Tree } from '../components/Tree';
import { Codicon } from '../components/Codicon';
import { EmptyState } from '../components/EmptyState';

function TreePanel({ title, roots, generation }: { title: string; roots: UplcNode[]; generation: number }) {
  return (
    <div className="panel">
      <div className="panel-title">{title}</div>
      <div style={{ marginTop: 6, maxHeight: 280, overflow: 'auto' }}>
        <Tree roots={roots} generation={generation} />
      </div>
    </div>
  );
}

export function MachineStatePanel() {
  const ms = useStore((s) => s.machineStateLazy);
  const gen = useStore((s) => s.treeGeneration);
  const session = getSession();
  const roots = useMemo(
    () => (session ? buildMachineStateRoots(ms, session) : []),
    [ms, gen, session],
  );
  return <TreePanel title="Machine State" roots={roots} generation={gen} />;
}

export function MachineContextPanel() {
  const ctxs = useStore((s) => s.contextsLazy);
  const gen = useStore((s) => s.treeGeneration);
  const session = getSession();
  const roots = useMemo(
    () => (session ? buildContextRoots(ctxs, session) : []),
    [ctxs, gen, session],
  );
  return <TreePanel title="Machine Context" roots={roots} generation={gen} />;
}

export function EnvironmentsPanel() {
  const env = useStore((s) => s.currentEnvLazy);
  const gen = useStore((s) => s.treeGeneration);
  const session = getSession();
  const roots = useMemo(
    () => (session ? buildEnvRoots(env, session) : []),
    [env, gen, session],
  );
  return <TreePanel title="Environments" roots={roots} generation={gen} />;
}

export function LogsPanel() {
  const logs = useStore((s) => s.logs);
  return (
    <div className="panel">
      <div className="panel-title">Logs</div>
      {/* `compact`: inside a sidebar panel, where the full block's 28px of padding would dominate
          the card it sits in. */}
      {logs.length === 0 ? (
        <EmptyState compact icon="output" title="No logs" hint="Traces printed by the script appear here." />
      ) : (
        <pre style={{
          background: 'var(--bg-subtle)', padding: 8, borderRadius: 6, fontSize: 12, margin: '6px 0 0',
          fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          maxHeight: 200, overflowY: 'auto',
        }}>
          {logs.join('\n')}
        </pre>
      )}
    </div>
  );
}

export function BreakpointsPanel() {
  const breakpoints = useStore((s) => s.breakpoints);
  const remove = useStore((s) => s.removeBreakpoint);
  const toggle = useStore((s) => s.toggleBreakpoint);

  return (
    <div className="panel">
      <div className="panel-title">Breakpoints</div>
      {breakpoints.length === 0 ? (
        <EmptyState compact icon="circle-outline" title="No breakpoints"
          hint="Click the term editor's gutter, or press F9 on a term line, to add one." />
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {breakpoints.map((b) => (
            <li key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
              <input type="checkbox" checked={b.active} onChange={() => toggle(b.id)} />
              <span style={{ flex: 1 }}>term id {b.id}</span>
              <button className="icon-button accent-stop" title="Remove" aria-label={`Remove breakpoint at term ${b.id}`} onClick={() => remove(b.id)}>
                <Codicon name="close" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
