// The 87 Plutus builtins, bucketed into six readable groups.
//
// The Builtins table opens GROUPED because 87 flat rows are not a list a human reads — they are a
// glossary. The buckets are a naming heuristic over the UPLC names (`DefaultFunction`'s `Display`,
// which is what `profile.rs` writes into `ProfileBuiltin.name`), and the UI says so in as many
// words: "Grouping is a naming heuristic over the 87 builtin names."
//
// `data` is defined as exactly the `*Data`-suffixed builtins — not "the ones that decode" — because
// the report's headline calls it DATA DECODING and its tooltip promises "the *Data builtins". That
// puts `equalsData` here rather than under equality: it walks both arguments' Data structure, so
// its cost really is Data handling, and the tooltip stays literally true.
// A name this table does not know (a future builtin the engine grows) falls into `control` instead
// of vanishing — an unclassified row must still be counted somewhere.

import type { DebuggerTypes } from '@de-uplc/core';
import type { ProfileMetric } from '../platform/settings';

export type BuiltinGroupId = 'data' | 'equality' | 'list' | 'arith' | 'crypto' | 'control';

/** Declaration order — the tie-break when two groups cost the same. */
export const BUILTIN_GROUPS: readonly { id: BuiltinGroupId; title: string }[] = [
  { id: 'data', title: 'Data decode / encode' },
  { id: 'equality', title: 'Equality & compare' },
  { id: 'list', title: 'List & pair ops' },
  { id: 'arith', title: 'Integer & bytestring' },
  { id: 'crypto', title: 'Crypto & hashing' },
  { id: 'control', title: 'Control & misc' },
];

/** The group whose total the `DATA DECODING` headline reports. */
export const DATA_GROUP: BuiltinGroupId = 'data';

const G: Record<string, BuiltinGroupId> = {
  // ── Data decode / encode (every *Data builtin) ──
  chooseData: 'data', constrData: 'data', mapData: 'data', listData: 'data', iData: 'data',
  bData: 'data', unConstrData: 'data', unMapData: 'data', unListData: 'data', unIData: 'data',
  unBData: 'data', equalsData: 'data', serialiseData: 'data', mkPairData: 'data',
  mkNilData: 'data', mkNilPairData: 'data',

  // ── Equality & compare ──
  equalsInteger: 'equality', lessThanInteger: 'equality', lessThanEqualsInteger: 'equality',
  equalsByteString: 'equality', lessThanByteString: 'equality', lessThanEqualsByteString: 'equality',
  equalsString: 'equality',

  // ── List & pair ops ──
  fstPair: 'list', sndPair: 'list', chooseList: 'list', mkCons: 'list', headList: 'list',
  tailList: 'list', nullList: 'list',

  // ── Integer & bytestring (incl. the three string builtins: encode/decodeUtf8 are ByteString
  //    conversions and appendString rides with them) ──
  addInteger: 'arith', subtractInteger: 'arith', multiplyInteger: 'arith', divideInteger: 'arith',
  quotientInteger: 'arith', remainderInteger: 'arith', modInteger: 'arith',
  appendByteString: 'arith', consByteString: 'arith', sliceByteString: 'arith',
  lengthOfByteString: 'arith', indexByteString: 'arith',
  integerToByteString: 'arith', byteStringToInteger: 'arith',
  andByteString: 'arith', orByteString: 'arith', xorByteString: 'arith',
  complementByteString: 'arith', readBit: 'arith', writeBits: 'arith', replicateByte: 'arith',
  shiftByteString: 'arith', rotateByteString: 'arith', countSetBits: 'arith',
  findFirstSetBit: 'arith',
  appendString: 'arith', encodeUtf8: 'arith', decodeUtf8: 'arith',

  // ── Crypto & hashing ──
  sha2_256: 'crypto', sha3_256: 'crypto', blake2b_256: 'crypto', keccak_256: 'crypto',
  blake2b_224: 'crypto', ripemd_160: 'crypto',
  verifySignature: 'crypto', verifyEcdsaSecp256k1Signature: 'crypto',
  verifySchnorrSecp256k1Signature: 'crypto',
  bls12_381_G1_add: 'crypto', bls12_381_G1_neg: 'crypto', bls12_381_G1_scalarMul: 'crypto',
  bls12_381_G1_equal: 'crypto', bls12_381_G1_compress: 'crypto', bls12_381_G1_uncompress: 'crypto',
  bls12_381_G1_hashToGroup: 'crypto',
  bls12_381_G2_add: 'crypto', bls12_381_G2_neg: 'crypto', bls12_381_G2_scalarMul: 'crypto',
  bls12_381_G2_equal: 'crypto', bls12_381_G2_compress: 'crypto', bls12_381_G2_uncompress: 'crypto',
  bls12_381_G2_hashToGroup: 'crypto',
  bls12_381_millerLoop: 'crypto', bls12_381_mulMlResult: 'crypto', bls12_381_finalVerify: 'crypto',

  // ── Control & misc ──
  ifThenElse: 'control', chooseUnit: 'control', trace: 'control',
};

/** Number of names this table classifies — pinned by the test, so a silent drop is a failure. */
export const CLASSIFIED_BUILTINS = Object.keys(G).length;

/** Group of a builtin name; unknown names land in `control` rather than disappearing. */
export function groupOf(name: string): BuiltinGroupId {
  return G[name] ?? 'control';
}

/** One group's rows plus its totals — the collapsed row and what it expands into. */
export interface BuiltinGroupTotals {
  id: BuiltinGroupId;
  title: string;
  calls: number;
  cpu: number;
  mem: number;
  rows: DebuggerTypes.ProfileBuiltin[];
}

/**
 * Bucket the report's builtins and total each group. Empty groups are dropped (a group with no
 * calls is not information), and both the groups and the rows inside them are ordered by the ACTIVE
 * metric, descending — the table's one ordering rule, so switching CPU↔Mem re-ranks everything at
 * once instead of leaving a cpu-ordered list under mem numbers.
 */
export function groupBuiltins(
  builtins: readonly DebuggerTypes.ProfileBuiltin[],
  metric: ProfileMetric,
): BuiltinGroupTotals[] {
  const cost = (b: DebuggerTypes.ProfileBuiltin) => (metric === 'cpu' ? b.cpu : b.mem);
  const out = BUILTIN_GROUPS.map((g) => ({ ...g, calls: 0, cpu: 0, mem: 0, rows: [] as DebuggerTypes.ProfileBuiltin[] }));
  const byId = new Map(out.map((g) => [g.id, g]));
  for (const b of builtins) {
    const g = byId.get(groupOf(b.name));
    if (!g) continue;
    g.calls += b.calls;
    g.cpu += b.cpu;
    g.mem += b.mem;
    g.rows.push(b);
  }
  for (const g of out) g.rows.sort((a, b) => cost(b) - cost(a) || a.name.localeCompare(b.name));
  return out
    .filter((g) => g.rows.length > 0)
    .sort((a, b) => (metric === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem));
}

/** Totals over ALL builtins — the denominator of "% of all builtin cost" and the machine-vs-builtin
 *  split line under the table. */
export function builtinTotals(builtins: readonly DebuggerTypes.ProfileBuiltin[]): { calls: number; cpu: number; mem: number } {
  let calls = 0;
  let cpu = 0;
  let mem = 0;
  for (const b of builtins) {
    calls += b.calls;
    cpu += b.cpu;
    mem += b.mem;
  }
  return { calls, cpu, mem };
}

/** What the `DATA DECODING is …` headline needs: the `data` group's totals, its share of all
 *  builtin cost, and how many distinct `*Data` builtins actually fired. */
export interface DataDecoding {
  cpu: number;
  mem: number;
  calls: number;
  /** Distinct builtins in the group that fired at least once. */
  builtins: number;
  /** Group cost ÷ all builtin cost, in the active metric. `0` when no builtin ran. */
  shareOfBuiltins: number;
}

export function dataDecoding(
  builtins: readonly DebuggerTypes.ProfileBuiltin[],
  metric: ProfileMetric,
): DataDecoding {
  const all = builtinTotals(builtins);
  const dd: DataDecoding = { cpu: 0, mem: 0, calls: 0, builtins: 0, shareOfBuiltins: 0 };
  for (const b of builtins) {
    if (groupOf(b.name) !== DATA_GROUP) continue;
    dd.cpu += b.cpu;
    dd.mem += b.mem;
    dd.calls += b.calls;
    dd.builtins += 1;
  }
  const whole = metric === 'cpu' ? all.cpu : all.mem;
  const part = metric === 'cpu' ? dd.cpu : dd.mem;
  dd.shareOfBuiltins = whole > 0 ? part / whole : 0;
  return dd;
}
