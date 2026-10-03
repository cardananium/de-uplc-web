import { useStore } from '../store';
import { useDecompiler } from '../decompiler/decompiler-store';
import { useAnnotations } from './annotation-store';
import { resolveDebuggerAnnotations, type LaunchAnnotations } from './annotations';

/**
 * Resolve a debugger launch's annotations against the program it just loaded (for a transaction
 * launch: the selected redeemer's program) and publish them. Called once the load has settled; a
 * failed load still publishes them, every entry marked not found.
 */
export function applyDebuggerLaunchAnnotations(a: LaunchAnnotations): void {
  const st = useStore.getState();
  const needsCanonical = a.items.some((x) => x.target.kind === 'uplc_line');
  const resolved = resolveDebuggerAnnotations(
    a.items,
    st.termLocations,
    needsCanonical ? st.canonicalUplcLocations() : undefined,
  );
  useAnnotations.getState().setDebugger(resolved, a.focus);
}

/**
 * Publish a decompiler launch's annotations against the decompile that just finished: their lines
 * are valid for exactly that run's bytecode + options.
 */
export function applyDecompilerLaunchAnnotations(a: LaunchAnnotations, ignoredOptions: string[]): void {
  useAnnotations.getState().setDecompiler({
    items: a.items,
    focus: a.focus,
    basis: useDecompiler.getState().lastRun,
    ignoredOptions,
  });
}
