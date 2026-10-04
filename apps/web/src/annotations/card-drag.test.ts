import { describe, expect, it } from 'vitest';
import { CardDrag, clampOffset, offsetTransform, startsDrag } from './card-drag';

// An editor at (100, 50), 600×400 px, and a 200×80 px card placed at (150, 120) by Monaco.
const bounds = { x: 100, y: 50, w: 600, h: 400 };
const card = { x: 150, y: 120, w: 200, h: 80 };

describe('clampOffset', () => {
  it('keeps an offset that leaves the card inside the editor', () => {
    expect(clampOffset({ x: 100, y: -30 }, card, bounds)).toEqual({ x: 100, y: -30 });
  });

  it('stops the card at every edge of the editor', () => {
    expect(clampOffset({ x: -500, y: -500 }, card, bounds)).toEqual({ x: -50, y: -70 });
    expect(clampOffset({ x: 900, y: 900 }, card, bounds)).toEqual({ x: 350, y: 250 });
  });

  it('keeps the left / top edge of a card larger than the editor inside it', () => {
    const big = { x: 150, y: 120, w: 800, h: 500 };
    expect(clampOffset({ x: 300, y: 300 }, big, bounds)).toEqual({ x: -50, y: -70 });
    expect(clampOffset({ x: -300, y: -300 }, big, bounds)).toEqual({ x: -50, y: -70 });
  });
});

describe('CardDrag', () => {
  it('moves the card with the pointer, clamped to the editor', () => {
    const d = new CardDrag();
    d.reset([1]);
    d.start({ x: 200, y: 130 }, card, bounds);
    expect(d.dragging).toBe(true);
    expect(d.move({ x: 260, y: 170 })).toEqual({ x: 60, y: 40 });
    expect(d.move({ x: 2000, y: 2000 })).toEqual({ x: 350, y: 250 });
    d.end();
    expect(d.dragging).toBe(false);
    expect(d.move({ x: 0, y: 0 })).toEqual({ x: 350, y: 250 }); // no drag: nothing moves
  });

  it('continues a second drag from where the first one left the card', () => {
    const d = new CardDrag();
    d.start({ x: 200, y: 130 }, card, bounds);
    d.move({ x: 250, y: 130 });
    d.end();
    // The card as shown now sits 50 px to the right of Monaco's placement.
    d.start({ x: 300, y: 140 }, { ...card, x: card.x + 50 }, bounds);
    expect(d.move({ x: 310, y: 150 })).toEqual({ x: 60, y: 10 });
    // Clamped against Monaco's placement, not against the moved card.
    expect(d.move({ x: -1000, y: 140 })).toEqual({ x: -50, y: 0 });
  });

  it('puts the card back on a focus move or a new text, and only then', () => {
    const d = new CardDrag();
    expect(d.reset([1, 0, 'text'])).toBe(false);
    d.start({ x: 0, y: 0 }, card, bounds);
    d.move({ x: 40, y: 20 });
    expect(d.reset([1, 0, 'text'])).toBe(false); // a re-render with the same focus and text
    expect(d.offset).toEqual({ x: 40, y: 20 });
    expect(d.dragging).toBe(true);
    expect(d.reset([2, 1, 'text'])).toBe(true); // next annotation
    expect(d.offset).toEqual({ x: 0, y: 0 });
    expect(d.dragging).toBe(false);

    d.start({ x: 0, y: 0 }, card, bounds);
    d.move({ x: 10, y: 10 });
    d.end();
    expect(d.reset([3, 1, 'text'])).toBe(true); // the same annotation focused again
    d.start({ x: 0, y: 0 }, card, bounds);
    d.move({ x: 10, y: 10 });
    d.end();
    expect(d.reset([3, 1, 'other text'])).toBe(true); // another decompile / term view
    expect(d.offset).toEqual({ x: 0, y: 0 });
    expect(d.reset([4, 1, 'other text'])).toBe(false); // nothing to put back
  });
});

describe('drag handle', () => {
  const at = (inButton: boolean) => ({ closest: (sel: string) => (sel === 'button' && inButton ? {} : null) });

  it('starts on the head, never on its buttons', () => {
    expect(startsDrag(at(false))).toBe(true);
    expect(startsDrag(at(true))).toBe(false);
    expect(startsDrag(null)).toBe(false);
  });

  it('maps an offset to a transform, none for no offset', () => {
    expect(offsetTransform({ x: 0, y: 0 })).toBe('');
    expect(offsetTransform({ x: 12.4, y: -7.6 })).toBe('translate(12px, -8px)');
  });
});
