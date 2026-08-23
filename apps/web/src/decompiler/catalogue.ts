/* ------------------------------------------------------------------ *
 * The option catalogue — same wire as dehosk-web `GET /api/options`.
 *
 * Every option is declared once, in the Rust crate. Nothing here may
 * name an option field, restate a default, or enumerate a choice value.
 * ------------------------------------------------------------------ */

export interface ChoicePayload {
  type: 'count';
  key: string;
  min: number;
  default: number;
}

export interface OptionChoice {
  value: string;
  label: string;
  summary: string;
  payload?: ChoicePayload | null;
}

export type OptionKind =
  | { type: 'toggle' }
  | { type: 'choice'; unset: string | null; choices: OptionChoice[] };

export interface OptionDescriptor {
  path: string[];
  field: string;
  label: string;
  summary: string;
  detail: string[];
  cliFlag?: string | null;
  kind: OptionKind;
}

export interface OptionGroup {
  id: string;
  title: string;
  summary: string;
  detail: string[];
  masterPath: string[] | null;
  options: OptionDescriptor[];
}

export interface OptionCatalogue {
  version: number;
  groups: OptionGroup[];
  defaults: OptionsObject;
}

/** Opaque bag: the panel reaches into it only through catalogue `path`s. */
export type OptionsObject = Record<string, unknown>;

export function assertCatalogue(json: unknown): asserts json is OptionCatalogue {
  const bad = (why: string): never => {
    throw new Error(`Malformed options catalogue: ${why}`);
  };
  if (json == null || typeof json !== 'object') bad('response is not an object');
  const cat = json as Record<string, unknown>;
  if (!Array.isArray(cat.groups)) bad('`groups` is missing or not an array');
  if (cat.defaults == null || typeof cat.defaults !== 'object') {
    bad('`defaults` is missing or not an object');
  }
  for (const [i, g] of (cat.groups as unknown[]).entries()) {
    if (g == null || typeof g !== 'object') bad(`group ${i} is not an object`);
    const group = g as Record<string, unknown>;
    if (!Array.isArray(group.options)) {
      bad(`group ${i} has no \`options\` array`);
    }
    for (const [j, o] of (group.options as unknown[]).entries()) {
      if (o == null || typeof o !== 'object') bad(`group ${i} option ${j} is not an object`);
      const desc = o as Record<string, unknown>;
      if (!Array.isArray(desc.path)) bad(`group ${i} option ${j} has no \`path\` array`);
      const kind = desc.kind as Record<string, unknown> | null | undefined;
      if (kind == null || typeof kind !== 'object' || typeof kind.type !== 'string') {
        bad(`group ${i} option ${j} has no \`kind.type\``);
      }
    }
  }
}

export function getAtPath(obj: OptionsObject, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export function setAtPath(obj: OptionsObject, path: string[], value: unknown): OptionsObject {
  if (path.length === 0) return obj;
  const [head, ...rest] = path;
  const child = obj[head];
  return {
    ...obj,
    [head]:
      rest.length === 0
        ? value
        : setAtPath(
            (child != null && typeof child === 'object' ? child : {}) as OptionsObject,
            rest,
            value,
          ),
  };
}
