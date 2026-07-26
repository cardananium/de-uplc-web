#!/usr/bin/env node
// Prints the profiler heat ramp from its ONE source — apps/web/src/profile/heat.ts — into the two
// places that cannot import it:
//
//   * apps/web/src/theme/tokens.css   `--prof-heat-0..5`, once per theme (the CSS lane reads them
//     through `--prof-c`, so it follows `data-theme` for free);
//   * apps/web/src/editor/monaco.ts   `deuplc.profHeat0..5` in BOTH theme maps, as plain hex —
//     Monaco's colour resolver is `Color.fromHex`, and a missing id resolves to nothing, so an
//     overview-ruler mark would silently vanish rather than fail.
//
// Twelve hexes in three files is exactly the kind of table that rots; `npm run gen:heat` writes it
// and `apps/web/src/profile/heat.test.ts` re-reads both destinations as text and fails on any
// divergence (the same trick as the sha256 type guard). Nobody hand-syncs these.
//
//   node scripts/gen-heat-tokens.mjs           patch the two files in place
//   node scripts/gen-heat-tokens.mjs --check   exit 1 if either file is out of date (CI/pre-commit)
//   node scripts/gen-heat-tokens.mjs --print   dump the blocks to stdout, touch nothing
//
// heat.ts is TypeScript, so it is read as TEXT rather than imported: `node` has no TS loader here,
// and the arrays are a flat list of string literals whose trailing comments (the WCAG ratios) are
// worth carrying into the destinations verbatim.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const HEAT_TS = at('apps/web/src/profile/heat.ts');
const TOKENS_CSS = at('apps/web/src/theme/tokens.css');
const MONACO_TS = at('apps/web/src/editor/monaco.ts');

const BUCKETS = 6;

/** Pull `['#hex', …]` plus each entry's trailing `//` comment out of a `heat.ts` array literal. */
function readRamp(source, name) {
  const body = new RegExp(`export const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\];`).exec(source);
  if (!body) throw new Error(`${name} not found in heat.ts — the generator's source contract broke`);
  const out = [];
  for (const line of body[1].split('\n')) {
    const m = /'(#[0-9a-fA-F]{6})'\s*,\s*(?:\/\/\s*(.*?)\s*)?$/.exec(line.trim());
    if (m) out.push({ hex: m[1].toLowerCase(), note: m[2] ?? '' });
  }
  if (out.length !== BUCKETS) throw new Error(`${name} has ${out.length} entries, expected ${BUCKETS}`);
  return out;
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
const light = readRamp(heat, 'HEAT_LIGHT');
const dark = readRamp(heat, 'HEAT_DARK');

const targets = [
  { path: TOKENS_CSS, name: 'theme/tokens.css', render: cssLines },
  { path: MONACO_TS, name: 'editor/monaco.ts', render: monacoLines },
];

const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--print') ? 'print' : 'write';
let stale = 0;

for (const t of targets) {
  const before = readFileSync(t.path, 'utf8');
  const after = patchBlock(patchBlock(before, 'light', t.render(light)), 'dark', t.render(dark));
  if (mode === 'print') {
    process.stdout.write(`── ${t.name} ──\n${t.render(light).join('\n')}\n\n${t.render(dark).join('\n')}\n\n`);
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
