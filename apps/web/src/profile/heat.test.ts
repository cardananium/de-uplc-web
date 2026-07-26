// Two things nobody can check by eye: where a bucket boundary actually falls, and whether the
// twelve hexes in `heat.ts` still match the twelve in `tokens.css` and the twenty-four (twelve × two
// theme maps) in `monaco.ts`. Both destinations are read here as TEXT, the same trick the generated
// types use with their sha256 guard — the point is to catch a HAND EDIT of a destination, which an
// import could never see.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  bucketOf, laneClass, mergeRulerSlots,
  HEAT_DARK, HEAT_LIGHT, HEAT_DARK_CONTRAST, HEAT_LIGHT_CONTRAST, NO_BUCKET,
} from './heat';

const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const TOKENS_CSS = read('../theme/tokens.css');
const MONACO_TS = read('../editor/monaco.ts');
const TERM_CSS = read('../editor/term-editor.css');

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

  // The `prefers-contrast: more` triples are NOT generated — a media query cannot be expressed as a
  // token block — so they are the one remaining hand-copied pair. Guard them the same way.
  it('matches the prefers-contrast override in term-editor.css', () => {
    const block = TERM_CSS.slice(TERM_CSS.indexOf('@media (prefers-contrast: more)'));
    const darkAt = block.indexOf(":root[data-theme='dark']");
    expect(darkAt).toBeGreaterThan(0);
    expect(cssRamp(block.slice(0, darkAt))).toEqual([...HEAT_LIGHT_CONTRAST]);
    expect(cssRamp(block.slice(darkAt))).toEqual([...HEAT_DARK_CONTRAST]);
  });
});

// ── The properties the ramp was chosen for ──────────────────────────────────────────────────────
//
// Prose in heat.ts claims a contrast floor, a monotone ladder and one warm family. Prose does not
// fail CI, so the claims are recomputed here from the hexes and from the REAL editor surfaces
// (parsed out of monaco.ts, so a re-theme of the editor breaks this instead of quietly
// invalidating every ratio comment in three files).

/** WCAG 2.x relative luminance of `#rrggbb`. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
/** Composite `#rrggbbaa` over an opaque background — how the caret line reaches the lane. */
function over(fg: string, bg: string): string {
  const a = fg.length === 9 ? parseInt(fg.slice(7, 9), 16) / 255 : 1;
  return '#' + [1, 3, 5].map((i) => {
    const f = parseInt(fg.slice(i, i + 2), 16), b = parseInt(bg.slice(i, i + 2), 16);
    return Math.round(f * a + b * (1 - a)).toString(16).padStart(2, '0');
  }).join('');
}
/** OKLCH hue in degrees — 0 = magenta-red, ~90 = yellow. "Warm" is the 15°–105° sector. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
}

/** `editor.background` and the caret-line composite of one monaco.ts theme map. */
function surfaces(mapName: string): { bg: string; caret: string } {
  const body = new RegExp(`const ${mapName}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`).exec(MONACO_TS);
  expect(body, `${mapName} in monaco.ts`).toBeTruthy();
  const pick = (id: string) => {
    const m = new RegExp(`'${id}':\\s*'(#[0-9a-fA-F]{6,8})'`).exec(body![1]);
    expect(m, `'${id}' in ${mapName}`).toBeTruthy();
    return m![1].toLowerCase();
  };
  const bg = pick('editor.background');
  return { bg, caret: over(pick('editor.lineHighlightBackground'), bg) };
}

describe.each([
  ['light', HEAT_LIGHT, 'THEME_COLORS'],
  ['dark', HEAT_DARK, 'THEME_COLORS_DARK'],
])('%s ramp', (theme, ramp, mapName) => {
  const { bg, caret } = surfaces(mapName);

  it('clears 3:1 on the editor background AND on the caret line', () => {
    // Both, because `renderLineHighlight: 'gutter'` paints the current-line highlight across the
    // margin: on the caret's line the bar is on the composite, which is the LOWER of the two.
    for (const [i, hex] of ramp.entries()) {
      expect(contrast(hex, bg), `${theme} heat-${i} ${hex} on ${bg}`).toBeGreaterThanOrEqual(3);
      expect(contrast(hex, caret), `${theme} heat-${i} ${hex} on the caret line ${caret}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('is monotone in contrast, in even steps', () => {
    // The property the ramp is built on: colour ORDERS the buckets, and it can only do that if
    // contrast rises with every step. Even steps (~+35%) keep any one boundary from being the
    // only readable one — the band is wide enough to survive a hex nudge, narrow enough to fail a
    // ladder that collapses at one end.
    const ratios = ramp.map((hex) => contrast(hex, bg));
    for (let i = 1; i < ratios.length; i++) {
      const step = ratios[i] / ratios[i - 1];
      expect(step, `${theme} heat-${i - 1}→${i} step`).toBeGreaterThan(1.25);
      expect(step, `${theme} heat-${i - 1}→${i} step`).toBeLessThan(1.45);
    }
  });

  it('stays inside ONE warm family', () => {
    // Amber → orange → rust → red → deep red. A hue that leaves this sector is the failure this
    // ramp replaced: an olive → raspberry → violet → navy arc orders nothing to the eye.
    for (const [i, hex] of ramp.entries()) {
      expect(hue(hex), `${theme} heat-${i} ${hex} hue`).toBeGreaterThan(15);
      expect(hue(hex), `${theme} heat-${i} ${hex} hue`).toBeLessThan(105);
    }
  });
});

describe('the generated ratio comments', () => {
  it('say what the values actually measure', () => {
    // `npm run gen:heat` writes these next to every hex in three files. If they were hand-typed
    // once and then a hex moved, every reader would be told a number that is no longer true.
    for (const [ramp, mapName, half] of [
      [HEAT_LIGHT, 'THEME_COLORS', TOKENS_CSS.slice(0, TOKENS_CSS.indexOf(":root[data-theme='dark']"))],
      [HEAT_DARK, 'THEME_COLORS_DARK', TOKENS_CSS.slice(TOKENS_CSS.indexOf(":root[data-theme='dark']"))],
    ] as const) {
      const { bg, caret } = surfaces(mapName);
      ramp.forEach((hex, i) => {
        const m = new RegExp(`--prof-heat-${i}:\\s*${hex};\\s*/\\*\\s*([\\d.]+):1\\s*/\\s*([\\d.]+):1`).exec(half);
        expect(m, `${mapName} heat-${i} ratio comment`).toBeTruthy();
        expect(Number(m![1])).toBeCloseTo(contrast(hex, bg), 1);
        expect(Number(m![2])).toBeCloseTo(contrast(hex, caret), 1);
      });
    }
  });
});

// ── The CVD claim, recomputed ────────────────────────────────────────────────────────────────
//
// The hues were chosen to survive dichromacy, and that claim was the whole reason for preferring
// one ramp over another — yet it was the one property nothing here recomputed, so a hex nudge could
// break it while every other guard stayed green.

/** Viénot–Brettel–Mollon 1999 dichromat projection. `kind` is the missing cone. */
function cvd(hex: string, kind: 'deutan' | 'protan'): string {
  const lin = [1, 3, 5].map((i) => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  // sRGB → LMS (Hunt–Pointer–Estévez, as used by VBM).
  const L = 0.31399022 * lin[0] + 0.63951294 * lin[1] + 0.04649755 * lin[2];
  const M = 0.15537241 * lin[0] + 0.75789446 * lin[1] + 0.08670142 * lin[2];
  const S = 0.01775239 * lin[0] + 0.10944209 * lin[1] + 0.87256922 * lin[2];
  // Project onto the plane the missing cone cannot distinguish (blue/yellow anchors).
  const [l2, m2, s2] = kind === 'protan'
    ? [0.0 * L + 1.05118294 * M + -0.05116099 * S, M, S]
    : [L, 0.9513092 * L + 0.0 * M + 0.04866992 * S, S];
  const back = [
    5.47221206 * l2 + -4.6419601 * m2 + 0.16963708 * s2,
    -1.1252419 * l2 + 2.29317094 * m2 + -0.1678952 * s2,
    0.02980165 * l2 + -0.19318073 * m2 + 1.16364789 * s2,
  ];
  return '#' + back.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
  }).join('');
}

/** CIE Lab (D65) of `#rrggbb`. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27) * t / 116 + 16 / 116);
  const [x, y, z] = [
    f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047),
    f(0.2126729 * r + 0.7151522 * g + 0.072175 * b),
    f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883),
  ];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 over two Lab triples. ~2.3 is one just-noticeable difference. */
function ciede2000Lab(p: [number, number, number], q: [number, number, number]): number {
  const [L1, a1, b1] = p, [L2, a2, b2] = q;
  const rad = Math.PI / 180, deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const G = 0.5 * (1 - Math.sqrt(((C1 + C2) / 2) ** 7 / (((C1 + C2) / 2) ** 7 + 25 ** 7)));
  const A1 = (1 + G) * a1, A2 = (1 + G) * a2;
  const Cp1 = Math.hypot(A1, b1), Cp2 = Math.hypot(A2, b2);
  const hp = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) * deg + 360) % 360);
  const h1p = hp(b1, A1), h2p = hp(b2, A2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) {
    dh = h2p - h1p;
    if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  }
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh * rad) / 2);
  const Lb = (L1 + L2) / 2, Cb = (Cp1 + Cp2) / 2;
  let hb = h1p + h2p;
  if (Cp1 * Cp2 !== 0) {
    if (Math.abs(h1p - h2p) > 180) hb += h1p + h2p < 360 ? 360 : -360;
    hb /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad)
    + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cb, Sh = 1 + 0.015 * Cb * T;
  const Rt = -2 * Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7))
    * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}
const ciede2000 = (h1: string, h2: string) => ciede2000Lab(lab(h1), lab(h2));

describe('the ramp under dichromacy', () => {
  // The metric is pinned to published test vectors before it is allowed to judge our colours:
  // a wrong CIEDE2000 would make the floor below meaningless. Sharma, Wu & Dalal (2005), the
  // pairs that exercise the hue-rotation term.
  it.each([
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
  ] as const)('matches the published vector %#', (p, q, want) => {
    expect(ciede2000Lab(p as never, q as never)).toBeCloseTo(want, 3);
  });

  it.each([
    ['light', HEAT_LIGHT],
    ['dark', HEAT_DARK],
  ])('keeps every adjacent %s pair apart for deuteranopes and protanopes', (_name, ramp) => {
    for (const kind of ['deutan', 'protan'] as const) {
      for (let i = 0; i + 1 < ramp.length; i++) {
        const d = ciede2000(cvd(ramp[i], kind), cvd(ramp[i + 1], kind));
        // 2.3 is one JND, and the bars are 4–14px wide, so a step near the threshold is not enough
        // on its own. Measured minima under THIS projection: light 6.3 (deutan 0→1) / 7.4 (protan),
        // dark 8.6 / 9.4. The floor is 5 — a little over 2 JND — deliberately below those: the
        // absolute number moves with the dichromat model (published matrices disagree by ~1 ΔE00),
        // so pinning it tight would fail on a model change rather than on a colour change. What it
        // does catch is the thing worth catching: a hex edit that halves a pair's separation.
        expect(d, `${kind} ${i}→${i + 1}`).toBeGreaterThan(5);
      }
    }
  });
});
