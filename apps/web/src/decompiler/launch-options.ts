import { setAtPath, type OptionCatalogue, type OptionDescriptor, type OptionsObject } from './catalogue';

/**
 * Lay a link's decompiler `options` object over `base`, through the catalogue only: a value lands
 * when its path is a catalogue option and the value fits that option's kind (a boolean for a
 * toggle; one of the choice values, `null` where the choice has an unset state, or the
 * `{ <count key>: n }` object of a counted choice). Every other key — unknown to this build, or of
 * the wrong type — is left out and reported by its dotted path.
 */
export function mergeLaunchOptions(
  catalogue: OptionCatalogue,
  base: OptionsObject,
  linkOptions: unknown,
): { options: OptionsObject; ignored: string[] } {
  const ignored: string[] = [];
  if (linkOptions == null || typeof linkOptions !== 'object' || Array.isArray(linkOptions)) {
    return { options: base, ignored: linkOptions == null ? [] : ['options'] };
  }
  const byPath = new Map<string, OptionDescriptor>();
  const prefixes = new Set<string>();
  for (const g of catalogue.groups) {
    for (const o of g.options) {
      byPath.set(o.path.join('.'), o);
      for (let i = 1; i < o.path.length; i++) prefixes.add(o.path.slice(0, i).join('.'));
    }
  }
  let options = base;
  const walk = (obj: Record<string, unknown>, path: string[]) => {
    for (const [k, v] of Object.entries(obj)) {
      const p = [...path, k];
      const key = p.join('.');
      const desc = byPath.get(key);
      if (desc) {
        if (fits(desc, v)) options = setAtPath(options, p, v);
        else ignored.push(key);
      } else if (prefixes.has(key) && v != null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v as Record<string, unknown>, p);
      } else {
        ignored.push(key);
      }
    }
  };
  walk(linkOptions as Record<string, unknown>, []);
  return { options, ignored };
}

function fits(desc: OptionDescriptor, v: unknown): boolean {
  const kind = desc.kind;
  if (kind.type === 'toggle') return typeof v === 'boolean';
  if (v === null) return kind.unset !== null;
  if (typeof v === 'string') return kind.choices.some((c) => c.value === v && c.payload == null);
  if (typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length !== 1) return false;
    const [key, n] = entries[0];
    return kind.choices.some(
      (c) => c.payload != null && c.payload.key === key && Number.isInteger(n) && (n as number) >= c.payload.min,
    );
  }
  return false;
}
