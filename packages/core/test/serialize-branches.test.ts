import { describe, it, expect } from 'vitest';
import { serializeTerm } from '../src/term-viewer/serialize';
import type { Term } from '../src/debugger-types';

// Branch coverage for the tree serializer: the original serialize.test.ts only
// exercised Apply→{Builtin,Constant}. These lock the byte-exact output of the
// remaining term branches (Lambda/Case/Delay/Force/Constr/Var/Error) and the
// multi-line nested-constant re-indent path. The text snapshot is unchanged
// from the pre-refactor serializer; the locations snapshot reflects the fixed
// Constr header count (3 lines, not 2 — terms inside/after a Constr used to
// report lines one above where they render) and now also carries each node's
// `kind`/`label` — the profiler's `Node` column, which cannot be read back out
// of the rendered line. `endLine` here is still the raw EXCLUSIVE one; only
// `TermIndex` normalises it.

// Lambda → Case → Apply → {Delay→Force→Var, Constr→[Builtin, Error]} ; branches [Var, Error]
const branchy: Term = {
  term_type: 'Lambda', id: 1, parameterName: 'x',
  body: {
    term_type: 'Case', id: 2,
    constr: {
      term_type: 'Apply', id: 3,
      function: { term_type: 'Delay', id: 4, term: { term_type: 'Force', id: 5, term: { term_type: 'Var', id: 6, name: 'y' } } },
      argument: {
        term_type: 'Constr', id: 7, constructorTag: 0,
        fields: [
          { term_type: 'Builtin', id: 8, fun: 'addInteger' },
          { term_type: 'Error', id: 9 },
        ],
      },
    },
    branches: [
      { term_type: 'Var', id: 10, name: 'z' },
      { term_type: 'Error', id: 11 },
    ],
  },
};

// A nested multi-line constant (ProtoList of integers) — exercises renderStructuredType.
const listConst: Term = {
  term_type: 'Constant', id: 1,
  constant: {
    type: 'ProtoList', elementType: { type: 'Integer' },
    values: [
      { type: 'Integer', value: '1' },
      { type: 'Integer', value: '2' },
    ],
  },
};

describe('serializeTerm — branch coverage (byte-exact lock)', () => {
  it('Lambda/Case/Apply/Delay/Force/Constr/Builtin/Error/Var text', () => {
    expect(serializeTerm(branchy).text).toMatchInlineSnapshot(`
      "λ x {
        body: Case {
          constr: Apply {
            fun: Delay {
              term: Force {
                term: Var y
              }
            },
            arg: Constr {
              tag: 0,
              fields: [
                Built-in addInteger,
                ⚠️ Error
              ]
            }
          },
          branches: [
            Var z,
            ⚠️ Error
          ]
        }
      }"
    `);
  });

  it('Lambda/Case/... locations', () => {
    expect(serializeTerm(branchy).locations).toMatchInlineSnapshot(`
      [
        {
          "endLine": 22,
          "kind": "Lambda",
          "label": "x",
          "startLine": 0,
          "termId": 1,
        },
        {
          "endLine": 21,
          "kind": "Case",
          "label": undefined,
          "startLine": 1,
          "termId": 2,
        },
        {
          "endLine": 16,
          "kind": "Apply",
          "label": undefined,
          "startLine": 2,
          "termId": 3,
        },
        {
          "endLine": 8,
          "kind": "Delay",
          "label": undefined,
          "startLine": 3,
          "termId": 4,
        },
        {
          "endLine": 7,
          "kind": "Force",
          "label": undefined,
          "startLine": 4,
          "termId": 5,
        },
        {
          "endLine": 6,
          "kind": "Var",
          "label": "y",
          "startLine": 5,
          "termId": 6,
        },
        {
          "endLine": 15,
          "kind": "Constr",
          "label": undefined,
          "startLine": 8,
          "termId": 7,
        },
        {
          "endLine": 12,
          "kind": "Builtin",
          "label": "addInteger",
          "startLine": 11,
          "termId": 8,
        },
        {
          "endLine": 13,
          "kind": "Error",
          "label": undefined,
          "startLine": 12,
          "termId": 9,
        },
        {
          "endLine": 18,
          "kind": "Var",
          "label": "z",
          "startLine": 17,
          "termId": 10,
        },
        {
          "endLine": 19,
          "kind": "Error",
          "label": undefined,
          "startLine": 18,
          "termId": 11,
        },
      ]
    `);
  });

  // String constants with hostile content: a raw newline must not add physical
  // lines the line counters don't see, and a " {" inside the value must not pull
  // the id: hint into the middle of the string.
  it('String constant with newline stays one physical line (locations stay aligned)', () => {
    const term: Term = {
      term_type: 'Apply', id: 3,
      function: { term_type: 'Constant', id: 1, constant: { type: 'String', value: 'line1\nline2' } },
      argument: { term_type: 'Var', id: 2, name: 'x' },
    };
    const out = serializeTerm(term);
    expect(out.text.split('\n')).toEqual([
      'Apply {',
      '  fun: Const String: "line1\\nline2",',
      '  arg: Var x',
      '}',
    ]);
    // The Var after the constant maps to the line it actually renders on.
    expect(out.locations).toContainEqual({ startLine: 2, endLine: 3, termId: 2, kind: 'Var', label: 'x' });
  });

  it('id: hint sits right after the term type — never inside/after the value', () => {
    const term: Term = {
      term_type: 'Constant', id: 1,
      constant: { type: 'String', value: 'foo { bar' },
    };
    const out = serializeTerm(term);
    expect(out.text).toBe('Const String: "foo { bar"');
    // After "Const" (5 chars), regardless of what the value contains.
    expect(out.hints).toContainEqual({ line: 0, character: 5, text: ' id:1', kind: 'name' });
  });

  it('nested multi-line ProtoList constant text', () => {
    expect(serializeTerm(listConst).text).toMatchInlineSnapshot(`
      "Const ProtoList {
        elementType: Integer,
        values: [
          "1",
          "2"
        ]
      }"
    `);
  });
});
