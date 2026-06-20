import { useEffect, useState } from 'react';

/**
 * A number input that can actually be CLEARED. A plain controlled `value={n}` with
 * `Number(e.target.value) || fallback` snaps an empty field back to a number, so you can never
 * erase it. Here a local string mirrors the field (empty allowed mid-edit); a valid number is
 * committed live, and blur normalises empty/out-of-range to a clamped value (min when empty).
 * Omit `max` to allow any value above `min`.
 */
export function NumberField({ id, value, min, max, step, width, className, title, onCommit }: {
  id?: string; value: number; min?: number; max?: number; step?: number;
  width?: number; className?: string; title?: string;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]); // re-sync on external change (e.g. Reset)
  return (
    <input
      id={id} type="number" min={min} max={max} step={step} className={className} title={title}
      style={width ? { width } : undefined}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n)) onCommit(n); // commit raw; clamp on blur
      }}
      onBlur={() => {
        let n = Number(text);
        if (text === '' || !Number.isFinite(n)) n = min ?? 0;
        if (min !== undefined) n = Math.max(min, n);
        if (max !== undefined) n = Math.min(max, n);
        onCommit(n);
        setText(String(n));
      }}
    />
  );
}
