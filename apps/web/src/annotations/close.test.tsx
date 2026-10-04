import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NavEntry } from './AnnotationNavigator';
import type { HintCard as HintCardT } from './line-annotations';
import { useAnnotations } from './annotation-store';

// The navigator reads the settings store, which reads localStorage when its module loads.
let AnnotationNavigator: typeof import('./AnnotationNavigator').AnnotationNavigator;
let HintCard: typeof HintCardT;
beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  ({ AnnotationNavigator } = await import('./AnnotationNavigator'));
  ({ HintCard } = await import('./line-annotations'));
});
afterEach(() => { useAnnotations.getState().clearDecompiler(); });

type Props = { children?: ReactNode; [k: string]: unknown };

/** Every element in a rendered tree of host elements, depth first. */
function elements(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Props>(node)) return [];
  return [node, ...elements(node.props.children)];
}

const entry = (status: NavEntry['status']): NavEntry => ({
  title: 'Datum check', hint: 'why', severity: 'warning', status, where: status === 'found' ? 'Ln 3' : 'no such line',
});
const navigator = (entries: NavEntry[]) => renderToStaticMarkup(
  <AnnotationNavigator entries={entries} focus={0} onFocus={() => {}} onClose={() => {}} />,
);

describe('closing the annotations', () => {
  it('the card ✕ drops the whole annotation set', () => {
    useAnnotations.getState().setDecompiler({ items: [{ target: { kind: 'pseudo_line', line: 3 } }], focus: 0, ignoredOptions: [] });
    expect(useAnnotations.getState().decompiler).toBeDefined();
    const card = HintCard({
      severity: 'info', title: 't', hint: 'h', position: '1 / 1',
      onClose: () => useAnnotations.getState().clearDecompiler(),
    });
    const close = elements(card).find((e) => e.type === 'button');
    expect(close?.props['aria-label']).toBe('Close annotations');
    expect(close?.props.title).toBe('Close annotations');
    (close?.props.onClick as () => void)();
    // Bands, glyphs, the card, the navigator and the scrim are all drawn from this set.
    expect(useAnnotations.getState().decompiler).toBeUndefined();
  });

  it('a card without a close handler has no ✕', () => {
    expect(elements(HintCard({ severity: 'info', title: 't' })).some((e) => e.type === 'button')).toBe(false);
  });

  it('the navigator has no dismiss-all button', () => {
    const html = navigator([entry('found'), entry('missing')]);
    expect(html).not.toMatch(/dismiss/i);
    expect(html).not.toContain('codicon-close-all');
    expect(html).not.toContain('Close annotations'); // its card is in the editor
  });

  it('a focused annotation that is not in the editor shows its card with the ✕ under the bar', () => {
    for (const status of ['missing', 'stale'] as const) {
      const html = navigator([entry(status)]);
      expect(html).toContain('class="ann-card ann-warning"');
      expect(html).toContain('aria-label="Close annotations"');
    }
  });
});
