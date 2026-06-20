// Lazy Monaco bootstrap: registers the `uplc` + `plutus-types-json` languages,
// defines a light theme, and wires TextMate-driven tokenization on top of Monaco
// via a TokensProvider bridge. The heavy `monaco-editor` chunk is dynamically
// imported here so it only loads when the term editor first mounts.

import type * as MonacoT from 'monaco-editor';
import { getGrammar, INITIAL, type StateStack } from './textmate';
import { LANGUAGES, languageConfiguration } from './grammars';
import { UPLC_THEME, UPLC_THEME_DARK, registerThemeApplier } from './theme';

export type MonacoNS = typeof import('monaco-editor');

let initPromise: Promise<MonacoNS> | undefined;

/** Idempotently load + configure Monaco. Safe to call from every editor mount. */
export function ensureMonaco(): Promise<MonacoNS> {
  if (!initPromise) {
    initPromise = doInit();
  }
  return initPromise;
}

async function doInit(): Promise<MonacoNS> {
  // edcore.main = editor core + all editor contribs (inlay hints, injected text,
  // folding, …) but no built-in language packs. editor.api alone omits the
  // contribs, so inlay hints + decoration after-text would not render.
  const monaco = await import('monaco-editor/esm/vs/editor/edcore.main');
  const EditorWorker = (await import('monaco-editor/esm/vs/editor/editor.worker?worker')).default;
  (self as unknown as { MonacoEnvironment: MonacoT.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };

  for (const lang of LANGUAGES) {
    monaco.languages.register({ id: lang.id, extensions: lang.extensions });
    monaco.languages.setLanguageConfiguration(
      lang.id,
      languageConfiguration as unknown as MonacoT.languages.LanguageConfiguration,
    );
  }

  monaco.editor.defineTheme(UPLC_THEME, { base: 'vs', inherit: true, colors: THEME_COLORS, rules: THEME_RULES });
  monaco.editor.defineTheme(UPLC_THEME_DARK, { base: 'vs-dark', inherit: true, colors: THEME_COLORS_DARK, rules: THEME_RULES_DARK });
  // Hook up live theme switching + apply the current preference.
  registerThemeApplier((name) => monaco.editor.setTheme(name));

  // Grammars load asynchronously (Oniguruma WASM); setTokensProvider once ready
  // re-tokenizes any open models, so registering after init is fine.
  for (const lang of LANGUAGES) {
    void wireTextMate(monaco, lang.id, lang.scopeName);
  }

  return monaco;
}

/** Bridges a vscode-textmate StateStack through Monaco's IState contract. */
class TMState implements MonacoT.languages.IState {
  constructor(readonly ruleStack: StateStack) {}
  clone(): MonacoT.languages.IState {
    return new TMState(this.ruleStack);
  }
  equals(other: MonacoT.languages.IState): boolean {
    return other instanceof TMState && (other === this || other.ruleStack === this.ruleStack);
  }
}

// Monaco's TokensProvider gives us one scope string per token; a TextMate token
// carries a stack. Take the topmost (most specific) scope, and if that scope name
// itself packs several space-separated scopes (e.g. the grammars' "storage.type.uplc
// entity.name.type.uplc"), keep the last/most-specific one so theme rules match.
function topScope(scopes: string[]): string {
  const top = scopes[scopes.length - 1] ?? '';
  const i = top.lastIndexOf(' ');
  return i === -1 ? top : top.slice(i + 1);
}

async function wireTextMate(monaco: MonacoNS, languageId: string, scopeName: string): Promise<void> {
  const grammar = await getGrammar(scopeName);
  if (!grammar) {
    return;
  }
  monaco.languages.setTokensProvider(languageId, {
    getInitialState: () => new TMState(INITIAL),
    tokenize: (line: string, state: MonacoT.languages.IState) => {
      const result = grammar.tokenizeLine(line, (state as TMState).ruleStack);
      const tokens = result.tokens.map((t) => ({
        startIndex: t.startIndex,
        scopes: topScope(t.scopes),
      }));
      return { tokens, endState: new TMState(result.ruleStack) };
    },
  });
}

// Editor chrome colours, tuned to sit inside the app's gradient cards: a slightly
// inset background, faint gutter + indent guides, soft current-line highlight.
const THEME_COLORS: Record<string, string> = {
  'editor.background': '#ffffff',
  'editor.foreground': '#383a42',
  'editorLineNumber.foreground': '#c2c9d1',
  'editorLineNumber.activeForeground': '#59636e',
  'editorIndentGuide.background': '#1016200f',
  'editorIndentGuide.activeBackground': '#10162024',
  'editor.lineHighlightBackground': '#1016200a',
  'editor.lineHighlightBorder': '#00000000',
  'editorGutter.background': '#ffffff',
  'editorCursor.foreground': '#4f6bed',
  'editorInlayHint.foreground': '#4c5563', // AA (~4.9:1) on the chip-over-paused-band composite; also AA on white/chip
  'editorInlayHint.background': '#10162010',
};
const THEME_COLORS_DARK: Record<string, string> = {
  'editor.background': '#0c1119',
  'editor.foreground': '#d7dce4',
  'editorLineNumber.foreground': '#3f4b58',
  'editorLineNumber.activeForeground': '#9aa7b5',
  'editorIndentGuide.background': '#ffffff0e',
  'editorIndentGuide.activeBackground': '#ffffff26',
  'editor.lineHighlightBackground': '#ffffff09',
  'editor.lineHighlightBorder': '#00000000',
  'editorGutter.background': '#0c1119',
  'editorCursor.foreground': '#7c9cff',
  'editor.selectionBackground': '#2a3b59',
  'editorWidget.background': '#151e29',
  'editorWidget.border': '#272e39',
  'input.background': '#1b2634',
  'scrollbarSlider.background': '#ffffff12',
  'scrollbarSlider.hoverBackground': '#ffffff20',
  'editorInlayHint.foreground': '#aab4c0',
  'editorInlayHint.background': '#ffffff12',
};

// Light syntax palette (atom-one-light-ish) — darkened so every token clears WCAG AA (4.5:1) on
// the white editor background (the originals sat at 2.5–4.0:1). Dark palette is already strong.
const THEME_RULES: MonacoT.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6b6f78', fontStyle: 'italic' },
  { token: 'keyword.control', foreground: 'a626a4' },
  { token: 'keyword', foreground: 'a626a4' },
  { token: 'variable.other', foreground: 'cf3a2e' },
  { token: 'entity.name.function', foreground: '2f63d8' },
  { token: 'storage.type', foreground: '0270a0' },
  { token: 'entity.name.type', foreground: '0270a0' },
  { token: 'entity.name.class', foreground: '0270a0' },
  { token: 'storage.modifier', foreground: 'a626a4' },
  { token: 'support.type.property-name', foreground: '2f63d8' },
  { token: 'support.function', foreground: '2f63d8' },
  { token: 'constant.numeric', foreground: '9a6a00' },
  { token: 'constant.language', foreground: '0270a0' },
  { token: 'constant.character.escape', foreground: '0270a0' },
  { token: 'string.quoted', foreground: '2f7d2e' },
  { token: 'string', foreground: '2f7d2e' },
];

// Dark syntax palette (Material-ish): purple keywords (lam/delay/force), blue
// builtins, cyan constant types, orange numbers, green strings.
const THEME_RULES_DARK: MonacoT.editor.ITokenThemeRule[] = [
  { token: 'comment', foreground: '6b7686', fontStyle: 'italic' },
  { token: 'keyword.control', foreground: 'c792ea' },
  { token: 'keyword', foreground: 'c792ea' },
  { token: 'variable.other', foreground: 'e06c75' },
  { token: 'entity.name.function', foreground: '82aaff' },
  { token: 'storage.type', foreground: '89ddff' },
  { token: 'entity.name.type', foreground: '89ddff' },
  { token: 'entity.name.class', foreground: '89ddff' },
  { token: 'storage.modifier', foreground: 'c792ea' },
  { token: 'support.type.property-name', foreground: '82aaff' },
  { token: 'support.function', foreground: '82aaff' },
  { token: 'constant.numeric', foreground: 'f78c6c' },
  { token: 'constant.language', foreground: '89ddff' },
  { token: 'constant.character.escape', foreground: '89ddff' },
  { token: 'string.quoted', foreground: 'c3e88d' },
  { token: 'string', foreground: 'c3e88d' },
];
