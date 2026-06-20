// TextMate grammars + language configuration for the editor. Originally derived
// from the (now-retired) VS Code extension's syntaxes; these are the canonical
// copies and have since diverged — the UPLC grammar was extended for the
// canonical uplc-crate rendering. The grammar JSON is imported directly
// (resolveJsonModule); the same objects feed both the browser Monaco bridge
// (`textmate.ts`) and the Node tokenization snapshot test.

import uplcGrammar from './uplc.tmLanguage.json';
import plutusTypesGrammar from './plutus-types.tmLanguage.json';
import languageConfiguration from './language-configuration.json';

export interface LangDef {
  /** Monaco language id. */
  id: string;
  /** TextMate root scope name (matches the grammar's `scopeName`). */
  scopeName: string;
  extensions: string[];
}

export const LANGUAGES: LangDef[] = [
  { id: 'uplc', scopeName: 'source.uplc', extensions: ['.uplc'] },
  { id: 'plutus-types-json', scopeName: 'source.plutus-types-json', extensions: ['.ptypes'] },
];

/** scopeName -> raw grammar object (shape matches vscode-textmate's IRawGrammar). */
export const GRAMMARS: Record<string, unknown> = {
  'source.uplc': uplcGrammar,
  'source.plutus-types-json': plutusTypesGrammar,
};

export { languageConfiguration };
