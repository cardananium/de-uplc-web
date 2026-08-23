import type { languages } from 'monaco-editor';

/** Monarch tokenizer for decompiled Aiken-like output. Same tokens as dehosk-web. */
export const dehoskLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  keywords: [
    'fn', 'let', 'when', 'is', 'if', 'else', 'expect', 'rec', 'trace',
    'delay', 'force', 'seq', 'fail', 'and', 'or',
    'validator', 'const', 'pub', 'type', 'use',
  ],
  constructors: [
    'True', 'False', 'Some', 'None',
    'Minting', 'Spending', 'Rewarding', 'Certifying', 'Voting', 'Proposing',
    'VerificationKey', 'Script',
    'NoDatum', 'DatumHash', 'InlineDatum',
    'NegativeInfinity', 'Finite', 'PositiveInfinity',
  ],
  tokenizer: {
    root: [
      [/#"[0-9a-fA-F]*"/, 'string.hex'],
      [/@"/, 'string', '@string_at'],
      [/"/, 'string', '@string_dq'],
      [/Constr<\d+>/, 'type.constructor'],
      [/[A-Z]\w*/, {
        cases: {
          '@constructors': 'type.constructor',
          '@default': 'type',
        },
      }],
      [/Data\.\w+/, 'support.function'],
      [/List\.\w+/, 'support.function'],
      [/Pair\.\w+/, 'support.function'],
      [/[a-z_]\w*/, {
        cases: {
          '@keywords': 'keyword',
          '@default': 'identifier',
        },
      }],
      [/-?\d+/, 'number'],
      [/\.fields/, 'keyword.operator'],
      [/\.tag/, 'keyword.operator'],
      [/[=!<>]=?/, 'operator'],
      [/[&|]{2}/, 'operator'],
      [/[+\-*/%]/, 'operator'],
      [/\?/, 'operator'],
      [/->/, 'operator'],
      [/\.\./, 'operator'],
      [/[{}()\[\]]/, 'bracket'],
      [/\/\/.*$/, 'comment'],
      [/\s+/, 'white'],
    ],
    string_at: [
      [/[^"]+/, 'string'],
      [/"/, 'string', '@pop'],
    ],
    string_dq: [
      [/[^"\\]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, 'string', '@pop'],
    ],
  },
};

export const DEHOSK_LANG_ID = 'dehosk';
