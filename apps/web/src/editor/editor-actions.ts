// A tiny indirection so the non-lazy EditorTabs tab bar can trigger the term
// editor's find action without importing the (lazy) TermEditor / Monaco chunk.
// TermEditor registers the handler on mount and clears it on dispose.

let findHandler: (() => void) | undefined;

export function setTermFindHandler(h: (() => void) | undefined): void {
  findHandler = h;
}

/** Open Monaco's find widget on the term editor (no-op if no editor is mounted). */
export function triggerTermFind(): void {
  findHandler?.();
}

// Same indirection for the active data (CodeView) tab — the Find affordance there was missing even
// though the underlying Monaco editor supports it. CodeView registers on mount, clears on dispose.
let dataFindHandler: (() => void) | undefined;

export function setDataFindHandler(h: (() => void) | undefined): void {
  dataFindHandler = h;
}

/** Open Monaco's find widget on the active data tab (no-op if no CodeView is mounted). */
export function triggerDataFind(): void {
  dataFindHandler?.();
}
