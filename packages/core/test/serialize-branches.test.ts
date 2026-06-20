import { describe, it, expect } from 'vitest';
import { serializeTerm } from '../src/term-viewer/serialize';
import type { Term } from '../src/debugger-types';

// Branch coverage for the tree serializer: the original serialize.test.ts only
// exercised Apply→{Builtin,Constant}. These lock the byte-exact output of the
// remaining term branches (Lambda/Case/Delay/Force/Constr/Var/Error) and the
// multi-line nested-constant re-indent path, so the helper extraction in
// serialize.ts is provably behaviour-neutral. Snapshots captured from the
// pre-refactor serializer.

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
          "endLine": 21,
          "startLine": 0,
          "termId": 1,
        },
        {
          "endLine": 20,
          "startLine": 1,
          "termId": 2,
        },
        {
          "endLine": 15,
          "startLine": 2,
          "termId": 3,
        },
        {
          "endLine": 8,
          "startLine": 3,
          "termId": 4,
        },
        {
          "endLine": 7,
          "startLine": 4,
          "termId": 5,
        },
        {
          "endLine": 6,
          "startLine": 5,
          "termId": 6,
        },
        {
          "endLine": 14,
          "startLine": 8,
          "termId": 7,
        },
        {
          "endLine": 11,
          "startLine": 10,
          "termId": 8,
        },
        {
          "endLine": 12,
          "startLine": 11,
          "termId": 9,
        },
        {
          "endLine": 17,
          "startLine": 16,
          "termId": 10,
        },
        {
          "endLine": 18,
          "startLine": 17,
          "termId": 11,
        },
      ]
    `);
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
