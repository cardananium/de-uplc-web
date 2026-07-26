import type { ProgramParts } from './store';

// Debug deep-link: open the debugger straight from a URL. Three shapes —
//   ?script=<hex|uplc>&v=v3                                   → a clean (bare) program
//   ?script=<hex>&context=<cbor|json>&redeemer=<cbor>&v=v2 …  → script + manual Data args (parts)
//   #d=<base64url(gzip(json))>                                → the same fields, compressed (large links)
// Params (query string OR hash, e.g. https://…/#script=…&redeemer=…):
//   script      (required) compiled bytecode hex OR UPLC text
//   v|version   "v1"|"v2"|"v3" (default v3)
//   context     script context — PlutusData CBOR hex OR a named ScriptContext JSON (leading `{`)
//   redeemer    redeemer PlutusData CBOR hex
//   datum       datum PlutusData CBOR hex (optional; V1/V2 spend)
//   costModels  cost-model params for the version — comma-separated ints or a JSON array (optional)
//   exUnits     the redeemer's DECLARED ExUnits as `cpu,mem` (optional) — e.g. `exUnits=8177555,25305`
//   purpose     what the script is run for, free-form and short (optional) — e.g. `purpose=spend`
// Any of context/redeemer/datum/costModels/exUnits/purpose present → "parts" mode (args applied to
// the script).
// The compressed `d` form carries the same fields as a JSON object {script, v?, context?, redeemer?,
// datum?, costModels?, exUnits?, purpose?}; it lets a generator (e.g. cquisitor) hand off large
// scripts/contexts without bumping into URL length limits. Plain params and `d` are mutually
// exclusive (d wins if both present).
//
// `exUnits` exists because it is the one thing the link cannot reconstruct: the redeemer's Data
// argument is carried above, but the units its witness declared live in the transaction. Without
// them the session has no denominator and everything measured "of the limit" reads `—`; with a
// wrong-looking pair we drop it rather than open with a made-up one. Absent → exactly the old
// behaviour, so links minted before this param keep working.
//
// `purpose`, in contrast, is normally REDUNDANT: the ScriptPurpose sits inside `context` and the
// engine derives it from there. It is here for the links that cannot be derived from — no context,
// or a context that is valid PlutusData but not a ScriptContext — and it overrides the derived
// value when both are present, because its generator knew the redeemer and we are inferring.

export type UrlLaunch =
  | { kind: 'program'; script: string; version: string }
  | { kind: 'parts'; parts: ProgramParts }
  // A full transaction (the raw content the user loaded: CBOR hex or {transaction,utxos} JSON),
  // optionally reopened on a specific redeemer. Only the compressed `#d=` form carries this — a tx
  // is too large for plain query params.
  | { kind: 'transaction'; tx: string; redeemer?: string };

/** Normalized launch fields, the common shape behind both the plain-param and compressed paths. */
interface LaunchFields {
  script?: string | null;
  version?: string | null;
  context?: string | null;
  redeemer?: string | null;
  datum?: string | null;
  cost_models?: number[];
  /** `[cpu, mem]`, already validated by `parseExUnits` — never a raw list. */
  ex_units?: number[];
  purpose?: string | null;
}

function readParams(): URLSearchParams {
  // hash form: "#…?a=b" or "#a=b" (strip the leading # and optional "/")
  const hash = window.location.hash.replace(/^#\/?/, '');
  const hq = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash;
  const params = new URLSearchParams(hq);
  // The deep-link is typically hash-only (cquisitor emits #d=… / #script=…) — prefer the hash, then
  // fill any missing keys from the query string (so plain ?script=… links still work).
  for (const [k, v] of new URLSearchParams(window.location.search)) {
    if (!params.has(k)) params.set(k, v);
  }
  return params;
}

/** A flat int list, written either `1,2,3` or as a JSON array. Non-numbers are dropped. */
function parseCostModels(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  try {
    const arr: unknown[] = t.startsWith('[') ? JSON.parse(t) : t.split(',');
    const nums = arr.map(Number).filter((n) => Number.isFinite(n));
    return nums.length ? nums : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The declared ExUnits, or undefined. Exactly two non-negative integers, cpu first — anything else
 * is dropped, because "we don't know the limit" is the truthful reading of a malformed pair and the
 * link still has to open. The engine re-checks this (it also accepts links we never minted).
 *
 * Arity is checked on the RAW elements, before anything is coerced or dropped: filtering first would
 * turn `8177555,25305,junk` into a perfectly good-looking pair and invent a limit out of a typo.
 * For the same reason only real numbers and numeric strings count — `Number(true)` is 1 and
 * `Number(null)` is 0, and neither is a budget anyone declared.
 *
 * Both spellings are accepted in both forms: the documented shape is `exUnits=cpu,mem` in a query
 * and `"exUnits": [cpu, mem]` in the compressed payload, but a generator that puts the comma
 * string in the JSON loses nothing — it still has to resolve to exactly two integers.
 */
function parseExUnits(raw: unknown): number[] | undefined {
  let arr: unknown[];
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return undefined;
    try {
      arr = t.startsWith('[') ? (JSON.parse(t) as unknown[]) : t.split(',');
    } catch {
      return undefined;
    }
  } else if (Array.isArray(raw)) {
    arr = raw;
  } else {
    return undefined;
  }
  if (!Array.isArray(arr) || arr.length !== 2) return undefined;
  const nums = arr.map((x) => {
    if (typeof x === 'number') return x;
    if (typeof x === 'string' && x.trim() !== '') return Number(x.trim());
    return NaN;
  });
  return nums.every((n) => Number.isInteger(n) && n >= 0) ? nums : undefined;
}

/** Turn normalized fields into a launch (parts vs program). Returns null when there's no `script`. */
function launchFromFields(f: LaunchFields): UrlLaunch | null {
  const script = f.script || undefined;
  if (!script) return null;
  const version = f.version || 'V3';
  const context = f.context || undefined;
  const redeemer = f.redeemer || undefined;
  const datum = f.datum || undefined;
  const cost_models = f.cost_models?.length ? f.cost_models : undefined;
  const ex_units = parseExUnits(f.ex_units);
  // Trimmed, and blank counts as absent: `?purpose=` must not read as "this session has a purpose
  // and it is the empty string", which would suppress the value derived from the context.
  const purpose = f.purpose?.trim() || undefined;
  // `exUnits` or `purpose` alone is enough to make this a parts launch: a bare program has nowhere
  // to carry either, so routing it there would silently drop the field the link came for.
  if (context || redeemer || datum || cost_models || ex_units || purpose) {
    return { kind: 'parts', parts: { script, language: version, context, redeemer, datum, cost_models, ex_units, purpose } };
  }
  return { kind: 'program', script, version };
}

/** Parse a plain-param debug deep-link (query or hash). Returns null when there's no `script`. */
export function parseUrlLaunch(): UrlLaunch | null {
  const p = readParams();
  return launchFromFields({
    script: p.get('script'),
    version: p.get('v') || p.get('version'),
    context: p.get('context') || p.get('ctx'),
    redeemer: p.get('redeemer'),
    datum: p.get('datum'),
    cost_models: parseCostModels(p.get('costModels') || p.get('cost_models')),
    ex_units: parseExUnits(p.get('exUnits') ?? p.get('ex_units')),
    purpose: p.get('purpose'),
  });
}

function fromBase64Url(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(buf);
}

/** The compressed `d` param (query or hash), or null. */
export function readCompressedLaunchParam(): string | null {
  return readParams().get('d');
}

/** Decode a compressed `d` launch (base64url(gzip(json fields))). Returns null on any failure. */
export async function decodeCompressedLaunch(d: string): Promise<UrlLaunch | null> {
  try {
    const json = await gunzip(fromBase64Url(d.trim()));
    const o = JSON.parse(json) as Record<string, unknown>;
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
    // Full-transaction launch (mutually exclusive with the script forms).
    const tx = str('tx');
    if (tx) return { kind: 'transaction', tx, redeemer: str('redeemer') };
    const ints = (k: string) =>
      Array.isArray(o[k]) ? (o[k] as unknown[]).map(Number).filter((n) => Number.isFinite(n)) : undefined;
    return launchFromFields({
      script: str('script'),
      version: str('v') ?? str('version'),
      context: str('context'),
      redeemer: str('redeemer'),
      datum: str('datum'),
      cost_models: ints('costModels') ?? ints('cost_models'),
      ex_units: parseExUnits(o.exUnits ?? o.ex_units),
      purpose: str('purpose'),
    });
  } catch {
    return null;
  }
}

/** Resolve a launch from the URL, preferring the compressed `d` form when present. */
export async function resolveUrlLaunch(): Promise<UrlLaunch | null> {
  const d = readCompressedLaunchParam();
  if (d) return decodeCompressedLaunch(d);
  return parseUrlLaunch();
}

// ── encode (share links) — the inverse of decodeCompressedLaunch ──

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Build a shareable deep-link for a program / script+parts launch, using the compressed `#d=` form
 * (base64url(gzip(json))) so even large scripts/contexts/transactions fit. Decoded by
 * `decodeCompressedLaunch`.
 */
export async function buildShareUrl(launch: UrlLaunch): Promise<string> {
  const o: Record<string, unknown> =
    launch.kind === 'program'
      ? { script: launch.script, v: launch.version }
      : launch.kind === 'transaction'
        ? { tx: launch.tx, ...(launch.redeemer ? { redeemer: launch.redeemer } : {}) }
        : {
            script: launch.parts.script,
            v: launch.parts.language,
            ...(launch.parts.context ? { context: launch.parts.context } : {}),
            ...(launch.parts.redeemer ? { redeemer: launch.parts.redeemer } : {}),
            ...(launch.parts.datum ? { datum: launch.parts.datum } : {}),
            ...(launch.parts.cost_models?.length ? { costModels: launch.parts.cost_models } : {}),
            ...(launch.parts.ex_units?.length ? { exUnits: launch.parts.ex_units } : {}),
            ...(launch.parts.purpose ? { purpose: launch.parts.purpose } : {}),
          };
  const d = toBase64Url(await gzip(JSON.stringify(o)));
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#d=${d}`;
}
