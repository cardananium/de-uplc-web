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
// Any of context/redeemer/datum/costModels present → "parts" mode (args applied to the script).
// The compressed `d` form carries the same fields as a JSON object {script, v?, context?, redeemer?,
// datum?, costModels?}; it lets a generator (e.g. cquisitor) hand off large scripts/contexts without
// bumping into URL length limits. Plain params and `d` are mutually exclusive (d wins if both present).

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

function parseCostModels(raw: string | null): number[] | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  try {
    const arr: unknown[] = t.startsWith('[') ? JSON.parse(t) : t.split(',');
    const nums = arr.map((x) => Number(typeof x === 'string' ? x.trim() : x)).filter((n) => Number.isFinite(n));
    return nums.length ? nums : undefined;
  } catch {
    return undefined;
  }
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
  if (context || redeemer || datum || cost_models) {
    return { kind: 'parts', parts: { script, language: version, context, redeemer, datum, cost_models } };
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
    const cm = Array.isArray(o.costModels)
      ? (o.costModels as unknown[]).map(Number).filter((n) => Number.isFinite(n))
      : Array.isArray(o.cost_models)
        ? (o.cost_models as unknown[]).map(Number).filter((n) => Number.isFinite(n))
        : undefined;
    return launchFromFields({
      script: str('script'),
      version: str('v') ?? str('version'),
      context: str('context'),
      redeemer: str('redeemer'),
      datum: str('datum'),
      cost_models: cm,
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
          };
  const d = toBase64Url(await gzip(JSON.stringify(o)));
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#d=${d}`;
}
