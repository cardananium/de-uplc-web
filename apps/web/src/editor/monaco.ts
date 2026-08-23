// Lazy Monaco bootstrap: registers `uplc`, `plutus-types-json`, and `dehosk` (Monarch),
// defines a light theme, and wires TextMate-driven tokenization on top of Monaco
// via a TokensProvider bridge. The heavy `monaco-editor` chunk is dynamically
// imported here so it only loads when the term editor first mounts.

import type * as MonacoT from 'monaco-editor';
import { getGrammar, INITIAL, type StateStack } from './textmate';
import { LANGUAGES, languageConfiguration } from './grammars';
import { UPLC_THEME, UPLC_THEME_DARK, registerThemeApplier } from './theme';
import { DEHOSK_LANG_ID, dehoskLanguage } from './dehosk-language';

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

  // Decompiled Aiken-like output: Monarch (not TextMate). Do not reuse dehosk-web's
  // standalone vs-dark theme — tokens join the existing light/dark UPLC themes.
  monaco.languages.register({ id: DEHOSK_LANG_ID });
  monaco.languages.setMonarchTokensProvider(DEHOSK_LANG_ID, dehoskLanguage);
  monaco.languages.setLanguageConfiguration(DEHOSK_LANG_ID, {
    comments: { lineComment: '//' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
  });

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
  // Overview-ruler marks of the profiler heat lane. A decoration carries a ThemeColor `{ id }`, and
  // Monaco resolves it through the editor theme and drops its decoration-colour cache on a theme
  // change — so the ruler repaints itself with no React render at all. That only works while the id
  // is present here as a PLAIN HEX: the resolver is `Color.fromHex`, and a missing id resolves to
  // nothing, which does not fail loudly — the mark just disappears.
  // gen:heat light
  'deuplc.profHeat0': '#aa8100',
  'deuplc.profHeat1': '#ad5d00',
  'deuplc.profHeat2': '#a53917',
  'deuplc.profHeat3': '#8e2015',
  'deuplc.profHeat4': '#6d1416',
  'deuplc.profHeat5': '#45080f',
  // end gen:heat
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
  // Dark half of the heat ramp — every id must exist in BOTH maps (see the light map's note).
  // gen:heat dark
  'deuplc.profHeat0': '#b14c4b',
  'deuplc.profHeat1': '#cf5f4d',
  'deuplc.profHeat2': '#e07f3e',
  'deuplc.profHeat3': '#ff990f',
  'deuplc.profHeat4': '#f6c495',
  'deuplc.profHeat5': '#ffea7e',
  // end gen:heat
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
  { token: 'string.hex', foreground: '9a6a00' },
  { token: 'type.constructor', foreground: '0270a0', fontStyle: 'bold' },
  { token: 'type', foreground: '0270a0' },
  { token: 'number', foreground: '9a6a00' },
  { token: 'operator', foreground: '383a42' },
  { token: 'identifier', foreground: 'cf3a2e' },
  { token: 'bracket', foreground: '9a6a00' },
  { token: 'keyword.operator', foreground: '2f63d8' },
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
  { token: 'string.hex', foreground: 'e2b86b' },
  { token: 'type.constructor', foreground: '89ddff', fontStyle: 'bold' },
  { token: 'type', foreground: '89ddff' },
  { token: 'number', foreground: 'f78c6c' },
  { token: 'operator', foreground: 'd7dce4' },
  { token: 'identifier', foreground: 'e06c75' },
  { token: 'bracket', foreground: 'ffc66d' },
  { token: 'keyword.operator', foreground: '82aaff' },
];
