import { describe, expect, it } from 'vitest';
import { fmtSecs } from './format';

// Elapsed time is the one formatter with BANDS, and every band boundary is a place where a run can
// be printed as something it is not — which is exactly what `0.0 s` did to a 38 ms profile.

describe('fmtSecs', () => {
  it('prints whole milliseconds below a second, so a fast run is not a stopped clock', () => {
    expect(fmtSecs(0)).toBe('0 ms');
    expect(fmtSecs(38.4)).toBe('38 ms');
    expect(fmtSecs(999)).toBe('999 ms');
  });

  it('prints seconds with one decimal up to a minute', () => {
    expect(fmtSecs(1000)).toBe('1.0 s');
    expect(fmtSecs(1_540)).toBe('1.5 s');
    expect(fmtSecs(59_900)).toBe('59.9 s');
  });

  it('rounds into the next band rather than printing an impossible reading', () => {
    expect(fmtSecs(999.7)).toBe('1.0 s'); // not `1000 ms`
    expect(fmtSecs(119_600)).toBe('2 m 00 s'); // not `1 m 60 s`
  });

  it('prints minutes and zero-padded seconds beyond a minute', () => {
    expect(fmtSecs(60_000)).toBe('1 m 00 s');
    expect(fmtSecs(64_000)).toBe('1 m 04 s');
    expect(fmtSecs(3_671_000)).toBe('61 m 11 s');
  });

  it('has no reading for a non-duration', () => {
    expect(fmtSecs(-1)).toBe('—');
    expect(fmtSecs(NaN)).toBe('—');
    expect(fmtSecs(Infinity)).toBe('—');
  });
});
