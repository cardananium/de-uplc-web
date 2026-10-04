// Dragging the hint card by its head: the card stays a content widget anchored under its target
// and the drag is a translate offset on top of Monaco's placement, so the card keeps following its
// line when the editor scrolls. Geometry and state only — `useLineAnnotations` wires the pointer
// events and applies the offset.
import type { Rect } from './spotlight';

export interface Offset {
  x: number;
  y: number;
}

export const NO_OFFSET: Offset = { x: 0, y: 0 };

/**
 * The offset that keeps a card inside `bounds`: `card` is the card's rect at Monaco's placement
 * (no offset). A card larger than the bounds on an axis keeps its left / top edge inside.
 */
export function clampOffset(offset: Offset, card: Rect, bounds: Rect): Offset {
  const axis = (d: number, start: number, size: number, bStart: number, bSize: number) => {
    const max = bStart + bSize - size - start;
    const min = bStart - start;
    return Math.max(min, Math.min(d, Math.max(min, max)));
  };
  return {
    x: axis(offset.x, card.x, card.w, bounds.x, bounds.w),
    y: axis(offset.y, card.y, card.h, bounds.y, bounds.h),
  };
}

/** A drag starts on the card head, not on its buttons. */
export function startsDrag(target: { closest: (selector: string) => unknown } | null): boolean {
  return !!target && !target.closest('button');
}

/**
 * The card's offset and the drag in progress. `reset(key)` drops the offset, and any drag with
 * it, whenever the key differs from the last one (another focus move, another text).
 */
export class CardDrag {
  private key: readonly unknown[] = [];
  private drag?: { from: Offset; pointer: Offset; card: Rect; bounds: Rect };
  offset: Offset = NO_OFFSET;

  get dragging(): boolean {
    return !!this.drag;
  }

  /** `card` is the card's rect as shown, offset included; `bounds` the editor's visible area. */
  start(pointer: Offset, card: Rect, bounds: Rect): void {
    const base = { ...card, x: card.x - this.offset.x, y: card.y - this.offset.y };
    this.drag = { from: this.offset, pointer, card: base, bounds };
  }

  /** The offset for the pointer's new position, clamped; unchanged when no drag is in progress. */
  move(pointer: Offset): Offset {
    const d = this.drag;
    if (!d) return this.offset;
    const raw = { x: d.from.x + pointer.x - d.pointer.x, y: d.from.y + pointer.y - d.pointer.y };
    this.offset = clampOffset(raw, d.card, d.bounds);
    return this.offset;
  }

  end(): void {
    this.drag = undefined;
  }

  /** True when the offset was dropped. Keys compare element by element. */
  reset(key: readonly unknown[]): boolean {
    if (key.length === this.key.length && key.every((k, i) => Object.is(k, this.key[i]))) return false;
    this.key = key;
    this.drag = undefined;
    const moved = this.offset.x !== 0 || this.offset.y !== 0;
    this.offset = NO_OFFSET;
    return moved;
  }
}

/** The CSS transform for an offset; empty when there is none. */
export function offsetTransform(o: Offset): string {
  return o.x || o.y ? `translate(${Math.round(o.x)}px, ${Math.round(o.y)}px)` : '';
}
