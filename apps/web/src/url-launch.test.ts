import { beforeEach, describe, expect, it } from 'vitest';
import { buildShareUrl, parseUrlLaunch, resolveUrlLaunch, type UrlLaunch } from './url-launch';

// The deep-link is an interop contract: cquisitor mints these URLs and this module is the only
// reader. The cases below are the ones a generator can get wrong — above all `exUnits`, which is
// the one field that cannot be recovered from anything else in the link (the redeemer's declared
// ExUnits live in the transaction's witness set, not in its Data argument).

/** A `URL` already exposes origin/pathname/search/hash — exactly what url-launch reads. */
function setUrl(href: string): void {
  (globalThis as unknown as { window: { location: URL } }).window = { location: new URL(href) };
}

const ORIGIN = 'https://example.test/app/';
const SCRIPT = '(program 1.1.0 (con integer 42))';
const CPU = 8177555;
const MEM = 25305;

/** Encode a launch, put the resulting `#d=` link in the address bar, and read it back. */
async function roundTrip(launch: UrlLaunch): Promise<UrlLaunch | null> {
  setUrl(ORIGIN);
  const url = await buildShareUrl(launch);
  expect(url.startsWith(`${ORIGIN}#d=`)).toBe(true);
  setUrl(url);
  return resolveUrlLaunch();
}

const partsOf = (l: UrlLaunch | null) => (l && l.kind === 'parts' ? l.parts : undefined);

beforeEach(() => setUrl(ORIGIN));

describe('exUnits — the declared limit a parts link carries', () => {
  it('survives a Share round-trip through the compressed #d= form', async () => {
    const parts = { script: SCRIPT, language: 'V3', redeemer: 'd87980', ex_units: [CPU, MEM] };
    const back = await roundTrip({ kind: 'parts', parts });
    expect(partsOf(back)).toEqual(parts);
  });

  it('is carried even when it is the ONLY arg — a bare program has nowhere to put it', async () => {
    const back = await roundTrip({ kind: 'parts', parts: { script: SCRIPT, language: 'V3', ex_units: [CPU, MEM] } });
    expect(back?.kind).toBe('parts');
    expect(partsOf(back)?.ex_units).toEqual([CPU, MEM]);
  });

  it('parses the plain `?exUnits=cpu,mem` form, cpu first', () => {
    setUrl(`${ORIGIN}?script=${encodeURIComponent(SCRIPT)}&exUnits=${CPU},${MEM}`);
    expect(partsOf(parseUrlLaunch())?.ex_units).toEqual([CPU, MEM]);
  });

  it('parses it from the hash too, alongside the other parts params', () => {
    setUrl(`${ORIGIN}#script=${encodeURIComponent(SCRIPT)}&redeemer=d87980&exUnits=${CPU},${MEM}`);
    const parts = partsOf(parseUrlLaunch());
    expect(parts?.redeemer).toBe('d87980');
    expect(parts?.ex_units).toEqual([CPU, MEM]);
  });

  it('accepts the JSON-array spelling, like costModels', () => {
    setUrl(`${ORIGIN}?script=x&exUnits=${encodeURIComponent(`[${CPU},${MEM}]`)}`);
    expect(partsOf(parseUrlLaunch())?.ex_units).toEqual([CPU, MEM]);
  });

  it('reads `exUnits` out of a hand-built #d= payload (the generator-side shape)', async () => {
    const json = JSON.stringify({ script: SCRIPT, v: 'V2', exUnits: [CPU, MEM] });
    const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const d = btoa(String.fromCharCode(...new Uint8Array(gz)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    setUrl(`${ORIGIN}#d=${d}`);
    const parts = partsOf(await resolveUrlLaunch());
    expect(parts?.language).toBe('V2');
    expect(parts?.ex_units).toEqual([CPU, MEM]);
  });
});

describe('a malformed exUnits is dropped, never guessed at', () => {
  // Every one of these still has to OPEN — losing the declared limit is the whole penalty.
  it.each([
    ['one number', `${CPU}`],
    ['three numbers', `${CPU},${MEM},1`],
    ['empty', ''],
    ['negative cpu', `-1,${MEM}`],
    ['negative mem', `${CPU},-${MEM}`],
    ['fractional', '1.5,2.5'],
    ['not numbers', 'lots,plenty'],
    ['a stray separator', `${CPU},`],
    // Arity has to be judged BEFORE junk is dropped, or a typo silently becomes a valid pair.
    ['a good pair with junk appended', `${CPU},${MEM},junk`],
    ['a good pair with junk prepended', `junk,${CPU},${MEM}`],
    ['a hole in the middle', `${CPU},,${MEM}`],
    ['a JSON array with junk', `[${CPU},${MEM},"x"]`],
    ['booleans', '[true,25305]'],
    ['nulls', '[null,25305]'],
  ])('%s', (_name, raw) => {
    setUrl(`${ORIGIN}?script=x&exUnits=${encodeURIComponent(raw)}`);
    const launch = parseUrlLaunch();
    expect(launch).not.toBeNull();
    expect(partsOf(launch)?.ex_units).toBeUndefined();
  });

  it.each([
    ['junk appended', [CPU, MEM, 'x']],
    ['booleans', [true, MEM]],
    ['nulls', [null, MEM]],
    ['one number', [CPU]],
  ])('the compressed #d= form rejects it too: %s', async (_name, exUnits) => {
    const json = JSON.stringify({ script: SCRIPT, v: 'V2', exUnits });
    const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const d = btoa(String.fromCharCode(...new Uint8Array(gz)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    setUrl(`${ORIGIN}#d=${d}`);
    const launch = await resolveUrlLaunch();
    expect(launch).not.toBeNull();
    expect(partsOf(launch)?.ex_units).toBeUndefined();
  });

  it('accepts the comma spelling inside #d= too — it still resolves to exactly two integers', async () => {
    const json = JSON.stringify({ script: SCRIPT, v: 'V2', exUnits: `${CPU},${MEM}` });
    const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const d = btoa(String.fromCharCode(...new Uint8Array(gz)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    setUrl(`${ORIGIN}#d=${d}`);
    expect(partsOf(await resolveUrlLaunch())?.ex_units).toEqual([CPU, MEM]);
  });

  it('leaves the other args alone when only exUnits is bad', () => {
    setUrl(`${ORIGIN}?script=x&redeemer=d87980&exUnits=nonsense`);
    const parts = partsOf(parseUrlLaunch());
    expect(parts?.redeemer).toBe('d87980');
    expect(parts?.ex_units).toBeUndefined();
  });
});

describe('purpose — the label a link can carry when the context cannot be read', () => {
  it('survives a Share round-trip through the compressed #d= form', async () => {
    const parts = { script: SCRIPT, language: 'V2', context: 'd87980', purpose: 'Spending #0' };
    const back = await roundTrip({ kind: 'parts', parts });
    expect(partsOf(back)).toEqual(parts);
  });

  it('parses the plain `?purpose=` form', () => {
    setUrl(`${ORIGIN}?script=${encodeURIComponent(SCRIPT)}&purpose=spend`);
    expect(partsOf(parseUrlLaunch())?.purpose).toBe('spend');
  });

  it('parses it from the hash, alongside the other parts params', () => {
    setUrl(`${ORIGIN}#script=${encodeURIComponent(SCRIPT)}&redeemer=d87980&purpose=${encodeURIComponent('Spending #0')}`);
    const parts = partsOf(parseUrlLaunch());
    expect(parts?.redeemer).toBe('d87980');
    expect(parts?.purpose).toBe('Spending #0');
  });

  // Same reasoning as exUnits: a bare program has nowhere to carry a label, so routing there would
  // drop the one field this link came for.
  it('is carried even when it is the ONLY arg', async () => {
    const back = await roundTrip({ kind: 'parts', parts: { script: SCRIPT, language: 'V3', purpose: 'mint' } });
    expect(back?.kind).toBe('parts');
    expect(partsOf(back)?.purpose).toBe('mint');
  });

  it('reads it out of a hand-built #d= payload (the generator-side shape)', async () => {
    const json = JSON.stringify({ script: SCRIPT, v: 'V2', context: 'd87980', purpose: 'Rewarding' });
    const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
    const d = btoa(String.fromCharCode(...new Uint8Array(gz)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    setUrl(`${ORIGIN}#d=${d}`);
    expect(partsOf(await resolveUrlLaunch())?.purpose).toBe('Rewarding');
  });

  // Blank must read as absent, not as "this session's purpose is the empty string" — the engine
  // would then have nothing to fall back to and the panel would print `—` for a context that names
  // one perfectly well.
  it.each([['empty', ''], ['whitespace', '   ']])('%s is dropped, and does not force parts mode', (_n, raw) => {
    setUrl(`${ORIGIN}?script=${encodeURIComponent(SCRIPT)}&purpose=${encodeURIComponent(raw)}`);
    expect(parseUrlLaunch()).toEqual({ kind: 'program', script: SCRIPT, version: 'V3' });
  });

  it('is trimmed, so a stray space in a generated link does not become part of the label', () => {
    setUrl(`${ORIGIN}?script=x&purpose=${encodeURIComponent('  Spending  ')}`);
    expect(partsOf(parseUrlLaunch())?.purpose).toBe('Spending');
  });
});

describe('links minted before exUnits existed', () => {
  it('a script-only link is still a bare program launch', () => {
    setUrl(`${ORIGIN}?script=${encodeURIComponent(SCRIPT)}&v=v2`);
    expect(parseUrlLaunch()).toEqual({ kind: 'program', script: SCRIPT, version: 'v2' });
  });

  it('a parts link without exUnits round-trips unchanged, with no exUnits added', async () => {
    const parts = { script: SCRIPT, language: 'V3', context: 'd87980', cost_models: [1, 2, 3] };
    const back = await roundTrip({ kind: 'parts', parts });
    expect(partsOf(back)).toEqual(parts);
    expect(partsOf(back)?.ex_units).toBeUndefined();
  });

  it('a program launch has no parts fields at all', async () => {
    const back = await roundTrip({ kind: 'program', script: SCRIPT, version: 'V3' });
    expect(back).toEqual({ kind: 'program', script: SCRIPT, version: 'V3' });
  });
});
