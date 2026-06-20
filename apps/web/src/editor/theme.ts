// Light-weight editor theme state, kept OUT of monaco.ts so that App (eager) can
// drive the theme without pulling Monaco + vscode-textmate into the initial chunk.
// monaco.ts registers the actual `setTheme` applier on init.

export const UPLC_THEME = 'uplc-light';
export const UPLC_THEME_DARK = 'uplc-dark';

let desired: 'light' | 'dark' =
  typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

let applier: ((themeName: string) => void) | undefined;

function nameFor(t: 'light' | 'dark'): string {
  return t === 'dark' ? UPLC_THEME_DARK : UPLC_THEME;
}

/** The Monaco theme name for the current preference (used when creating editors). */
export function currentThemeName(): string {
  return nameFor(desired);
}

/** Switch the editor theme (global across all Monaco editors). No-op before Monaco init. */
export function applyMonacoTheme(t: 'light' | 'dark'): void {
  desired = t;
  applier?.(nameFor(t));
}

/** monaco.ts calls this on init to hook up `monaco.editor.setTheme`. */
export function registerThemeApplier(fn: (themeName: string) => void): void {
  applier = fn;
  fn(nameFor(desired));
}
