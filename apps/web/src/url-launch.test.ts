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

describe('decompiler deep-link', () => {
  const HEX = '46010000200101';

  it('opens from #decompile=<hex>', () => {
    setUrl(`${ORIGIN}#decompile=${HEX}`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX });
  });

  it('opens from ?decompile=<hex>', () => {
    setUrl(`${ORIGIN}?decompile=${HEX}`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX });
  });

  it('opens from #view=decompiler&script=<hex> without stealing a debugger script= link', () => {
    setUrl(`${ORIGIN}#view=decompiler&script=${HEX}`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX });
    setUrl(`${ORIGIN}#script=${HEX}`);
    expect(parseUrlLaunch()).toEqual({ kind: 'program', script: HEX, version: 'V3' });
  });

  it('strips whitespace in the hex', () => {
    setUrl(`${ORIGIN}#decompile=${encodeURIComponent('46 01\n0000200101')}`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX });
  });

  it('round-trips a short script through #decompile=', async () => {
    setUrl(ORIGIN);
    const url = await buildShareUrl({ kind: 'decompile', script: HEX });
    expect(url).toBe(`${ORIGIN}#decompile=${HEX}`);
    setUrl(url);
    expect(await resolveUrlLaunch()).toEqual({ kind: 'decompile', script: HEX });
  });

  it('round-trips a large script through compressed #d=', async () => {
    const big = 'aa'.repeat(1200);
    setUrl(ORIGIN);
    const url = await buildShareUrl({ kind: 'decompile', script: big });
    expect(url.includes('#d=')).toBe(true);
    setUrl(url);
    expect(await resolveUrlLaunch()).toEqual({ kind: 'decompile', script: big });
  });

  it('carries v and purpose on the short #decompile= form', async () => {
    setUrl(`${ORIGIN}#decompile=${HEX}&v=v2&purpose=spend`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX, version: 'PlutusV2', purpose: 'Spend' });
    setUrl(ORIGIN);
    const url = await buildShareUrl({ kind: 'decompile', script: HEX, version: 'PlutusV2', purpose: 'Spend' });
    expect(url).toBe(`${ORIGIN}#decompile=${HEX}&v=v2&purpose=spend`);
    setUrl(url);
    expect(await resolveUrlLaunch()).toEqual({ kind: 'decompile', script: HEX, version: 'PlutusV2', purpose: 'Spend' });
  });

  it('accepts view=decompiler with v= and purpose=', () => {
    setUrl(`${ORIGIN}#view=decompiler&script=${HEX}&v=v3&purpose=mint`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX, version: 'PlutusV3', purpose: 'Mint' });
  });

  it('uses certificate for the crate Certificate purpose; publish is not a token', async () => {
    setUrl(`${ORIGIN}#decompile=${HEX}&purpose=certificate`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX, purpose: 'Certificate' });
    setUrl(`${ORIGIN}#decompile=${HEX}&purpose=publish`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX });
    setUrl(ORIGIN);
    const url = await buildShareUrl({ kind: 'decompile', script: HEX, purpose: 'Certificate' });
    expect(url).toBe(`${ORIGIN}#decompile=${HEX}&purpose=certificate`);
    setUrl(url);
    expect(await resolveUrlLaunch()).toEqual({ kind: 'decompile', script: HEX, purpose: 'Certificate' });
  });

  it('drops an unknown version / purpose rather than inventing one', () => {
    setUrl(`${ORIGIN}#decompile=${HEX}&v=v9&purpose=whatever`);
    expect(parseUrlLaunch()).toEqual({ kind: 'decompile', script: HEX });
  });

  it('round-trips v and purpose through compressed #d=', async () => {
    const big = 'aa'.repeat(1200);
    setUrl(ORIGIN);
    const url = await buildShareUrl({ kind: 'decompile', script: big, version: 'PlutusV1', purpose: 'Withdraw' });
    expect(url.includes('#d=')).toBe(true);
    setUrl(url);
    expect(await resolveUrlLaunch()).toEqual({
      kind: 'decompile', script: big, version: 'PlutusV1', purpose: 'Withdraw',
    });
  });
});

/** gzip + base64url a raw payload into a `#d=` link, exactly as a producer would. */
async function linkFor(payload: unknown): Promise<string> {
  const gz = await new Response(new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const d = btoa(String.fromCharCode(...new Uint8Array(gz))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${ORIGIN}#d=${d}`;
}

describe('annotations on a #d= link (ann / ann_focus / options)', () => {
  it('reads valid debugger annotations and the focus', async () => {
    setUrl(await linkFor({
      script: SCRIPT, v: 'V3',
      ann: [
        { target: { kind: 'term', term_id: 3 }, label: 'Fails here', hint: 'line one\nline two', severity: 'error' },
        { target: { kind: 'uplc_line', line: 12 } },
      ],
      ann_focus: 1,
    }));
    expect(await resolveUrlLaunch()).toEqual({
      kind: 'program', script: SCRIPT, version: 'V3',
      annotations: {
        items: [
          { target: { kind: 'term', term_id: 3 }, label: 'Fails here', hint: 'line one\nline two', severity: 'error' },
          { target: { kind: 'uplc_line', line: 12 } },
        ],
        focus: 1,
      },
    });
  });

  it('drops malformed / mistyped entries and unknown kinds, strips extra target fields', async () => {
    setUrl(await linkFor({
      script: SCRIPT,
      ann: [
        'nope',
        { target: { kind: 'term', term_id: -1 } },
        { target: { kind: 'term', term_id: 1.5 } },
        { target: { kind: 'term', term_id: 2 ** 53 } },
        { target: { kind: 'uplc_line', line: 0 } },
        { target: { kind: 'cbor_span', offset: 0, length: 2 } },
        { target: { kind: 'future_kind' } },
        { label: 'no target' },
        { target: { kind: 'term', term_id: 7 }, severity: 'fatal' },
        { target: { kind: 'term', term_id: 7 }, label: 42 },
        { target: { kind: 'term', term_id: 7 }, hint: null },
        { target: { kind: 'pseudo_line', line: 4, end_line: 2 } },
        { target: { kind: 'pseudo_line', line: 4, end_line: 'x' } },
        { target: { kind: 'term', term_id: 7, extra: true }, label: '', hint: '', extra: 1 },
        { target: { kind: 'pseudo_line', line: 4, end_line: 4 }, severity: 'warning' },
      ],
    }));
    const l = await resolveUrlLaunch();
    expect(l?.kind).toBe('program');
    expect(l?.annotations).toEqual({
      items: [
        { target: { kind: 'term', term_id: 7 } },
        { target: { kind: 'pseudo_line', line: 4, end_line: 4 }, severity: 'warning' },
      ],
      focus: 0,
    });
  });

  it('remaps ann_focus onto the kept entries', async () => {
    const ok = (id: number) => ({ target: { kind: 'term', term_id: id } });
    const focusOf = async (ann: unknown[], ann_focus: unknown) => {
      setUrl(await linkFor({ script: SCRIPT, ann, ann_focus }));
      return (await resolveUrlLaunch())?.annotations?.focus;
    };
    // The focused entry kept: its position among the kept ones.
    expect(await focusOf(['bad', ok(1), ok(2)], 2)).toBe(1);
    // The focused entry dropped: the next kept one…
    expect(await focusOf([ok(0), 'bad', ok(2)], 1)).toBe(1);
    // …or the last kept one when nothing follows.
    expect(await focusOf([ok(0), ok(1), 'bad'], 2)).toBe(1);
    // Past the end clamps to the last entry; a non-index focus is 0.
    expect(await focusOf([ok(0), ok(1)], 99)).toBe(1);
    expect(await focusOf([ok(0), ok(1)], -1)).toBe(0);
    expect(await focusOf([ok(0), ok(1)], 1.5)).toBe(0);
    expect(await focusOf([ok(0), ok(1)], '1')).toBe(0);
  });

  it('truncates without splitting a surrogate pair', async () => {
    setUrl(await linkFor({ script: SCRIPT, ann: [{ target: { kind: 'term', term_id: 0 }, label: 'a'.repeat(79) + '😀' }] }));
    expect((await resolveUrlLaunch())?.annotations?.items[0].label).toBe('a'.repeat(79));
  });

  it('caps at 64 entries, 80-char labels and 2000-char hints', async () => {
    const ann = Array.from({ length: 70 }, (_, i) => ({
      target: { kind: 'term', term_id: i }, label: 'L'.repeat(100), hint: 'H'.repeat(2500),
    }));
    setUrl(await linkFor({ script: SCRIPT, ann }));
    const items = (await resolveUrlLaunch())?.annotations?.items ?? [];
    expect(items).toHaveLength(64);
    expect(items[63].target).toEqual({ kind: 'term', term_id: 63 });
    expect(items[0].label).toHaveLength(80);
    expect(items[0].hint).toHaveLength(2000);
  });

  it('opens unchanged when ann is not an array or holds nothing valid', async () => {
    setUrl(await linkFor({ script: SCRIPT, ann: { target: { kind: 'term', term_id: 1 } } }));
    expect(await resolveUrlLaunch()).toEqual({ kind: 'program', script: SCRIPT, version: 'V3' });
    setUrl(await linkFor({ script: SCRIPT, ann: [null, 1, []] }));
    expect(await resolveUrlLaunch()).toEqual({ kind: 'program', script: SCRIPT, version: 'V3' });
  });

  it('carries annotations on a transaction launch', async () => {
    setUrl(await linkFor({ tx: '84a4', redeemer: 'spend:0', ann: [{ target: { kind: 'term', term_id: 2 }, severity: 'warning' }] }));
    expect(await resolveUrlLaunch()).toEqual({
      kind: 'transaction', tx: '84a4', redeemer: 'spend:0',
      annotations: { items: [{ target: { kind: 'term', term_id: 2 }, severity: 'warning' }], focus: 0 },
    });
  });

  it('reads a decompiler payload with options and pseudo_line annotations', async () => {
    setUrl(await linkFor({
      view: 'decompiler', script: '4601', v: 'v3',
      options: { output_layer: 'Decompiled', simplify_passes: { inline_fp: false } },
      ann: [{ target: { kind: 'pseudo_line', line: 3, end_line: 5 }, label: 'Spend branch' }],
    }));
    expect(await resolveUrlLaunch()).toEqual({
      kind: 'decompile', script: '4601', version: 'PlutusV3',
      options: { output_layer: 'Decompiled', simplify_passes: { inline_fp: false } },
      annotations: { items: [{ target: { kind: 'pseudo_line', line: 3, end_line: 5 }, label: 'Spend branch' }], focus: 0 },
    });
  });

  it('ignores a non-object options field', async () => {
    setUrl(await linkFor({ view: 'decompiler', script: '4601', options: [1, 2] }));
    expect(await resolveUrlLaunch()).toEqual({ kind: 'decompile', script: '4601' });
  });

  it('round-trips annotations through buildShareUrl, forcing #d= for a short decompile link', async () => {
    const annotations = {
      items: [{ target: { kind: 'pseudo_line' as const, line: 2 }, severity: 'error' as const, label: 'x' }],
      focus: 0,
    };
    const launch: UrlLaunch = { kind: 'decompile', script: '4601', options: { safe_mode: true }, annotations };
    setUrl(ORIGIN);
    const url = await buildShareUrl(launch);
    expect(url.startsWith(`${ORIGIN}#d=`)).toBe(true);
    setUrl(url);
    expect(await resolveUrlLaunch()).toEqual(launch);

    const prog: UrlLaunch = {
      kind: 'program', script: SCRIPT, version: 'V3',
      annotations: { items: [{ target: { kind: 'term', term_id: 1 } }, { target: { kind: 'uplc_line', line: 3 }, severity: 'warning' }], focus: 1 },
    };
    expect(await roundTrip(prog)).toEqual(prog);
  });
});
