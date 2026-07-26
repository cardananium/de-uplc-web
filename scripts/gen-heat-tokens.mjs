#!/usr/bin/env node
// Prints the profiler heat ramp from its ONE source — the twelve hexes in
// apps/web/src/profile/heat.ts — into the two places that cannot import it:
//
//   * apps/web/src/theme/tokens.css   `--prof-heat-0..5`, once per theme (the CSS lane reads them
//     through `--prof-c`, so it follows `data-theme` for free);
//   * apps/web/src/editor/monaco.ts   `deuplc.profHeat0..5` in BOTH theme maps, as plain hex —
//     Monaco's colour resolver is `Color.fromHex`, and a missing id resolves to nothing, so an
//     overview-ruler mark would silently vanish rather than fail.
//
// The WCAG ratio next to every value is COMPUTED here, not typed by hand — including in heat.ts
// itself, whose trailing comments this script rewrites. The two surfaces the ratios are measured
// against are read out of monaco.ts (`editor.background` and `editor.lineHighlightBackground`
// composited over it), so re-theming the editor moves the numbers instead of silently invalidating
// them. Twelve hexes and thirty-six ratios across three files is exactly the kind of table that
// rots; `npm run gen:heat` writes it, `npm run check:heat` fails when any copy drifts, and
// apps/web/src/profile/heat.test.ts re-reads both destinations as text (the same trick as the
// sha256 type guard). Nobody hand-syncs these.
//
//   node scripts/gen-heat-tokens.mjs           patch the three files in place
//   node scripts/gen-heat-tokens.mjs --check   exit 1 if any file is out of date (CI/pre-commit)
//   node scripts/gen-heat-tokens.mjs --print   dump the blocks to stdout, touch nothing
//
// heat.ts is TypeScript, so it is read as TEXT rather than imported: `node` has no TS loader here,
// and the arrays are a flat list of string literals.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const HEAT_TS = at('apps/web/src/profile/heat.ts');
const TOKENS_CSS = at('apps/web/src/theme/tokens.css');
const MONACO_TS = at('apps/web/src/editor/monaco.ts');

const BUCKETS = 6;

// ── colour maths ───────────────────────────────────────────────────────────────────────────────

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/** WCAG 2.x relative luminance of an opaque `#rrggbb`. */
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((c) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Composite `#rrggbbaa` (or an opaque `#rrggbb`) over an opaque background. */
function over(fg, bg) {
  const a = fg.length === 9 ? parseInt(fg.slice(7, 9), 16) / 255 : 1;
  const [f, b] = [rgb(fg), rgb(bg)];
  return '#' + [0, 1, 2].map((i) => hex2(f[i] * a + b[i] * (1 - a))).join('');
}

/**
 * The two surfaces one theme's lane is ever drawn on, read out of monaco.ts: the editor background,
 * and the CARET LINE — `renderLineHighlight: 'gutter'` paints the current-line highlight ACROSS the
 * margin, so on that one line the bar sits on the composite, not on the background.
 */
function surfaces(monaco, mapName) {
  const body = new RegExp(`const ${mapName}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`).exec(monaco);
  if (!body) throw new Error(`${mapName} not found in monaco.ts — the generator's source contract broke`);
  const pick = (id) => {
    const m = new RegExp(`'${id}':\\s*'(#[0-9a-fA-F]{6,8})'`).exec(body[1]);
    if (!m) throw new Error(`${mapName} has no '${id}'`);
    return m[1].toLowerCase();
  };
  const bg = pick('editor.background');
  return { bg, caret: over(pick('editor.lineHighlightBackground'), bg) };
}

/** ` 3.59:1 /  3.32:1   step +35%` — the ratio pair, plus the rise over the previous bucket. */
function note(hex, prevHex, { bg, caret }) {
  const p = (n) => n.toFixed(2).padStart(5);
  const head = `${p(contrast(hex, bg))}:1 / ${p(contrast(hex, caret))}:1`;
  if (!prevHex) return head;
  const step = (contrast(hex, bg) / contrast(prevHex, bg) - 1) * 100;
  return `${head}   step +${step.toFixed(0)}%`;
}

// ── the ramp ───────────────────────────────────────────────────────────────────────────────────

/** Pull `['#hex', …]` out of a `heat.ts` array literal and annotate each entry with its ratios. */
function readRamp(source, name, surf) {
  const body = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`).exec(source);
  if (!body) throw new Error(`${name} not found in heat.ts — the generator's source contract broke`);
  const out = [];
  for (const line of body[1].split('\n')) {
    const m = /'(#[0-9a-fA-F]{6})'\s*,/.exec(line.trim());
    if (m) out.push({ hex: m[1].toLowerCase() });
  }
  if (out.length !== BUCKETS) throw new Error(`${name} has ${out.length} entries, expected ${BUCKETS}`);
  return out.map((c, i) => ({ ...c, note: note(c.hex, out[i - 1]?.hex, surf) }));
}

/** Rewrite heat.ts's own array so the ratio comments are generated too, not hand-maintained. */
function patchRamp(text, name, ramp) {
  const body = new RegExp(`(export const ${name}[^=]*=\\s*\\[)([\\s\\S]*?)(\\];)`).exec(text);
  if (!body) throw new Error(`${name} not found in heat.ts`);
  const lines = ramp.map((c) => `  '${c.hex}', // ${c.note}`);
  return text.slice(0, body.index) + body[1] + '\n' + lines.join('\n') + '\n' + body[3]
    + text.slice(body.index + body[0].length);
}

/**
 * Rewrite the lines between `// gen:heat <theme>` and the next `end gen:heat`, keeping the marker
 * lines and their indentation. Line-based on purpose: it survives whatever prose the destination
 * keeps around the block, and it fails loudly when a marker is gone instead of appending a second
 * copy of the ramp.
 */
function patchBlock(text, theme, lines) {
  const src = text.split('\n');
  const start = src.findIndex((l) => l.includes(`gen:heat ${theme}`));
  if (start < 0) throw new Error(`marker "gen:heat ${theme}" not found`);
  const end = src.findIndex((l, i) => i > start && l.includes('end gen:heat'));
  if (end < 0) throw new Error(`marker "end gen:heat" after "gen:heat ${theme}" not found`);
  const indent = /^\s*/.exec(src[start])[0];
  return [...src.slice(0, start + 1), ...lines.map((l) => indent + l), ...src.slice(end)].join('\n');
}

/** One `--prof-heat-N: <hex>;` per bucket, with heat.ts's WCAG ratio kept as a trailing comment so
 *  the numbers stay next to the value they describe. */
function cssLines(ramp) {
  return ramp.map((c, i) => `--prof-heat-${i}: ${c.hex};${c.note ? ` /* ${c.note} */` : ''}`);
}

/** `'deuplc.profHeat0': '#968800',` — plain hex, no `var()`, no shared constant. */
function monacoLines(ramp) {
  return ramp.map((c, i) => `'deuplc.profHeat${i}': '${c.hex}',`);
}

const heat = readFileSync(HEAT_TS, 'utf8');
const monaco = readFileSync(MONACO_TS, 'utf8');
const surfL = surfaces(monaco, 'THEME_COLORS');
const surfD = surfaces(monaco, 'THEME_COLORS_DARK');
const light = readRamp(heat, 'HEAT_LIGHT', surfL);
const dark = readRamp(heat, 'HEAT_DARK', surfD);

const targets = [
  // heat.ts first: it is the source of the hexes but NOT of the ratios beside them.
  { path: HEAT_TS, name: 'profile/heat.ts', patch: (t) => patchRamp(patchRamp(t, 'HEAT_LIGHT', light), 'HEAT_DARK', dark) },
  { path: TOKENS_CSS, name: 'theme/tokens.css', render: cssLines },
  { path: MONACO_TS, name: 'editor/monaco.ts', render: monacoLines },
];

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--print') ? 'print' : 'write';
let stale = 0;

if (mode === 'print') {
  console.log(`surfaces  light: ${surfL.bg} / caret ${surfL.caret}   dark: ${surfD.bg} / caret ${surfD.caret}`);
}
for (const t of targets) {
  const before = readFileSync(t.path, 'utf8');
  const after = t.patch
    ? t.patch(before)
    : patchBlock(patchBlock(before, 'light', t.render(light)), 'dark', t.render(dark));
  if (mode === 'print') {
    const render = t.render ?? ((r) => r.map((c) => `'${c.hex}', // ${c.note}`));
    process.stdout.write(`── ${t.name} ──\n${render(light).join('\n')}\n\n${render(dark).join('\n')}\n\n`);
    continue;
  }
  if (after === before) {
    console.log(`ok    ${t.name}`);
    continue;
  }
  stale += 1;
  if (mode === 'check') {
    console.error(`STALE ${t.name} — run \`npm run gen:heat\``);
  } else {
    writeFileSync(t.path, after);
    console.log(`wrote ${t.name}`);
  }
}

if (mode === 'check' && stale > 0) process.exit(1);
