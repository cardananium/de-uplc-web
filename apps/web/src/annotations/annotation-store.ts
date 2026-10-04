import { create } from 'zustand';
import type { Annotation, DebuggerAnnotation } from './annotations';
import type { DecompileRun } from '../decompiler/decompiler-store';

/** Annotations of a debugger launch, resolved against the program that launch loaded. */
export interface DebuggerAnnotationSet {
  items: DebuggerAnnotation[];
  focus: number;
  /** Bumped by every focus move, so a repeat move to the same entry still reveals it. */
  nonce: number;
  /**
   * The debugger moved (step, run, reset) since the last focus move: the spotlight scrim stays
   * hidden, so the execution line is never in the dark. Every focus move clears it.
   */
  quiet: boolean;
}

/** Annotations of a decompiler launch. Their lines refer to the output of `basis`. */
export interface DecompilerAnnotationSet {
  items: Annotation[];
  focus: number;
  nonce: number;
  /** The decompile the link's line numbers belong to; any other run makes them stale. */
  basis?: DecompileRun;
  /** Dotted paths of link options this build left out. */
  ignoredOptions: string[];
}

interface AnnotationState {
  debugger?: DebuggerAnnotationSet;
  decompiler?: DecompilerAnnotationSet;
  setDebugger: (items: DebuggerAnnotation[], focus: number) => void;
  setDecompiler: (set: Omit<DecompilerAnnotationSet, 'nonce'>) => void;
  focusDebugger: (index: number) => void;
  focusDecompiler: (index: number) => void;
  quietDebugger: () => void;
  clearDebugger: () => void;
  clearDecompiler: () => void;
}

const wrap = (i: number, n: number) => (n > 0 ? ((i % n) + n) % n : 0);

export const useAnnotations = create<AnnotationState>((set) => ({
  setDebugger: (items, focus) =>
    set({ debugger: items.length ? { items, focus: wrap(focus, items.length), nonce: 1, quiet: false } : undefined }),
  setDecompiler: (d) =>
    set({ decompiler: d.items.length ? { ...d, focus: wrap(d.focus, d.items.length), nonce: 1 } : undefined }),
  focusDebugger: (index) =>
    set((s) => (s.debugger
      ? { debugger: { ...s.debugger, focus: wrap(index, s.debugger.items.length), nonce: s.debugger.nonce + 1, quiet: false } }
      : {})),
  focusDecompiler: (index) =>
    set((s) => (s.decompiler
      ? { decompiler: { ...s.decompiler, focus: wrap(index, s.decompiler.items.length), nonce: s.decompiler.nonce + 1 } }
      : {})),
  quietDebugger: () =>
    set((s) => (s.debugger && !s.debugger.quiet ? { debugger: { ...s.debugger, quiet: true } } : {})),
  clearDebugger: () => set({ debugger: undefined }),
  clearDecompiler: () => set({ decompiler: undefined }),
}));

/** Debugger annotations belong to the program their link loaded: any program load drops them. */
export function clearDebuggerAnnotations(): void {
  if (useAnnotations.getState().debugger) useAnnotations.getState().clearDebugger();
}

/** The debugger is about to move (step, run, pause, reset): the spotlight scrim steps aside. */
export function quietDebuggerSpotlight(): void {
  useAnnotations.getState().quietDebugger();
}
