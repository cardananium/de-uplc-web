import { describe, expect, it } from 'vitest';
import type { OptionCatalogue } from './catalogue';
import { mergeLaunchOptions } from './launch-options';

const CATALOGUE: OptionCatalogue = {
  version: 1,
  defaults: {
    safe_mode: false,
    script_version: null,
    simplify_passes: { inline_fp: true },
    validator_shape: { applied_kind: 'Compile' },
  },
  groups: [{
    id: 'g', title: 'g', summary: '', detail: [], masterPath: null,
    options: [
      { path: ['safe_mode'], field: 'safe_mode', label: '', summary: '', detail: [], kind: { type: 'toggle' } },
      {
        path: ['script_version'], field: 'script_version', label: '', summary: '', detail: [],
        kind: { type: 'choice', unset: 'Auto-detect', choices: [{ value: 'PlutusV2', label: '', summary: '' }] },
      },
      { path: ['simplify_passes', 'inline_fp'], field: 'inline_fp', label: '', summary: '', detail: [], kind: { type: 'toggle' } },
      {
        path: ['validator_shape', 'applied_kind'], field: 'applied_kind', label: '', summary: '', detail: [],
        kind: {
          type: 'choice', unset: null, choices: [
            { value: 'Compile', label: '', summary: '' },
            { value: 'Explicit', label: '', summary: '', payload: { type: 'count', key: 'runtime_count', min: 0, default: 1 } },
          ],
        },
      },
    ],
  }],
};

describe('mergeLaunchOptions', () => {
  it('lays known, well-typed values over the base', () => {
    const { options, ignored } = mergeLaunchOptions(CATALOGUE, CATALOGUE.defaults, {
      safe_mode: true,
      script_version: 'PlutusV2',
      simplify_passes: { inline_fp: false },
      validator_shape: { applied_kind: { runtime_count: 2 } },
    });
    expect(ignored).toEqual([]);
    expect(options).toEqual({
      safe_mode: true,
      script_version: 'PlutusV2',
      simplify_passes: { inline_fp: false },
      validator_shape: { applied_kind: { runtime_count: 2 } },
    });
  });

  it('reports unknown and mistyped keys and leaves them out', () => {
    const { options, ignored } = mergeLaunchOptions(CATALOGUE, CATALOGUE.defaults, {
      safe_mode: 'yes',
      future_flag: true,
      simplify_passes: { inline_fp: false, new_pass: true },
      validator_shape: { applied_kind: null },
      script_version: null,
    });
    expect(ignored.sort()).toEqual(['future_flag', 'safe_mode', 'simplify_passes.new_pass', 'validator_shape.applied_kind']);
    expect(options).toEqual({ ...CATALOGUE.defaults, simplify_passes: { inline_fp: false } });
  });
});
