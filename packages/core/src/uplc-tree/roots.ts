import { IDebuggerEngine } from '../debugger/debugger-engine.interface';
import { MachineStateLazy, MachineContextLazy, EnvLazy } from '../debugger-types';
import { UplcNode } from './nodes';
import { buildLazyMachineStateRoots, buildLazyContextRoots, buildLazyEnvRoots } from './lazy-ref';

/**
 * Builders for the root nodes of the three machine trees. Each call creates NEW LazyRef
 * instances; the UI remounts the whole tree on a fresh `treeGeneration` (React key), so the
 * cursor needs no identity token of its own.
 */

export function buildMachineStateRoots(
  state: MachineStateLazy | undefined, session: IDebuggerEngine,
): UplcNode[] {
  return buildLazyMachineStateRoots(state, session);
}

export function buildContextRoots(
  contexts: MachineContextLazy[], session: IDebuggerEngine,
): UplcNode[] {
  return buildLazyContextRoots(contexts, session);
}

export function buildEnvRoots(
  env: EnvLazy | undefined, session: IDebuggerEngine,
): UplcNode[] {
  return buildLazyEnvRoots(env, session);
}
