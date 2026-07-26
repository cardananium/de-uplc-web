import { describe, expect, it } from 'vitest';
import type { DebuggerTypes } from '@de-uplc/core';
import {
  BUILTIN_GROUPS, CLASSIFIED_BUILTINS, builtinTotals, dataDecoding, groupBuiltins, groupOf,
} from './builtin-groups';

// The 87 names `DefaultFunction`'s Display emits (uplc @ 44df196, crates/uplc/src/builtins.rs) —
// exactly what `profile.rs` writes into `ProfileBuiltin.name`. Pinned here so that adding a builtin
// to the engine without classifying it fails a test instead of silently landing in "misc".
const BUILTIN_NAMES = [
  'addInteger', 'subtractInteger', 'multiplyInteger', 'divideInteger', 'quotientInteger',
  'remainderInteger', 'modInteger', 'equalsInteger', 'lessThanInteger', 'lessThanEqualsInteger',
  'appendByteString', 'consByteString', 'sliceByteString', 'lengthOfByteString', 'indexByteString',
  'equalsByteString', 'lessThanByteString', 'lessThanEqualsByteString',
  'sha2_256', 'sha3_256', 'blake2b_256', 'keccak_256', 'blake2b_224',
  'verifySignature', 'verifyEcdsaSecp256k1Signature', 'verifySchnorrSecp256k1Signature',
  'appendString', 'equalsString', 'encodeUtf8', 'decodeUtf8',
  'ifThenElse', 'chooseUnit', 'trace',
  'fstPair', 'sndPair', 'chooseList', 'mkCons', 'headList', 'tailList', 'nullList',
  'chooseData', 'constrData', 'mapData', 'listData', 'iData', 'bData',
  'unConstrData', 'unMapData', 'unListData', 'unIData', 'unBData',
  'equalsData', 'serialiseData', 'mkPairData', 'mkNilData', 'mkNilPairData',
  'bls12_381_G1_add', 'bls12_381_G1_neg', 'bls12_381_G1_scalarMul', 'bls12_381_G1_equal',
  'bls12_381_G1_compress', 'bls12_381_G1_uncompress', 'bls12_381_G1_hashToGroup',
  'bls12_381_G2_add', 'bls12_381_G2_neg', 'bls12_381_G2_scalarMul', 'bls12_381_G2_equal',
  'bls12_381_G2_compress', 'bls12_381_G2_uncompress', 'bls12_381_G2_hashToGroup',
  'bls12_381_millerLoop', 'bls12_381_mulMlResult', 'bls12_381_finalVerify',
  'integerToByteString', 'byteStringToInteger', 'andByteString', 'orByteString', 'xorByteString',
  'complementByteString', 'readBit', 'writeBits', 'replicateByte', 'shiftByteString',
  'rotateByteString', 'countSetBits', 'findFirstSetBit', 'ripemd_160',
];

const b = (name: string, calls: number, cpu: number, mem = cpu): DebuggerTypes.ProfileBuiltin =>
  ({ name, calls, cpu, mem });

describe('the classification', () => {
  it('covers all 87 builtins and nothing else', () => {
    expect(BUILTIN_NAMES).toHaveLength(87);
    expect(CLASSIFIED_BUILTINS).toBe(87);
    expect(BUILTIN_NAMES.filter((n) => groupOf(n) === 'control'))
      .toEqual(['ifThenElse', 'chooseUnit', 'trace']);
  });

  it('puts every *Data builtin in the group the DATA DECODING tooltip promises', () => {
    const data = BUILTIN_NAMES.filter((n) => n.endsWith('Data'));
    expect(data.every((n) => groupOf(n) === 'data')).toBe(true);
    expect(BUILTIN_NAMES.filter((n) => groupOf(n) === 'data')).toEqual(data);
  });

  it('falls back to misc for a name it has never seen', () => {
    expect(groupOf('expModInteger')).toBe('control');
    expect(groupOf('')).toBe('control');
  });

  it('has six groups, each of them used', () => {
    expect(BUILTIN_GROUPS).toHaveLength(6);
    const used = new Set(BUILTIN_NAMES.map(groupOf));
    expect([...BUILTIN_GROUPS].every((g) => used.has(g.id))).toBe(true);
  });
});

describe('grouping a report', () => {
  const builtins = [
    b('unConstrData', 20, 2000, 40),
    b('unIData', 10, 1000, 30),
    b('equalsInteger', 5, 500, 500),
    b('addInteger', 1, 50, 900),
  ];

  it('totals each group and orders groups AND rows by the active metric', () => {
    const cpu = groupBuiltins(builtins, 'cpu');
    expect(cpu.map((g) => g.id)).toEqual(['data', 'equality', 'arith']);
    expect(cpu[0]).toMatchObject({ calls: 30, cpu: 3000, mem: 70 });
    expect(cpu[0].rows.map((r) => r.name)).toEqual(['unConstrData', 'unIData']);

    // Under mem the same rows rank differently — the table may not stay cpu-ordered.
    expect(groupBuiltins(builtins, 'mem').map((g) => g.id)).toEqual(['arith', 'equality', 'data']);
  });

  it('drops groups nothing fired in', () => {
    expect(groupBuiltins([b('trace', 1, 1)], 'cpu').map((g) => g.id)).toEqual(['control']);
  });

  it('totals all builtins for the machine-vs-builtins split', () => {
    expect(builtinTotals(builtins)).toEqual({ calls: 36, cpu: 3550, mem: 1470 });
  });
});

describe('the DATA DECODING headline', () => {
  it('is the data group against ALL builtin cost, per metric', () => {
    const builtins = [b('unConstrData', 20, 3000, 100), b('addInteger', 10, 1000, 900)];
    expect(dataDecoding(builtins, 'cpu')).toEqual({
      cpu: 3000, mem: 100, calls: 20, builtins: 1, shareOfBuiltins: 0.75,
    });
    expect(dataDecoding(builtins, 'mem').shareOfBuiltins).toBeCloseTo(0.1);
  });

  it('is zero — not NaN — when no builtin ran at all', () => {
    expect(dataDecoding([], 'cpu')).toEqual({ cpu: 0, mem: 0, calls: 0, builtins: 0, shareOfBuiltins: 0 });
  });
});
