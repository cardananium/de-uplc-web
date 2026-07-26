// The name a term node reports — the one piece of a node's identity that must NOT change with
// the Term view. Both serializers call in here, so `TermLocation.label` (the profiler's `Node`
// column, its top-5 rows and its hover heading) says `unConstrData` whichever renderer produced
// the text; scraping the rendered line instead is not an option, because the two renderings print
// the same node differently (`Built-in UnConstrData` vs `(builtin unConstrData)`).

import type { Term } from '../debugger-types';

// `term.fun` is the Rust enum variant name (Debug, e.g. `UnListData`); canonical UPLC uses the
// camelCase builtin name. Most are just the variant with a lower-cased first letter; these are
// the ones that differ.

const BUILTIN_OVERRIDES: Record<string, string> = {
  VerifyEd25519Signature: 'verifySignature',
  Bls12_381_G1_Add: 'bls12_381_G1_add',
  Bls12_381_G1_Neg: 'bls12_381_G1_neg',
  Bls12_381_G1_ScalarMul: 'bls12_381_G1_scalarMul',
  Bls12_381_G1_Equal: 'bls12_381_G1_equal',
  Bls12_381_G1_Compress: 'bls12_381_G1_compress',
  Bls12_381_G1_Uncompress: 'bls12_381_G1_uncompress',
  Bls12_381_G1_HashToGroup: 'bls12_381_G1_hashToGroup',
  Bls12_381_G2_Add: 'bls12_381_G2_add',
  Bls12_381_G2_Neg: 'bls12_381_G2_neg',
  Bls12_381_G2_ScalarMul: 'bls12_381_G2_scalarMul',
  Bls12_381_G2_Equal: 'bls12_381_G2_equal',
  Bls12_381_G2_Compress: 'bls12_381_G2_compress',
  Bls12_381_G2_Uncompress: 'bls12_381_G2_uncompress',
  Bls12_381_G2_HashToGroup: 'bls12_381_G2_hashToGroup',
  Bls12_381_MillerLoop: 'bls12_381_millerLoop',
  Bls12_381_MulMlResult: 'bls12_381_mulMlResult',
  Bls12_381_FinalVerify: 'bls12_381_finalVerify',
};

/** Canonical (camelCase) UPLC name of a builtin, from the Rust enum variant name. */
export function builtinName(fun: string): string {
  return BUILTIN_OVERRIDES[fun] ?? (fun ? fun[0].toLowerCase() + fun.slice(1) : fun);
}

/**
 * The node's own name, when its shape has one: builtin name, variable name, lambda parameter.
 * Anything else (Apply, Force, …) is fully described by its `kind` and gets no label — a bare
 * `Apply` in the report is expected, a WRONG name is not.
 */
export function termLabel(term: Term): string | undefined {
  switch (term.term_type) {
    case 'Builtin': return builtinName(term.fun);
    case 'Var': return term.name;
    case 'Lambda': return term.parameterName;
    default: return undefined;
  }
}
