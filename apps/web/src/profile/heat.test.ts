// Two things nobody can check by eye: where a bucket boundary actually falls, and whether the
// twelve hexes in `heat.ts` still match the twelve in `tokens.css` and the twenty-four (twelve × two
// theme maps) in `monaco.ts`. Both destinations are read here as TEXT, the same trick the generated
// types use with their sha256 guard — the point is to catch a HAND EDIT of a destination, which an
// import could never see.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bucketOf, laneClass, mergeRulerSlots, HEAT_DARK, HEAT_LIGHT, NO_BUCKET } from './heat';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const TOKENS_CSS = read('../theme/tokens.css');
const MONACO_TS = read('../editor/monaco.ts');

/** Share of the run as an absolute self-cost against a round total, so the fixtures read as %. */
const TOTAL = 1_000_000;
const share = (pct: number) => (TOTAL * pct) / 100;

describe('bucketOf', () => {
  // The four boundary cases the plan pins by name — a fixed LOG scale, so these are
  // absolute shares, not quantiles: the same colour means the same share in every profile forever.
  it('places the named boundaries', () => {
    expect(bucketOf(share(10.0), TOTAL, 1)).toBe(5);
    expect(bucketOf(share(9.99), TOTAL, 1)).toBe(4);
    expect(bucketOf(share(0.032), TOTAL, 1)).toBe(0);
    expect(bucketOf(share(0.031), TOTAL, 1)).toBe(NO_BUCKET);
  });

  it('is inclusive at every lower bound and exclusive just below it', () => {
    const bounds = [0.032, 0.1, 0.32, 1, 3.2, 10];
    bounds.forEach((pct, bucket) => {
      expect(bucketOf(share(pct), TOTAL, 1)).toBe(bucket);
      // Just below a bound is the bucket underneath (or nothing, at the bottom of the scale).
      expect(bucketOf(share(pct) - 1, TOTAL, 1)).toBe(bucket === 0 ? NO_BUCKET : bucket - 1);
    });
  });

  it('suppresses zeroes rather than painting them', () => {
    // A node that never ran is not "cold", it is absent — and unmarked lines are the background
    // that makes the marked ones visible at all.
    expect(bucketOf(share(50), TOTAL, 0)).toBe(NO_BUCKET); // hits === 0 outranks any cost
    expect(bucketOf(0, TOTAL, 1_000)).toBe(NO_BUCKET);
    expect(bucketOf(share(50), 0, 1)).toBe(NO_BUCKET);     // no total → no share to speak of
    expect(bucketOf(-5, TOTAL, 1)).toBe(NO_BUCKET);
  });

  it('saturates at the top bucket', () => {
    expect(bucketOf(TOTAL, TOTAL, 1)).toBe(5);
    expect(bucketOf(TOTAL * 2, TOTAL, 1)).toBe(5); // over-attribution must not fall off the ramp
  });
});

describe('laneClass', () => {
  it('is the shared class plus the bucket class, in that order', () => {
    // The e2e margin assertion matches `/(^| )prof-lane( |$)/` and `/prof-heat-[0-5]/` on the live
    // class attribute, and the CSS variables (`--prof-c`, `--prof-w`) are set by the bucket class
    // alone — so both tokens have to be present and separate.
    expect(laneClass(0)).toBe('prof-lane prof-heat-0');
    expect(laneClass(5)).toBe('prof-lane prof-heat-5');
  });

  it('adds the `≈` dimming class when Return-step cost dominates the line', () => {
    // The marker the report table prints as `≈` also rides the lane, as opacity 0.6 —
    // APPENDED, so the bucket's colour and width classes keep working unchanged.
    expect(laneClass(3, true)).toBe('prof-lane prof-heat-3 prof-lane-approx');
    expect(laneClass(3, false)).toBe(laneClass(3));
  });
});

describe('mergeRulerSlots', () => {
  it('emits one mark per pixel slot, carrying the hottest line in it', () => {
    // 900 lines onto a 90px ruler = 30 slots of 30 lines. Monaco does not merge ruler decorations,
    // so anything that leaks per-line marks here becomes 41k rendered rects at term size.
    const lines = [0, 1, 2, 3, 500, 899];
    const buckets = new Map([[0, 1], [1, 5], [2, 2], [3, 3], [500, 4], [899, 0]]);
    const slots = mergeRulerSlots(lines, (l) => buckets.get(l) ?? NO_BUCKET, 900, 90);
    expect(slots).toHaveLength(3);
    expect(slots[0]).toMatchObject({ bucket: 5, line: 1, firstLine: 0, lastLine: 29 });
    expect(slots[1]).toMatchObject({ bucket: 4, line: 500 });
    expect(slots[2]).toMatchObject({ bucket: 0, line: 899, lastLine: 899 });
  });

  it('stays under the design ceiling for a 200k-line document', () => {
    // The 400-mark ceiling is unreachable by construction: a slot is 3 device-px, so an 800px
    // ruler is ~266 slots whatever the document does.
    const lines = Int32Array.from({ length: 200_000 }, (_, i) => i);
    const slots = mergeRulerSlots(lines, () => 3, 200_000, 800);
    expect(slots.length).toBeLessThanOrEqual(400);
    expect(slots.length).toBeGreaterThan(200);
  });
});

// ── Drift guard ─────────────────────────────────────────────────────────────────────────────────

/** The `--prof-heat-N` values of one `:root` block, in bucket order. */
function cssRamp(block: string): string[] {
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const m = new RegExp(`--prof-heat-${i}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
    return m ? m[1].toLowerCase() : `MISSING --prof-heat-${i}`;
  });
}

/** The `deuplc.profHeatN` values of one theme map, in bucket order. */
function monacoRamp(block: string): string[] {
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const m = new RegExp(`'deuplc\\.profHeat${i}':\\s*'(#[0-9a-fA-F]{6})'`).exec(block);
    return m ? m[1].toLowerCase() : `MISSING deuplc.profHeat${i}`;
  });
}

describe('the generated ramp has not drifted from heat.ts', () => {
  // Split on the dark selectors, so a light/dark SWAP fails too — comparing an unordered set of
  // twelve hexes would pass on the worst possible edit.
  const cssDarkAt = TOKENS_CSS.indexOf(":root[data-theme='dark']");
  // `const`, because the identifier's FIRST mention is the `defineTheme` call above the maps.
  const monacoDarkAt = MONACO_TS.indexOf('const THEME_COLORS_DARK');

  it('splits into a light and a dark half', () => {
    expect(cssDarkAt).toBeGreaterThan(0);
    expect(monacoDarkAt).toBeGreaterThan(0);
  });

  it('matches theme/tokens.css (npm run gen:heat writes it)', () => {
    expect(cssRamp(TOKENS_CSS.slice(0, cssDarkAt))).toEqual([...HEAT_LIGHT]);
    expect(cssRamp(TOKENS_CSS.slice(cssDarkAt))).toEqual([...HEAT_DARK]);
  });

  it('matches BOTH theme maps in editor/monaco.ts', () => {
    // Both maps, because Monaco's resolver is `Color.fromHex` and an id missing from one map
    // resolves to nothing — the overview-ruler mark disappears in that theme, silently.
    expect(monacoRamp(MONACO_TS.slice(0, monacoDarkAt))).toEqual([...HEAT_LIGHT]);
    expect(monacoRamp(MONACO_TS.slice(monacoDarkAt))).toEqual([...HEAT_DARK]);
  });

  it('keeps the generator markers both destinations are patched through', () => {
    for (const [name, text] of [['tokens.css', TOKENS_CSS], ['monaco.ts', MONACO_TS]] as const) {
      expect(text, `${name}: gen:heat light`).toContain('gen:heat light');
      expect(text, `${name}: gen:heat dark`).toContain('gen:heat dark');
      expect(text.match(/end gen:heat/g)?.length, `${name}: end markers`).toBe(2);
    }
  });
});
